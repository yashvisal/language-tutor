import { v } from "convex/values"

import { internalMutation, mutation, query } from "./_generated/server"
import type { Doc } from "./_generated/dataModel"
import { secondsFor, userByClerkId } from "./users"
import { sessionOutcomeValidator, sessionPlanValidator } from "./validators"

/**
 * The `sessions` row: one per room, written when the token is minted and
 * settled by the worker's debits.
 *
 * `secondsBilled` is the row's real job. It is the CUMULATIVE seconds this room
 * has been charged for, and the debit action treats it as a high-water mark:
 * the worker reports a running total, so every report after the first debits
 * only what is new. That makes a retried report, a duplicated delivery and a
 * session that resumes after a purchase all land on the same number.
 */

/** Called by `/api/token` after auth and the balance check. */
export const start = mutation({
  args: { room: v.string(), plan: sessionPlanValidator },
  handler: async (ctx, args) => {
    const identity = await ctx.auth.getUserIdentity()
    if (identity === null) throw new Error("Not signed in")

    const user = await userByClerkId(ctx, identity.subject)
    if (user === null) throw new Error("No account yet")

    // Rooms are minted per session (`lesson-<slug>-<ts>-<nonce>`), so a second
    // row for the same room would mean a retried token request, not a second
    // conversation — and two rows would give the debit two high-water marks.
    const existing = await ctx.db
      .query("sessions")
      .withIndex("by_room", (q) => q.eq("room", args.room))
      .unique()
    if (existing !== null) return null

    await ctx.db.insert("sessions", {
      userId: user._id,
      room: args.room,
      plan: args.plan,
      startedAt: Date.now(),
    })
    return null
  },
})

/**
 * The worker's debit, behind `convex/http.ts` (which checks the shared secret
 * — there is no Clerk identity on that path, so this must stay internal).
 *
 * `seconds` is the session's cumulative active seconds. Idempotent twice over:
 * the `<room>:<seq>` ref is checked against `by_ref` first, and the amount
 * written is the delta against `secondsBilled` rather than the total, so an
 * out-of-order or replayed report can never charge the same second twice.
 */
export const debit = internalMutation({
  args: {
    room: v.string(),
    clerkId: v.string(),
    seconds: v.number(),
    seq: v.number(),
  },
  handler: async (ctx, args) => {
    const user = await userByClerkId(ctx, args.clerkId)
    if (user === null) throw new Error("No such user")

    const ref = `${args.room}:${args.seq}`
    const already = await ctx.db
      .query("creditLedger")
      .withIndex("by_ref", (q) => q.eq("ref", ref))
      .first()
    if (already !== null) {
      return { balanceSeconds: await secondsFor(ctx, user._id) }
    }

    // Normally written by `/api/token`. A missing row means the worker is
    // metering a room the app never recorded (a manual dispatch, a token route
    // that failed after minting): the seconds were still spoken, so they are
    // still billed — the row is created here so the high-water mark has a home.
    let session: Doc<"sessions"> | null = await ctx.db
      .query("sessions")
      .withIndex("by_room", (q) => q.eq("room", args.room))
      .unique()
    if (session === null) {
      const id = await ctx.db.insert("sessions", {
        userId: user._id,
        room: args.room,
        plan: { scenario: null, topic: null, tenses: [], vocab: [], level: null },
        startedAt: Date.now(),
      })
      session = await ctx.db.get(id)
    }

    const billed = session?.secondsBilled ?? 0
    const delta = Math.max(0, Math.round(args.seconds) - billed)
    if (delta > 0) {
      await ctx.db.insert("creditLedger", {
        userId: user._id,
        kind: "debit",
        seconds: -delta,
        ref,
        createdAt: Date.now(),
      })
    }
    if (session !== null && Math.round(args.seconds) > billed) {
      // `endedAt` stays null: the clock holding at zero is not the end of the
      // session, and only the surface (or the worker's teardown) knows when is.
      await ctx.db.patch(session._id, {
        secondsBilled: Math.round(args.seconds),
      })
    }

    return { balanceSeconds: await secondsFor(ctx, user._id) }
  },
})

