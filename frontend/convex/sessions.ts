import { v } from "convex/values"

import {
  internalMutation,
  internalQuery,
  mutation,
  query,
} from "./_generated/server"
import type { Doc } from "./_generated/dataModel"
import { secondsFor, userByClerkId } from "./users"
import { sessionOutcomeValidator, sessionPlanValidator } from "./validators"
import { OPEN_SESSION_PREFIX, OPEN_SESSION_WINDOW_MS } from "../lib/billing"

/**
 * The `sessions` row: one per room, written when the token is minted and
 * settled by the worker's debits.
 *
 * `secondsBilled` is the row's real job. It is the CUMULATIVE seconds this room
 * has been charged for, and the debit action treats it as a high-water mark:
 * the worker reports a running total, so every report after the first debits
 * only what is new. That makes a retried report, a duplicated delivery and a
 * session that resumes after a purchase all land on the same number. It is
 * also what a *redispatched* job reads at start (`billedSecondsForRoom`) so
 * its own reports stay room-cumulative rather than restarting at zero.
 *
 * The row is three things at once, and it is worth naming them: the debit's
 * high-water mark, the one-open-session reservation (`start`), and — once
 * `endedAt` is set — the learner's history.
 */

/**
 * Called by `/api/token` after auth, the balance check, and the mint.
 *
 * Two refusals, both of them money:
 *
 * 1. **Someone else's room.** A row is keyed on the room, and the room owns
 *    the debit's high-water mark. Returning `null` for an existing row without
 *    checking who owns it made a replayed room name a free conversation: the
 *    second worker's clock starts at zero, every report lands under the first
 *    session's mark, and every delta is zero. The route no longer accepts a
 *    room name at all; this is the second lock on the same door.
 * 2. **A conversation already open.** Nothing reserves the balance at mint
 *    time — the route reads it and signs it into dispatch metadata — so two
 *    tabs each budget the whole balance and the ledger goes negative. The
 *    newest row with no `endedAt`, younger than `OPEN_SESSION_WINDOW_MS`, is
 *    that reservation. Thrown with `OPEN_SESSION_PREFIX` so the route can
 *    answer 409 (a state the learner can act on) rather than 500 (a fault).
 */
