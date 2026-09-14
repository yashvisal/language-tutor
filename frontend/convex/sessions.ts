import { v, type Infer } from "convex/values"

import {
  internalMutation,
  internalQuery,
  mutation,
  query,
  type MutationCtx,
  type QueryCtx,
} from "./_generated/server"
import type { Doc } from "./_generated/dataModel"
import { CodedError, ERROR_CODES } from "./errors"
import { reportError } from "./observability"
import { secondsFor, userByClerkId } from "./users"
import {
  correctionValidator,
  endReasonValidator,
  reviewMaterialValidator,
  sessionGoalValidator,
  sessionOutcomeValidator,
  sessionPlanValidator,
  SUMMARY_LIMITS,
  transcriptTurnValidator,
  translationLookupValidator,
} from "./validators"
import {
  DELTA_CAP_PREFIX,
  LEASE_TTL_MS,
  MAX_DELTA_PER_CALL_S,
  MAX_STARTS_PER_HOUR,
  START_WINDOW_MS,
} from "../lib/billing"

/**
 * The `sessions` row: one per room, opened by the worker when it joins and
 * settled by its debits.
 *
 * `secondsBilled` is the row's real job. It is the CUMULATIVE seconds this room
 * has been charged for, and the debit action treats it as a high-water mark:
 * the worker reports a running total, so every report after the first debits
 * only what is new. That makes a retried report, a duplicated delivery and a
 * session that resumes after a purchase all land on the same number. It is
 * also what a *redispatched* job reads at start (`open`) so its own reports
 * stay room-cumulative rather than restarting at zero.
 *
 * The row is three things at once, and it is worth naming them: the debit's
 * high-water mark, the one-open-session lease (`leaseUntil`), and — once
 * `endedAt` is set — the learner's history.
 *
 * **The lease is the worker's** (audit 2026-09-06, L1/L2). The token route
 * only signs a token; a token nobody uses opens nothing. The row is inserted
 * by `open` when the worker joins, renewed by `open` and every periodic
 * `debit`, and closed by the final debit or — if the worker died — by the
 * cron once the lease runs out. The browser's `finish` writes the outcome and
 * nothing else: closing a tab is a request to end, not proof that spending
 * stopped.
 */

/**
 * The plan a row adopted by a worker report gets: empty, because nobody knows
 * what the learner picked — the token route is where a plan comes from, and by
 * definition it did not get here. Shared by the two writers that can find
 * themselves without a row (`debit`, `recordSummary`) so an adopted row looks
 * the same whichever of them arrived first.
 */
const ADOPTED_PLAN = {
  scenario: null,
  topic: null,
  tenses: [],
  vocab: [],
  level: null,
}

/** Whether a row is a live conversation right now. */
function leased(session: Doc<"sessions">, now: number): boolean {
  return (
    session.endedAt === undefined &&
    session.leaseUntil !== undefined &&
    session.leaseUntil > now
  )
}

/**
 * This learner's live conversation, if they have one: an open row whose lease
 * has not run out. Read off `by_user_endedAt` with `endedAt` absent, which is
 * exactly the open rows; those are few (one, normally) so the lease is
 * checked in JS rather than on a third index.
 */
async function activeSessionFor(
  ctx: QueryCtx | MutationCtx,
  userId: Doc<"users">["_id"],
  now: number
): Promise<Doc<"sessions"> | null> {
  const open = await ctx.db
    .query("sessions")
    .withIndex("by_user_endedAt", (q) =>
      q.eq("userId", userId).eq("endedAt", undefined)
    )
    .collect()
  return open.find((row) => leased(row, now)) ?? null
}

/**
 * Whether this learner has hit the hourly start limit. The free grant is per
 * Clerk id and signup is instant, so without this a script mints rooms until
 * the grants run out (audit B12). `take(MAX_STARTS_PER_HOUR)` rather than a
 * count: the only question is whether there are at least that many, so the
 * read stops at the answer and a learner with ten thousand rows costs the
 * same as one with twelve. Counted on rows, which now means on real joins.
 */
async function rateLimited(
  ctx: QueryCtx | MutationCtx,
  userId: Doc<"users">["_id"],
  now: number
): Promise<boolean> {
  const recent = await ctx.db
    .query("sessions")
    .withIndex("by_user_startedAt", (q) =>
      q.eq("userId", userId).gte("startedAt", now - START_WINDOW_MS)
    )
    .take(MAX_STARTS_PER_HOUR)
  return recent.length >= MAX_STARTS_PER_HOUR
}

export const startRefusalValidator = v.union(
  v.literal("open_session"),
  v.literal("rate_limited")
)

/**
 * The token route's pre-check, so a learner with a second tab open hears
 * "you already have one running" before a token is minted rather than from a
 * worker that joined and left. It is a READ: the answer can be stale by the
 * time the worker opens the row, and `open` is the check that counts.
 *
 * The order is deliberate: a learner with a second tab open hears something
 * they can act on ("end it there"), even if they are also near the hourly
 * limit. Swapping them would answer a real state with a scolding.
 */
export const startCheck = query({
  args: {},
  returns: v.union(
    v.literal("ok"),
    v.literal("no_account"),
    startRefusalValidator
  ),
  handler: async (ctx) => {
    const identity = await ctx.auth.getUserIdentity()
    if (identity === null)
      throw new CodedError(ERROR_CODES.notSignedIn, "Not signed in")
    const user = await userByClerkId(ctx, identity.subject)
    if (user === null) return "no_account"
    const now = Date.now()
    if ((await activeSessionFor(ctx, user._id, now)) !== null) {
      return "open_session"
    }
    if (await rateLimited(ctx, user._id, now)) return "rate_limited"
    return "ok"
  },
})

