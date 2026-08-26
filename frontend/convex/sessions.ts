import { v, type Infer } from "convex/values"

import {
  internalMutation,
  internalQuery,
  mutation,
  query,
} from "./_generated/server"
import type { Doc } from "./_generated/dataModel"
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
  MAX_DELTA_PER_CALL_S,
  MAX_STARTS_PER_HOUR,
  OPEN_SESSION_PREFIX,
  OPEN_SESSION_WINDOW_MS,
  RATE_LIMIT_PREFIX,
  START_WINDOW_MS,
} from "../lib/billing"

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
 * Three refusals, all of them money:
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
 * 3. **Too many starts in an hour.** The free grant is per Clerk id and
 *    signup is instant, so without this a script mints rooms until the grants
 *    run out (audit B12). Counted off `by_user_startedAt` — the same index the
 *    guard above reads — so there is no counter to keep in sync and the read
 *    is bounded by `MAX_STARTS_PER_HOUR`, not by how many rows the learner has.
 *
 * The order of 2 and 3 is deliberate: a learner with a second tab open hears
 * "you already have one running", which is a thing they can act on, even if
 * they are also near the hourly limit. Swapping them would answer a real state
 * with a scolding.
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

    // `take(MAX_STARTS_PER_HOUR)` rather than a count: the only question is
    // whether there are at least that many, so the read stops at the answer
    // and a learner with ten thousand rows costs the same as one with twelve.
    const since = Date.now() - START_WINDOW_MS
    const recent = await ctx.db
      .query("sessions")
      .withIndex("by_user_startedAt", (q) =>
        q.eq("userId", user._id).gte("startedAt", since)
      )
      .take(MAX_STARTS_PER_HOUR)
    if (recent.length >= MAX_STARTS_PER_HOUR) {
      throw new Error(
        `${RATE_LIMIT_PREFIX} ${MAX_STARTS_PER_HOUR} sessions started in the last hour`
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
    if (delta > 0) {
      await ctx.db.insert("creditLedger", {
        userId: user._id,
        kind: "debit",
        seconds: -delta,
        ref,
        createdAt: Date.now(),
      })
    }
    const patch: {
      secondsBilled?: number
      endedAt?: number
      endReason?: Infer<typeof endReasonValidator>
    } = {}
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
 *
 * **The client's outcome always wins.** `recordSummary` can write an outcome
 * too, from the corrections the worker saw, as a backstop for a tab that never
 * reached this mutation — but it only writes one where there is none, and this
 * overwrites whatever is there. The client is the half that knows the exact
 * `secondsTalked` and whether the clock ended the session; the worker is only
 * guessing at both. Whichever order the two arrive in, the record ends up the
 * client's if the client ever spoke.
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
    if (user === null) throw new Error("No such user")

    let session: Doc<"sessions"> | null = await ctx.db
      .query("sessions")
      .withIndex("by_room", (q) => q.eq("room", args.room))
      .unique()
    if (session !== null && session.userId !== user._id) {
      throw new Error("Not this learner's room")
    }
    if (session === null) {
      const id = await ctx.db.insert("sessions", {
        userId: user._id,
        room: args.room,
        plan: ADOPTED_PLAN,
        startedAt: Date.now(),
      })
      session = await ctx.db.get(id)
      if (session === null) throw new Error("Session row vanished")
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
    const rows = await ctx.db
      .query("sessions")
      .withIndex("by_user_endedAt", (q) =>
        q.eq("userId", user._id).gte("endedAt", 0)
      )
      .order("desc")
      .take(HISTORY_LIMIT * 2)

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
      endedAt: row.endedAt ?? row.startedAt,
      secondsTalked: row.outcome?.secondsTalked ?? row.secondsBilled ?? 0,
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
 *
 * `endReason` is written — `"stale"` — but only onto a row that has none.
 * A row the cron closes used to be indistinguishable on the History card from
 * a row written before the field existed, and the two are not the same fact:
 * "nobody ever closed this and we swept it up two hours later" is an answer,
 * and "we do not know" is the absence of one. Never overwritten, on the same
 * rule the worker's reason follows: whoever was actually there when it
 * stopped said it first, and this mutation was not there.
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
      const patch: {
        endedAt: number
        endReason?: Infer<typeof endReasonValidator>
      } = { endedAt: session.startedAt + (session.secondsBilled ?? 0) * 1000 }
      // Only where nobody said why. The worker's teardown report writes the
      // reason without writing `endedAt` when the client already closed the
      // row, so a row can reach here explained and still open — and that
      // explanation is better than this one.
      if (session.endReason === undefined) patch.endReason = "stale"
      await ctx.db.patch(session._id, patch)
    }
    return stale.length
  },
})