/* -------------------------------------------------------------------------- */
/*  Finishing a session, and looking back at it                               */
/* -------------------------------------------------------------------------- */

/** Belt-and-braces caps on a client-written array. A session that earned more
 * than this many corrections is not a session, it is a bug or an attack, and
 * either way the row should stay small enough to read. */
const MAX_CORRECTIONS = 200
const MAX_CHARS = 500

function clamp(value: string): string {
  return value.length > MAX_CHARS ? value.slice(0, MAX_CHARS) : value
}

/**
 * The client's end-of-session snapshot, written to the row the token minted.
 *
 * Called from the surface rather than the worker because the corrections only
 * ever exist on the client: the analyzer streams them to the browser, and the
 * `SessionOutcome` assembled at the moment of ending is the only complete copy.
 * The worker still owns the meter (`debit` above); this writes what was said.
 *
 * Idempotent and non-destructive. `endedAt` is set only if unset, so a second
 * call — a retry, a summary re-mounted — never moves the end of the session,
 * and a room with no row (or another learner's room) is a silent no-op rather
 * than an error: nothing on the summary screen depends on this succeeding.
 */
export const finish = mutation({
  args: { room: v.string(), outcome: sessionOutcomeValidator },
  returns: v.null(),
  handler: async (ctx, args) => {
    const identity = await ctx.auth.getUserIdentity()
    if (identity === null) throw new Error("Not signed in")

    const user = await userByClerkId(ctx, identity.subject)
    if (user === null) throw new Error("No account yet")

    const session = await ctx.db
      .query("sessions")
      .withIndex("by_room", (q) => q.eq("room", args.room))
      .unique()
    // Someone else's room, or a room the app never recorded. Either way this
    // caller has nothing to write.
    if (session === null || session.userId !== user._id) return null

    const corrections = args.outcome.corrections
      .slice(0, MAX_CORRECTIONS)
      .map((correction) => ({
        id: clamp(correction.id),
        original: clamp(correction.original),
        replacement: clamp(correction.replacement),
        category: clamp(correction.category),
        severity: clamp(correction.severity),
        explanation: clamp(correction.explanation),
      }))

    await ctx.db.patch(session._id, {
      endedAt: session.endedAt ?? Date.now(),
      outcome: { ...args.outcome, corrections },
      corrections: corrections.length,
    })
    return null
  },
})

/** How many past conversations History shows. Older than this is archaeology,
 * and the list is a glance, not a ledger. */
const HISTORY_LIMIT = 30

/**
 * The learner's finished conversations, newest first — what `/home` lists
 * under History and what its modal reads.
 *
 * Only sessions with an `endedAt`: a row exists from the moment the token is
 * minted, and a conversation that is happening right now is not history. The
 * seconds are the outcome's meter reading where there is one and the billed
 * total otherwise, so a row finished before `outcome` existed still prints an
 * honest number.
 *
 * The whole corrections array travels with the list rather than behind a
 * per-session query: it is at most 200 short strings, the modal needs it the
 * instant a row is clicked, and a second round-trip to show what someone
 * already clicked on is a spinner nobody asked for.
 */
export const history = query({
  args: {},
  handler: async (ctx) => {
    const identity = await ctx.auth.getUserIdentity()
    if (identity === null) return []

    const user = await userByClerkId(ctx, identity.subject)
    if (user === null) return []

    const rows = await ctx.db
      .query("sessions")
      .withIndex("by_user_startedAt", (q) => q.eq("userId", user._id))
      .order("desc")
      .take(HISTORY_LIMIT * 2)

    return rows
      .filter((row) => row.endedAt !== undefined)
      .slice(0, HISTORY_LIMIT)
      .map((row) => ({
        id: row._id,
        startedAt: row.startedAt,
        endedAt: row.endedAt ?? row.startedAt,
        secondsTalked: row.outcome?.secondsTalked ?? row.secondsBilled ?? 0,
        plan: row.plan,
        corrections: row.outcome?.corrections ?? [],
      }))
  },
})