/**
 * The worker takes — or renews — the lease on a room. Behind `POST
 * /tutor/open` in `convex/http.ts`, which has checked the M2M token; there is
 * no Clerk identity on that path, so this must stay internal.
 *
 * Called once when the job starts, before the model session exists, and then
 * every `LEASE_RENEW_S` for as long as the job runs — held or not, because a
 * learner reading a correction for ten minutes is still in a conversation.
 * One mutation, so the acquire is atomic: two workers for two tabs cannot
 * both be told yes.
 *
 * Four answers:
 * - **This room's row is open** — a renewal, or a redispatch after a crash:
 *   the lease is extended and the worker gets the room's high-water mark so
 *   its reports stay room-cumulative.
 * - **This room's row has ended** — a reused token. Refused (`closed`); the
 *   worker leaves. A room carries the debit's high-water mark, so re-joining
 *   one that was billed for N seconds would make every fresh report fall
 *   below N and debit nothing.
 * - **No row, but another room is live for this learner** — refused
 *   (`open_session`); the worker leaves. The refusal is what stands between
 *   two tabs and a ledger that goes negative.
 * - **No row, too many starts this hour** — refused (`rate_limited`).
 * - Otherwise the row is inserted with a fresh lease.
 *
 * Ownership is asserted before anything is written, on the same terms as
 * `debit`: a room this learner does not own is not a room this learner can
 * hold.
 */