export const start = mutation({
  args: { room: v.string(), plan: sessionPlanValidator },
  returns: v.null(),
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
    if (existing !== null) {
      if (existing.userId !== user._id) throw new Error("Not your session")
      return null
    }

    const newest = await ctx.db
      .query("sessions")
      .withIndex("by_user_startedAt", (q) => q.eq("userId", user._id))
      .order("desc")
      .first()
    if (
      newest !== null &&
      newest.endedAt === undefined &&
      Date.now() - newest.startedAt < OPEN_SESSION_WINDOW_MS
    ) {
      throw new Error(
        `${OPEN_SESSION_PREFIX} this learner already has a conversation open`
      )
    }

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
 * `seconds` is the ROOM's cumulative billed seconds, not the job's: the worker
 * reads `secondsBilled` at job start and reports `billedBefore + active`. That
 * is what makes a redispatch after a crash resume the meter instead of
 * restarting it under the high-water mark.
 *
 * Idempotent twice over, and the two mechanisms guard different failures:
 * - the `<room>:<jobId>:<seq>` ref, checked against `by_ref`, catches a
 *   *retried* report. The job id is in it because `seq` restarts at 1 for
 *   every job, so a second job for the same room used to replay `room:1`,
 *   `room:2`, … and every debit was silently dropped as a duplicate.
 * - the delta against `secondsBilled` catches an out-of-order or stale report:
 *   the amount written is what is new, never the total.
 *
 * Ownership is asserted before anything is written. The clerk id arrives as an
 * argument (the worker acts *for* a learner), so "this room belongs to that
 * learner" is the only thing standing between a leaked secret and charging one
 * account for another's room.
 *
 * **`final` closes the row.** `endedAt` is normally written by `sessions.finish`
 * on the client, which is only reached when the learner ends the conversation
 * themselves — a killed worker or a closed tab leaves the row open, and an open
 * row is the one-open-session reservation. That would lock the learner out of
 * their own account for the whole fifteen-minute window over a crash that was
 * not their fault, and the reconciliation cron does not sweep for two hours.
 * So the worker's teardown report says so, and this closes the row.
 *
 * It never *overwrites* an `endedAt`: the client's `finish` is still the one
 * that writes the outcome, and whichever of the two arrives first is the more
 * accurate end. This only ever fills in an end that nobody else was going to.
 */
export const debit = internalMutation({
  args: {
    room: v.string(),
    clerkId: v.string(),
    seconds: v.number(),
    /** The LiveKit job. Non-empty; bounded and validated in `http.ts`. */
    jobId: v.string(),
    seq: v.number(),
    /**
     * The worker's last word on this room: set on the teardown report, absent
     * on every periodic one. See the `endedAt` note in the doc block above.
     */
    final: v.optional(v.boolean()),
  },
  returns: v.object({ balanceSeconds: v.number() }),
  handler: async (ctx, args) => {
    const user = await userByClerkId(ctx, args.clerkId)
    if (user === null) throw new Error("No such user")

    let session: Doc<"sessions"> | null = await ctx.db
      .query("sessions")
      .withIndex("by_room", (q) => q.eq("room", args.room))
      .unique()
    // Before the ref check, before the patch, before the ledger row: a room
    // this learner does not own is not a room this learner can be charged for.
    if (session !== null && session.userId !== user._id) {
      throw new Error("Not this learner's room")
    }

    const ref = `${args.room}:${args.jobId}:${args.seq}`
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
    if (session === null) {
      const id = await ctx.db.insert("sessions", {
        userId: user._id,
        room: args.room,
        plan: {
          scenario: null,
          topic: null,
          tenses: [],
          vocab: [],
          level: null,
        },
        startedAt: Date.now(),
      })
      session = await ctx.db.get(id)
    }

    const billed = session?.secondsBilled ?? 0
    const reported = Math.round(args.seconds)
    const delta = Math.max(0, reported - billed)
    if (delta > 0) {
      await ctx.db.insert("creditLedger", {
        userId: user._id,
        kind: "debit",
        seconds: -delta,
        ref,
        createdAt: Date.now(),
      })
    }
    const patch: { secondsBilled?: number; endedAt?: number } = {}
    if (reported > billed) patch.secondsBilled = reported
    // Only on the worker's last report. A periodic debit, or the debit at a
    // hold on zero, leaves `endedAt` unset: the clock holding at zero is not
    // the end of the session, and a session still running is not history.
    if (
      args.final === true &&
      session !== null &&
      session.endedAt === undefined
    ) {
      patch.endedAt = Date.now()
    }
    if (session !== null && Object.keys(patch).length > 0) {
      await ctx.db.patch(session._id, patch)
    }

    return { balanceSeconds: await secondsFor(ctx, user._id) }
  },
})

/**
 * How many seconds this room has already been billed for — what a starting job
 * adds to its own active clock so its reports stay room-cumulative.
 *
 * Zero for a room with no row: a job whose token route never recorded the
 * session has nothing to resume from, and `debit` will create the row.
 *
 * Internal, and by room rather than by learner: `convex/http.ts` has already
 * checked the shared secret and there is no identity on that path.
 */
export const billedSecondsForRoom = internalQuery({
  args: { room: v.string() },
  returns: v.number(),
  handler: async (ctx, args) => {
    const session = await ctx.db
      .query("sessions")
      .withIndex("by_room", (q) => q.eq("room", args.room))
      .unique()
    return session?.secondsBilled ?? 0
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

/* -------------------------------------------------------------------------- */
/*  Reconciliation                                                            */
/* -------------------------------------------------------------------------- */

/** How long a row may stay open before the cron decides nobody is coming back
 * for it. Comfortably longer than any real conversation and longer again than
 * the worker's idle timeout, so this only ever closes rows that are genuinely
 * abandoned. */
const STALE_SESSION_MS = 2 * 60 * 60 * 1000

/** One run's ceiling. A cron that could touch the whole table in a single
 * transaction is a cron that eventually fails to run at all; the backlog is
 * drained an hour at a time. */
const RECONCILE_BATCH = 100

/**
 * Closes `sessions` rows nobody ever finished — hourly, from `convex/crons.ts`.
 *
 * `endedAt` is written by `sessions.finish`, which runs on the client at the
 * end of a conversation. A killed worker, a closed laptop, a crashed tab: the
 * row stays open forever, the conversation never appears in History (which
 * filters on `endedAt`), and — worse — the one-open-session guard would lock
 * the learner out of their own account for as long as the window allows.
 *
 * The end it writes is the honest one available: `startedAt + secondsBilled`,
 * i.e. the last moment the ledger has evidence for. Not `Date.now()`, which
 * would invent hours the learner never talked, and not a guess. A row that was
 * never billed at all ends where it started — a zero-length session, which is
 * exactly what it was.
 *
 * `outcome` is left absent: nobody knows what was said, and History prints
 * `secondsBilled` when there is no outcome, so the row reads honestly.
 */
export const reconcileStale = internalMutation({
  args: {},
  returns: v.number(),
  handler: async (ctx) => {
    const cutoff = Date.now() - STALE_SESSION_MS
    const stale = await ctx.db
      .query("sessions")
      .withIndex("by_endedAt_startedAt", (q) =>
        q.eq("endedAt", undefined).lt("startedAt", cutoff)
      )
      .take(RECONCILE_BATCH)

    for (const session of stale) {
      await ctx.db.patch(session._id, {
        endedAt: session.startedAt + (session.secondsBilled ?? 0) * 1000,
      })
    }
    return stale.length
  },
})