export const open = internalMutation({
  args: {
    room: v.string(),
    clerkId: v.string(),
    /** The LiveKit job. Logged on both sides; not stored. */
    jobId: v.string(),
    plan: sessionPlanValidator,
  },
  returns: v.union(
    v.object({
      ok: v.literal(true),
      balanceSeconds: v.number(),
      secondsBilled: v.number(),
    }),
    v.object({
      ok: v.literal(false),
      code: v.union(startRefusalValidator, v.literal("closed")),
    })
  ),
  handler: async (ctx, args) => {
    const user = await userByClerkId(ctx, args.clerkId)
    if (user === null)
      throw new CodedError(ERROR_CODES.noAccount, "No such user")
    const now = Date.now()

    const existing = await ctx.db
      .query("sessions")
      .withIndex("by_room", (q) => q.eq("room", args.room))
      .unique()
    if (existing !== null) {
      if (existing.userId !== user._id)
        throw new CodedError(
          ERROR_CODES.notYourRoom,
          "Not this learner's room"
        )
      if (existing.endedAt !== undefined) {
        return { ok: false as const, code: "closed" as const }
      }
      await ctx.db.patch(existing._id, { leaseUntil: now + LEASE_TTL_MS })
      return {
        ok: true as const,
        balanceSeconds: await secondsFor(ctx, user._id),
        secondsBilled: existing.secondsBilled ?? 0,
      }
    }

    if ((await activeSessionFor(ctx, user._id, now)) !== null) {
      return { ok: false as const, code: "open_session" as const }
    }
    if (await rateLimited(ctx, user._id, now)) {
      return { ok: false as const, code: "rate_limited" as const }
    }

    await ctx.db.insert("sessions", {
      userId: user._id,
      room: args.room,
      plan: args.plan,
      startedAt: now,
      leaseUntil: now + LEASE_TTL_MS,
    })
    return {
      ok: true as const,
      balanceSeconds: await secondsFor(ctx, user._id),
      secondsBilled: 0,
    }
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
 * **`final` closes the row**, and nothing else does while the worker lives:
 * the browser's `finish` writes the outcome only, so the one-open-session
 * lease is released by the half that knows spending stopped. A periodic
 * report RENEWS the lease instead (`LEASE_TTL_MS` ahead), so a worker that is
 * debiting is a worker that is alive, and a debit is the renewal for free.
 *
 * `endedAt` is never overwritten: a redispatched job's teardown after the
 * cron already closed the row leaves the cron's answer standing.
 *
 * **`reason` says why.** It rides the same final report because the worker is
 * the only half that knows — the browser sees a room close and cannot tell a
 * model failure from a goodbye. It is written on its own condition (`final`,
 * and no reason on the row yet) rather than with `endedAt`, so a session the
 * client already closed still gets its explanation.
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
    /**
     * Why the conversation stopped. Only meaningful alongside `final: true` —
     * a periodic report has no end to explain, and one sent on a periodic
     * report is validated and then ignored rather than recorded, because a
     * session that is still happening has not ended for any reason yet.
     */
    reason: v.optional(endReasonValidator),
  },
  returns: v.object({
    balanceSeconds: v.number(),
    /**
     * The row this report names is closed, so nothing was billed for it.
     *
     * A refusal rather than a fault: the worker on the other end has to leave
     * politely, exactly as it does for `open`'s `closed` code. It is TERMINAL
     * — no report will ever land on this room again — and the worker must
     * treat it as such rather than retrying. See the A3 note below.
     */
    closed: v.boolean(),
  }),
  handler: async (ctx, args) => {
    const user = await userByClerkId(ctx, args.clerkId)
    if (user === null)
      throw new CodedError(ERROR_CODES.noAccount, "No such user")

    let session: Doc<"sessions"> | null = await ctx.db
      .query("sessions")
      .withIndex("by_room", (q) => q.eq("room", args.room))
      .unique()
    // Before the ref check, before the patch, before the ledger row: a room
    // this learner does not own is not a room this learner can be charged for.
    if (session !== null && session.userId !== user._id) {
      throw new CodedError(ERROR_CODES.notYourRoom, "Not this learner's room")
    }

    const ref = `${args.room}:${args.jobId}:${args.seq}`
    const already = await ctx.db
      .query("creditLedger")
      .withIndex("by_ref", (q) => q.eq("ref", ref))
      .first()
    if (already !== null) {
      return {
        balanceSeconds: await secondsFor(ctx, user._id),
        closed: session?.endedAt !== undefined,
      }
    }

    // **A closed row bills nothing** (launch checklist A3). The row is history:
    // the final debit wrote `endedAt`, or the cron did because the lease ran
    // out. A report arriving after that is a worker that lost the network for
    // longer than the lease and has now reconnected — and the learner may well
    // have started a second conversation in the meantime, which is two
    // spenders on one balance for as long as it takes the old worker's renewal
    // to come back refused. So: no ledger row, and the high-water mark does
    // not move either, because moving it would print seconds on the History
    // card that were never charged for.
    //
    // The reason still lands. It is the one fact this report carries that a
    // closed row may not have, and it is written on its own condition for
    // exactly this case (see the `endReason` note above): a row the cron swept
    // up says only "stale" until the worker that was actually there explains
    // it.
    if (session !== null && session.endedAt !== undefined) {
      if (
        args.final === true &&
        args.reason !== undefined &&
        session.endReason === undefined
      ) {
        await ctx.db.patch(session._id, { endReason: args.reason })
      }
      return {
        balanceSeconds: await secondsFor(ctx, user._id),
        closed: true,
      }
    }

    // Normally written by `open`. A missing row means the worker is metering
    // a room it never opened (a manual dispatch, an `open` that failed and
    // was not honoured): the seconds were still spoken, so they are still
    // billed — the row is created here so the high-water mark has a home.
    //
    // **Adopted WITHOUT a lease** (launch checklist A4). The lease is a
    // reservation — it is what `open` refuses a second conversation against —
    // and handing one to a room nobody ever called `open` for means a worker
    // that was told to leave, or a replayed token, can lock a learner out of
    // their own account for three minutes by reporting once. The seconds are
    // real and they are billed; the reservation is not real and is not
    // granted. An adopted row is closed by its own `final` report, and swept
    // by age like any other row nothing is renewing.
    if (session === null) {
      const id = await ctx.db.insert("sessions", {
        userId: user._id,
        room: args.room,
        plan: ADOPTED_PLAN,
        startedAt: Date.now(),
      })
      session = await ctx.db.get(id)
    }

    const billed = session?.secondsBilled ?? 0
    const reported = Math.round(args.seconds)
    const delta = Math.max(0, reported - billed)
    // The worker reports every 60 active seconds, and five consecutive
    // failures end the session, so a legitimate delta is minutes at most. A
    // larger one is a bug or a leaked credential, and it bills nothing: the
    // request is refused whole rather than clamped, so the mark does not move
    // either. (Phase 7 step 1 contracts.)
    if (delta > MAX_DELTA_PER_CALL_S) {
      throw new Error(
        `${DELTA_CAP_PREFIX} one report may add at most ${MAX_DELTA_PER_CALL_S}s (got ${delta}s)`
      )
    }
    // **The balance floor** (launch checklist C1). The zero-hold lives in the
    // worker's clock, and until now nothing here enforced it: a worker that
    // held late, or one whose report crossed a balance read, pushed the ledger
    // below zero — where `viewer` clamps `minutes` to 0 and the deficit is
    // invisible on every surface, silently eaten by the learner's next grant.
    //
    // Both halves of this matter. What was CONSUMED is still recorded: the
    // high-water mark moves to the reported total below, because the worker
    // really did spend those seconds and a mark that lagged would re-bill them
    // on the next report. What is CHARGED is clamped, so the balance lands at
    // exactly zero rather than under it. The difference is the house's, and it
    // is reported rather than absorbed quietly — this is the Sentry capture
    // point (A11).
    const balanceBefore = await secondsFor(ctx, user._id)
    const applied = Math.max(0, Math.min(delta, Math.max(0, balanceBefore)))
    if (applied < delta) {
      reportError("balance_floor", {
        userId: user._id,
        room: args.room,
        requested: delta,
        applied,
      })
    }
    if (applied > 0) {
      await ctx.db.insert("creditLedger", {
        userId: user._id,
        kind: "debit",
        seconds: -applied,
        ref,
        createdAt: Date.now(),
      })
    }
    const patch: {
      secondsBilled?: number
      endedAt?: number
      endReason?: Infer<typeof endReasonValidator>
      leaseUntil?: number
    } = {}
    if (reported > billed) patch.secondsBilled = reported
    // Only on the worker's last report. A periodic debit, or the debit at a
    // hold on zero, leaves `endedAt` unset: the clock holding at zero is not
    // the end of the session, and a session still running is not history.
    // Those renew the lease instead — a worker that debits is alive.
    if (
      args.final === true &&
      session !== null &&
      session.endedAt === undefined
    ) {
      patch.endedAt = Date.now()
    } else if (
      args.final !== true &&
      session !== null &&
      session.endedAt === undefined &&
      // RENEWS a lease; never grants one (A4). A row with no lease was
      // adopted by a report rather than opened by `open`, and a reservation
      // nobody asked for is exactly what the adoption rule refuses. Renewal
      // is free for a worker that really is alive on a room it really did
      // open; everything else keeps metering without holding the learner.
      session.leaseUntil !== undefined
    ) {
      patch.leaseUntil = Date.now() + LEASE_TTL_MS
    }
    // The reason travels on the same report but is written on its own
    // condition, because the two facts are not the same fact. `endedAt` may
    // already be set by the client's `finish` — the tab knew the session was
    // over first — and the reason would then be dropped along with it, which
    // is precisely the case History most needs explained. So: written when
    // the worker says this was the end and the row does not already carry
    // one. Never overwritten: the first `final` report is the one that was
    // actually there when it stopped, and a redispatched job's teardown is
    // guessing about a session it did not see end.
    if (
      args.final === true &&
      args.reason !== undefined &&
      session !== null &&
      session.endReason === undefined
    ) {
      patch.endReason = args.reason
    }
    if (session !== null && Object.keys(patch).length > 0) {
      await ctx.db.patch(session._id, patch)
    }

    return {
      balanceSeconds: await secondsFor(ctx, user._id),
      // True only where THIS report closed the row: a report that lands on an
      // already-closed one returned above.
      closed: patch.endedAt !== undefined,
    }
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

/** Truncate rather than reject. A stored record is history: a turn one
 * character over a bound is still a turn that was spoken, and refusing the
 * whole teardown report over it would lose the conversation to save a byte. */
function clampTo(value: string, max: number): string {
  return value.length > max ? value.slice(0, max) : value
}

function clamp(value: string): string {
  return clampTo(value, MAX_CHARS)
}

/**
 * The browser's half of the record: the corrections, the meter reading and
 * the clock flag as the summary screen saw them, written once when the
 * learner ends the conversation.
 *
 * It does NOT close the row (audit 2026-09-06, L1). `endedAt` used to be
 * written here, and `start` treated it as proof the conversation was over —
 * so a client that called this on a running room, then started another,
 * had two workers spending one balance. Closing a tab is a request to end;
 * the worker's final debit is the proof, and it closes the row within
 * seconds of the learner leaving. A row the worker never closes is the
 * cron's, once its lease runs out.
 *
 * Silent no-op for a room this learner does not own or the app never
 * recorded: nothing on the summary screen should break because a record is
 * missing.
 */
export const finish = mutation({
  args: { room: v.string(), outcome: sessionOutcomeValidator },
  returns: v.null(),
  handler: async (ctx, args) => {
    const identity = await ctx.auth.getUserIdentity()
    if (identity === null)
      throw new CodedError(ERROR_CODES.notSignedIn, "Not signed in")

    const user = await userByClerkId(ctx, identity.subject)
    if (user === null)
      throw new CodedError(ERROR_CODES.noAccount, "No account yet")

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
      outcome: { ...args.outcome, corrections },
      corrections: corrections.length,
    })
    return null
  },
})

/**
 * The worker's after-session record, behind `POST /tutor/summary` in
 * `convex/http.ts` (which checks the shared secret — there is no Clerk
 * identity on that path, so this must stay internal).
 *
 * It exists because the conversation used to die with the tab. `sessions.finish`
 * runs on the client and carries only the corrections and the meter; what the
 * conversation was *about*, what was actually said, and the Review material the
 * learner was promised were all in browser memory and nowhere else. The worker
 * has all three at teardown, and it is the half of the system that survives a
 * closed laptop.
 *
 * Three properties, and each one is a failure that would otherwise be silent:
 *
 * - **Order-independent.** The worker may send this before or after its final
 *   debit, and either may create the row (a manual dispatch, a token route
 *   that failed after minting). Whichever arrives first inserts; the other
 *   patches. Nothing here touches `secondsBilled` or `endedAt` — the meter is
 *   `debit`'s alone, and a summary is not the end of a session.
 * - **Field-wise last-write-wins.** A field absent from the body is left
 *   untouched, so a worker that has the transcript but not yet the Review can
 *   send what it has and send the rest later without erasing anything.
 * - **Ownership before anything is written.** The clerk id arrives as an
 *   argument, so "this room belongs to that learner" is the only thing between
 *   a leaked secret and writing a transcript into a stranger's history.
 *
 * Everything is clamped rather than refused, for the reason `clampTo` gives.
 */
export const recordSummary = internalMutation({
  args: {
    room: v.string(),
    clerkId: v.string(),
    /** One line: what this was about, from the transcript, not the plan. */
    about: v.optional(v.string()),
    transcript: v.optional(v.array(transcriptTurnValidator)),
    review: v.optional(reviewMaterialValidator),
    /** The analyzer's findings as the WORKER saw them — the backstop for a tab
     * that never reached `finish`. Only ever written into an outcome that does
     * not exist yet; see the note below. */
    corrections: v.optional(v.array(correctionValidator)),
    /** The confirmed goal — what the conversation was SET UP to be, against
     * `about`'s what it became. */
    goal: v.optional(sessionGoalValidator),
    /** Learner turns committed. Rounded and floored at zero here. */
    turns: v.optional(v.number()),
    /** 0..1, the share of those turns spoken mostly in the anchor language.
     * Clamped into range rather than refused, like every other bound here. */
    anchorRatio: v.optional(v.number()),
    /** The Ask thread's questions, in order. */
    asks: v.optional(v.array(v.string())),
    /** Select-to-translate lookups, in order. */
    lookups: v.optional(v.array(translationLookupValidator)),
    /** Estimated model spend for this session in USD — what it COST to run,
     * not what the learner was billed. Floored at zero and dropped if it is
     * not finite, on the same terms as `anchorRatio`. */
    estCostUsd: v.optional(v.number()),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const user = await userByClerkId(ctx, args.clerkId)
    if (user === null)
      throw new CodedError(ERROR_CODES.noAccount, "No such user")

    let session: Doc<"sessions"> | null = await ctx.db
      .query("sessions")
      .withIndex("by_room", (q) => q.eq("room", args.room))
      .unique()
    if (session !== null && session.userId !== user._id) {
      throw new CodedError(ERROR_CODES.notYourRoom, "Not this learner's room")
    }
    if (session === null) {
      const id = await ctx.db.insert("sessions", {
        userId: user._id,
        room: args.room,
        plan: ADOPTED_PLAN,
        startedAt: Date.now(),
        // NO lease, on the same terms as `debit`'s adoption (launch checklist
        // A4). A summary is the record of something that is over; giving its
        // row a live reservation meant a late report — or any room name at all
        // behind a replayed machine token — blocked the learner's next start
        // for three minutes. A row without a lease is not live, and the cron
        // closes it by age.
        //
        // Lease-less rows used to sit at the head of the reconciliation index
        // (absent sorts below every number), where enough of them would starve
        // the expired leases behind them. `reconcileStale` no longer reads
        // them in that range at all; see the note there.
      })
      session = await ctx.db.get(id)
      if (session === null)
        throw new CodedError(ERROR_CODES.rowVanished, "Session row vanished")
    }

    const patch: {
      about?: string
      transcript?: Infer<typeof transcriptTurnValidator>[]
      review?: Infer<typeof reviewMaterialValidator>
      outcome?: Infer<typeof sessionOutcomeValidator>
      corrections?: number
      goal?: Infer<typeof sessionGoalValidator>
      turns?: number
      anchorRatio?: number
      asks?: string[]
      lookups?: Infer<typeof translationLookupValidator>[]
      estCostUsd?: number
    } = {}

    if (args.about !== undefined) {
      patch.about = clampTo(args.about, SUMMARY_LIMITS.aboutChars)
    }
    if (args.transcript !== undefined) {
      patch.transcript = args.transcript
        .slice(0, SUMMARY_LIMITS.transcriptTurns)
        .map((turn) => ({
          role: turn.role,
          text: clampTo(turn.text, SUMMARY_LIMITS.turnChars),
        }))
    }
    if (args.review !== undefined) {
      const item = (entry: { target: string; anchor: string }) => ({
        target: clampTo(entry.target, SUMMARY_LIMITS.reviewItemChars),
        anchor: clampTo(entry.anchor, SUMMARY_LIMITS.reviewItemChars),
      })
      patch.review = {
        vocab: args.review.vocab.slice(0, SUMMARY_LIMITS.reviewVocab).map(item),
        phrases: args.review.phrases
          .slice(0, SUMMARY_LIMITS.reviewPhrases)
          .map(item),
        tables: args.review.tables
          .slice(0, SUMMARY_LIMITS.reviewTables)
          .map((table) => ({
            verb: clampTo(table.verb, SUMMARY_LIMITS.reviewItemChars),
            tense: clampTo(table.tense, SUMMARY_LIMITS.reviewItemChars),
            rows: table.rows.slice(0, SUMMARY_LIMITS.tableRows).map((row) => ({
              person: clampTo(row.person, SUMMARY_LIMITS.reviewItemChars),
              form: clampTo(row.form, SUMMARY_LIMITS.reviewItemChars),
            })),
          })),
      }
    }

    // Step 3's fields, on exactly the same terms as the three above: each one
    // independent, absent means "leave the column alone", present replaces
    // wholesale, and everything is clamped rather than refused.
    if (args.goal !== undefined) {
      patch.goal = {
        text: clampTo(args.goal.text, SUMMARY_LIMITS.goalChars),
        forms: args.goal.forms
          .slice(0, SUMMARY_LIMITS.goalForms)
          .map((form) => clampTo(form, SUMMARY_LIMITS.goalFormChars)),
        source: args.goal.source,
      }
    }
    // A count, so it is an integer and it is not negative. Both are wire
    // checks too; this is the half that has to hold if the bound on the other
    // side is ever loosened, because a negative turn count would render.
    if (args.turns !== undefined) {
      patch.turns = Math.max(0, Math.round(args.turns))
    }
    // A ratio, so it is in [0, 1]. NaN would pass the schema's `v.number()`
    // and then print as "NaN% anchor", so it lands as 0 — "we measured
    // nothing" — rather than propagating.
    if (args.anchorRatio !== undefined) {
      patch.anchorRatio = Number.isFinite(args.anchorRatio)
        ? Math.min(1, Math.max(0, args.anchorRatio))
        : 0
    }
    if (args.asks !== undefined) {
      patch.asks = args.asks
        .slice(0, SUMMARY_LIMITS.asks)
        .map((question) => clampTo(question, SUMMARY_LIMITS.askChars))
    }
    if (args.lookups !== undefined) {
      patch.lookups = args.lookups
        .slice(0, SUMMARY_LIMITS.lookups)
        .map((lookup) => ({
          source: clampTo(lookup.source, SUMMARY_LIMITS.lookupChars),
          translation: clampTo(lookup.translation, SUMMARY_LIMITS.lookupChars),
        }))
    }
    // Money, so it is a real non-negative number or it is not written at all.
    // Unlike every other field here it is NOT clamped to a maximum: a cost
    // that is somehow enormous is a fact worth seeing, and the wire already
    // refuses anything absurd. A non-finite one is dropped rather than stored
    // as 0, because a wrong cost is worse than a missing one — the column
    // exists to be summed.
    if (args.estCostUsd !== undefined && Number.isFinite(args.estCostUsd)) {
      patch.estCostUsd = Math.max(0, args.estCostUsd)
    }

    // The backstop, and the one place this mutation touches the client's
    // territory. `finish` runs in the browser at the end of a conversation and
    // is the only writer of `outcome` — a closed laptop, a crashed tab or a
    // killed process never reaches it, and the corrections are then lost even
    // though the worker had them all along.
    //
    // So: an outcome is written here ONLY when there is none. If `finish` has
    // already run, its record stands untouched, because it is the half that
    // knows the real `secondsTalked` and whether the clock ended the session —
    // both of which are guesses from out here. `secondsTalked` falls back to
    // what the meter can prove (and to `null`, honestly, when this arrives
    // before the final debit and the meter has proved nothing yet), and
    // `endedByClock` to `false`, which is what "we do not know" looks like on
    // a boolean the summary only uses to change one line of copy.
    if (args.corrections !== undefined && session.outcome === undefined) {
      const corrections = args.corrections
        .slice(0, MAX_CORRECTIONS)
        .map((correction) => ({
          id: clamp(correction.id),
          original: clamp(correction.original),
          replacement: clamp(correction.replacement),
          category: clamp(correction.category),
          severity: clamp(correction.severity),
          explanation: clamp(correction.explanation),
        }))
      patch.outcome = {
        corrections,
        secondsTalked: session.secondsBilled ?? null,
        endedByClock: false,
      }
      // Denormalized off the outcome, exactly as `finish` writes it, so the
      // History list keeps counting without reading the corrections.
      patch.corrections = corrections.length
    }

    if (Object.keys(patch).length > 0) await ctx.db.patch(session._id, patch)
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
 * A row is history once EITHER half has called it finished: the worker's
 * final debit (`endedAt`), or the browser's `finish` (`outcome`). The browser
 * cannot close the row — that is the lease's business — but it does know the
 * learner pressed End, and the worker's close trails it by its reconnect
 * grace plus teardown (26 s live, 2026-09-08). A conversation the learner
 * just ended must not be missing from the page they land on; it is listed
 * from what the browser wrote and fills in when the worker's record lands.
 * A row with neither is a conversation happening right now, and not history.
 *
 * The seconds are the worker's billed total where there is one and the
 * outcome's meter reading otherwise, so a row the worker has not closed yet
 * still prints an honest number.
 *
 * The whole corrections array travels with the list rather than behind a
 * per-session query: it is at most 200 short strings, the modal needs it the
 * instant a row is clicked, and a second round-trip to show what someone
 * already clicked on is a spinner nobody asked for.
 */
export const history = query({
  args: {},
  returns: v.array(
    v.object({
      id: v.id("sessions"),
      /** The key `byRoom` takes — how the History modal reaches the same
       * record the post-session summary rendered. */
      room: v.string(),
      startedAt: v.number(),
      endedAt: v.number(),
      secondsTalked: v.number(),
      plan: sessionPlanValidator,
      corrections: v.array(correctionValidator),
      /** The one-line "what this was about", `null` for a row that ended
       * before the worker wrote one. The list prints it where it has one and
       * falls back to the plan's topic where it does not. */
      about: v.union(v.string(), v.null()),
      /** The confirmed goal's TEXT only — what the conversation was set up to
       * be. The list wants one line, not the object; the modal reads
       * `byRoom` for the forms and the source. `null` where no goal was ever
       * confirmed, which is every row written before step 3. */
      goal: v.union(v.string(), v.null()),
      /** Why it stopped, `null` where nobody said — which is what a row from
       * before this field, or a session the reconciliation cron closed, looks
       * like. Absent must never be read as a clean end. */
      endReason: v.union(endReasonValidator, v.null()),
    })
  ),
  handler: async (ctx) => {
    const identity = await ctx.auth.getUserIdentity()
    if (identity === null) return []

    const user = await userByClerkId(ctx, identity.subject)
    if (user === null) return []

    // `gte("endedAt", 0)` is how "finished" is said on an index: `endedAt` is
    // a millisecond timestamp when it exists and absent otherwise, and absent
    // sorts below every number. So this range holds exactly the finished rows,
    // ordered by their end. The previous shape took `HISTORY_LIMIT * 2` off
    // `by_user_startedAt` and dropped the unfinished ones in JS, which meant a
    // learner with a run of abandoned rows — a crashed tab, a killed worker —
    // watched real conversations fall off their own history page.
    const finished = await ctx.db
      .query("sessions")
      .withIndex("by_user_endedAt", (q) =>
        q.eq("userId", user._id).gte("endedAt", 0)
      )
      .order("desc")
      .take(HISTORY_LIMIT * 2)
    // The rows the learner has ended and the worker has not yet closed. Open
    // rows are few (one, normally), so the whole set is read and the ones
    // with an outcome kept; they are the newest conversations by definition
    // and go first.
    const ending = (
      await ctx.db
        .query("sessions")
        .withIndex("by_user_endedAt", (q) =>
          q.eq("userId", user._id).eq("endedAt", undefined)
        )
        .collect()
    )
      .filter((row) => row.outcome !== undefined)
      .sort((a, b) => b.startedAt - a.startedAt)
    const rows = [...ending, ...finished]

    // A start that failed — the tutor never joined, the client closed the row
    // so "Try again" would not meet the one-open-session guard — is a finished
    // row with nothing in it. It is not a conversation and it is not history.
    // The over-fetch above is for these: they are rare, and a page short by a
    // few rows is better than one padded with 0:00 entries.
    const conversations = rows.filter(
      (row) =>
        (row.secondsBilled ?? 0) > 0 ||
        (row.outcome?.secondsTalked ?? 0) > 0 ||
        (row.outcome?.corrections.length ?? 0) > 0
    )

    return conversations.slice(0, HISTORY_LIMIT).map((row) => ({
      id: row._id,
      room: row.room,
      startedAt: row.startedAt,
      // For a row the worker has not closed yet, the learner's end is the
      // nearest honest timestamp: `finish` does not record one, and
      // `startedAt` plus the outcome's seconds is what the clock can prove.
      endedAt:
        row.endedAt ??
        row.startedAt + (row.outcome?.secondsTalked ?? 0) * 1000,
      // The worker's number first: it is what was charged, and the browser
      // cannot write it (audit 2026-09-06, L9). The outcome's reading is the
      // fallback for a row from before the meter reported to the ledger.
      secondsTalked: row.secondsBilled ?? row.outcome?.secondsTalked ?? 0,
      plan: row.plan,
      corrections: row.outcome?.corrections ?? [],
      about: row.about ?? null,
      goal: row.goal?.text ?? null,
      endReason: row.endReason ?? null,
    }))
  },
})

/**
 * One conversation's whole record, by room — the read behind BOTH the
 * post-session summary and the History modal, so the two cannot disagree about
 * what happened.
 *
 * That is the point of it. The summary used to render client memory and the
 * modal used to render the row, which is why the summary showed a Review the
 * modal did not have and the tab closing lost both. One query, one record.
 *
 * `null` covers three cases on purpose and distinguishes none of them: signed
 * out, no such room, and somebody else's room. A room name is guessable enough
 * that "this room exists but is not yours" is a fact worth not confirming, and
 * the surface's behaviour is the same either way — it falls back to what it
 * has in memory. Not-owned returns `null` rather than throwing for the same
 * reason `finish` is a silent no-op: nothing on the summary screen should
 * break because a record is missing.
 *
 * Reactive, so a summary open while the worker's teardown report lands fills
 * itself in rather than showing the learner an emptier record than they had.
 */
export const byRoom = query({
  args: { room: v.string() },
  returns: v.union(
    v.null(),
    v.object({
      about: v.union(v.string(), v.null()),
      transcript: v.union(v.array(transcriptTurnValidator), v.null()),
      review: v.union(reviewMaterialValidator, v.null()),
      outcome: v.union(sessionOutcomeValidator, v.null()),
      secondsBilled: v.number(),
      startedAt: v.number(),
      endedAt: v.union(v.number(), v.null()),
      plan: sessionPlanValidator,
      /** The whole goal object here, unlike `history`, which carries only the
       * line: this is the read behind both the summary and the History modal,
       * and both of them want the forms and how the goal was captured. */
      goal: v.union(sessionGoalValidator, v.null()),
      endReason: v.union(endReasonValidator, v.null()),
      turns: v.union(v.number(), v.null()),
      anchorRatio: v.union(v.number(), v.null()),
      asks: v.union(v.array(v.string()), v.null()),
      lookups: v.union(v.array(translationLookupValidator), v.null()),
      /** What the session cost to RUN, in USD, or `null` where the worker
       * never reported one. It travels with the record because this query is
       * the one read of a whole session — but no surface renders it; it is
       * here for whoever is asking whether the unit economics work. */
      estCostUsd: v.union(v.number(), v.null()),
    })
  ),
  handler: async (ctx, args) => {
    const identity = await ctx.auth.getUserIdentity()
    if (identity === null) return null

    const user = await userByClerkId(ctx, identity.subject)
    if (user === null) return null

    const session = await ctx.db
      .query("sessions")
      .withIndex("by_room", (q) => q.eq("room", args.room))
      .unique()
    if (session === null || session.userId !== user._id) return null

    // Every optional column comes back as an explicit `null` rather than
    // absent: "not written" is a state the surfaces must render (a session
    // that ended before the worker had a Review), and a field that is
    // sometimes missing is a field every caller has to guard twice.
    return {
      about: session.about ?? null,
      transcript: session.transcript ?? null,
      review: session.review ?? null,
      outcome: session.outcome ?? null,
      secondsBilled: session.secondsBilled ?? 0,
      startedAt: session.startedAt,
      endedAt: session.endedAt ?? null,
      plan: session.plan,
      goal: session.goal ?? null,
      endReason: session.endReason ?? null,
      // `null`, not `0`: "the worker never measured this" and "the learner
      // took no turns" are different facts, and only one of them is worth
      // printing. Zero would make every pre-step-3 session look silent.
      turns: session.turns ?? null,
      anchorRatio: session.anchorRatio ?? null,
      asks: session.asks ?? null,
      lookups: session.lookups ?? null,
      estCostUsd: session.estCostUsd ?? null,
    }
  },
})

/* -------------------------------------------------------------------------- */
/*  The books                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * What the sessions cost to run against what they billed, per UTC day —
 * the reconciliation the launch audit asks for (L8) before pack prices are
 * final. Operator-run: `npx convex run sessions:costReport '{"days": 30}'`.
 *
 * `estCostUsd` is the worker's estimate of MODEL spend for a session
 * (`usage.py`); LiveKit, hosting and card fees are not in it. A session with
 * no estimate (a worker that died before its summary) counts toward
 * `sessions` and `billedSeconds` but adds nothing to the cost, and says so in
 * `unpriced`, so a day's number is never quietly low.
 */
export const costReport = internalQuery({
  args: { days: v.optional(v.number()) },
  returns: v.array(
    v.object({
      day: v.string(),
      sessions: v.number(),
      unpriced: v.number(),
      billedSeconds: v.number(),
      estCostUsd: v.number(),
      /** Cost per billed minute, or `null` for a day with nothing billed. */
      usdPerBilledMinute: v.union(v.number(), v.null()),
    })
  ),
  handler: async (ctx, args) => {
    const days = Math.max(1, Math.floor(args.days ?? 30))
    const since = Date.now() - days * 24 * 60 * 60 * 1000
    const rows = await ctx.db
      .query("sessions")
      .withIndex("by_endedAt_startedAt", (q) => q.gte("endedAt", since))
      .collect()
    const byDay = new Map<
      string,
      { sessions: number; unpriced: number; billedSeconds: number; estCostUsd: number }
    >()
    for (const row of rows) {
      const day = new Date(row.endedAt!).toISOString().slice(0, 10)
      const bucket = byDay.get(day) ?? {
        sessions: 0,
        unpriced: 0,
        billedSeconds: 0,
        estCostUsd: 0,
      }
      bucket.sessions += 1
      bucket.billedSeconds += row.secondsBilled ?? 0
      if (row.estCostUsd === undefined) bucket.unpriced += 1
      else bucket.estCostUsd += row.estCostUsd
      byDay.set(day, bucket)
    }
    return [...byDay.entries()]
      .sort(([a], [b]) => (a < b ? 1 : -1))
      .map(([day, bucket]) => ({
        day,
        ...bucket,
        estCostUsd: Math.round(bucket.estCostUsd * 10000) / 10000,
        usdPerBilledMinute:
          bucket.billedSeconds > 0
            ? Math.round((bucket.estCostUsd / (bucket.billedSeconds / 60)) * 10000) /
              10000
            : null,
      }))
  },
})

/* -------------------------------------------------------------------------- */
/*  Reconciliation                                                            */
/* -------------------------------------------------------------------------- */

/**
 * Rows from before the lease existed carry no `leaseUntil`. They are not
 * live (nothing renews them), but they are not history either until closed,
 * so the cron still sweeps them by age: comfortably longer than any real
 * conversation on the old contract.
 */
const LEGACY_STALE_MS = 2 * 60 * 60 * 1000

/** Rows closed per run. The read is empty almost every time; a burst of a
 * hundred abandoned rows is a worker outage, and the next run gets the rest. */
const RECONCILE_BATCH = 100

/**
 * Close open rows whose worker is gone. Every five minutes (`crons.ts`).
 *
 * A row's lease is renewed by its worker for as long as the worker runs, so an
 * open row with an expired lease is a worker that died — or a debit ceiling
 * that stopped it reporting. The learner has not been blocked since the lease
 * ran out (`open` checks the lease, not the row); this is about History,
 * which filters on `endedAt`, and about a row not staying half-written
 * forever.
 *
 * `endedAt` is the last second the ledger can prove — `startedAt` plus what
 * was billed — not the moment the cron noticed: that would invent minutes
 * nobody talked. The reason is `stale` only where nobody said otherwise: the
 * worker's teardown report writes the reason without writing `endedAt` when
 * the row is already closed, so a row can reach here explained and still
 * open — and that explanation is better than this one.
 */
export const reconcileStale = internalMutation({
  args: {},
  returns: v.number(),
  handler: async (ctx) => {
    const now = Date.now()
    const expired = await ctx.db
      .query("sessions")
      .withIndex("by_endedAt_leaseUntil", (q) =>
        q.eq("endedAt", undefined).lt("leaseUntil", now)
      )
      .take(RECONCILE_BATCH)
    // `lt(leaseUntil, now)` on an optional field also matches rows with no
    // lease at all (absent sorts below every number). Those are the legacy
    // rows, and they close by age, not on sight.
    const stale = expired.filter(
      (session) =>
        session.leaseUntil !== undefined ||
        now - session.startedAt > LEGACY_STALE_MS
    )

    for (const session of stale) {
      const patch: {
        endedAt: number
        endReason?: Infer<typeof endReasonValidator>
      } = { endedAt: session.startedAt + (session.secondsBilled ?? 0) * 1000 }
      if (session.endReason === undefined) patch.endReason = "stale"
      await ctx.db.patch(session._id, patch)
      // A row closed with seconds on it is a conversation whose worker never
      // came back to say so — billed, and explained by nobody. Worth seeing
      // (launch checklist A11); a swept row with nothing billed is just a
      // start that failed, and there is nothing to report about it.
      if ((session.secondsBilled ?? 0) > 0) {
        reportError("reconcile_billed_row", {
          sessionId: session._id,
          room: session.room,
          userId: session.userId,
          secondsBilled: session.secondsBilled,
          leaseUntil: session.leaseUntil ?? null,
        })
      }
    }
    return stale.length
  },
})
