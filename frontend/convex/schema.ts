import { defineSchema, defineTable } from "convex/server"
import { v } from "convex/values"

import {
  endReasonValidator,
  levelValidator,
  reviewMaterialValidator,
  sessionGoalValidator,
  sessionOutcomeValidator,
  sessionPlanValidator,
  transcriptTurnValidator,
  translationLookupValidator,
} from "./validators"

/**
 * The product shell's four tables. Only `users` and `creditLedger` are written
 * at this step; `sessions` and `purchases` are declared now so the shape is
 * settled in one place and the later steps (minutes, packs) only add writers.
 *
 * The one structural rule: **balance is `sum(creditLedger.seconds)`**, never a
 * mutable field on `users`. An append-only ledger makes every grant and debit
 * auditable, and `ref` is the idempotency key — a replayed Stripe webhook or a
 * retried worker debit finds its own row and does nothing.
 */
export default defineSchema({
  users: defineTable({
    clerkId: v.string(),
    /**
     * Absent rather than `""` when Clerk has no email on the identity (a
     * phone-only or OAuth-without-email account): an empty string is a value
     * the UI would have to special-case, and "we don't have one" is not one.
     */
    email: v.optional(v.string()),
    /**
     * Self-declared, from `LEVELS` in `lib/session/plan.ts` — the validator is
     * built from that same catalog. Optional because "a row with no level" is
     * exactly the state `/welcome` exists to fill.
     */
    level: v.optional(levelValidator),
    targetLang: v.string(),
    anchorLang: v.string(),
    createdAt: v.number(),
    // Clerk owns identity; this row is looked up by its subject claim on every
    // authenticated query, so the index is not optional.
  }).index("by_clerk_id", ["clerkId"]),

  creditLedger: defineTable({
    userId: v.id("users"),
    kind: v.union(
      v.literal("signup_grant"),
      v.literal("purchase"),
      v.literal("debit"),
      v.literal("adjustment")
    ),
    /**
     * Signed SECONDS: grants are positive, debits negative. Seconds, not
     * minutes, because the meter bills the seconds actually spoken — see
     * `lib/billing.ts`.
     */
    seconds: v.number(),
    /**
     * Unique per entry by convention, enforced by every writer checking this
     * index first: `signup:<clerkId>`, a Stripe session id, or
     * `<room>:<jobId>:<seq>` for a worker debit. The job id is in the debit
     * ref because `seq` restarts at 1 for every LiveKit job, so a redispatch
     * into the same room would otherwise replay refs it had already written
     * and every debit would be dropped as a duplicate.
     */
    ref: v.string(),
    createdAt: v.number(),
  })
    .index("by_ref", ["ref"])
    .index("by_user", ["userId"]),

  sessions: defineTable({
    userId: v.id("users"),
    room: v.string(),
    /** The bounded `SessionPlan` the learner started with. */
    plan: sessionPlanValidator,
    startedAt: v.number(),
    // Absent until the worker reports the session finished.
    endedAt: v.optional(v.number()),
    /** Cumulative seconds this room has been billed for; the debit action's
     * high-water mark, so a re-reported total debits only the delta. */
    secondsBilled: v.optional(v.number()),
    /**
     * How many corrections the analyzer produced, denormalized off `outcome`
     * so a list of sessions never has to read the corrections to count them.
     * Rows finished before `outcome` existed still carry only this.
     */
    corrections: v.optional(v.number()),
    /**
     * The finished session, as the summary screen saw it — written once by
     * `sessions.finish` when the client's `SessionOutcome` is produced. Absent
     * on a session in progress, and on any session that ended before this
     * field existed (history is never backfilled with guesses).
     */
    outcome: v.optional(sessionOutcomeValidator),
    /**
     * The after-session record, written by the worker at teardown through
     * `POST /tutor/summary`. All three are optional and independently written:
     * the worker sends what it has, a field absent from the body is left
     * untouched, and a session that ended before this existed carries none of
     * them — history is never backfilled with guesses.
     *
     * They exist because the conversation used to die with the tab. The
     * summary screen and the History modal render THE SAME record, and
     * `out-of-minutes.tsx` promises the transcript and the review are saved;
     * these three fields are that promise.
     */

    /** One line, <= 200 chars: what this conversation was actually about,
     * read off the transcript rather than the plan the learner started with —
     * the plan is an intention, and this is what happened. */
    about: v.optional(v.string()),
    /** What was said, clamped on write to 200 turns x 500 chars. Not the live
     * `Turn` shape: segments, anchor text and in-flight flags are a reducer's
     * business, and a record only needs who said what. */
    transcript: v.optional(v.array(transcriptTurnValidator)),
    /** The Review snapshot — vocab, phrases and the deterministic tables, as
     * the Review tab saw them. Made once per session and never regenerated,
     * so if it is not stored it is gone. */
    review: v.optional(reviewMaterialValidator),

    /**
     * Step 3's half of the same record: what was SET UP, how much was
     * actually done, and why it stopped. Written by the worker on the same
     * two calls (`/tutor/summary` for all but the last, `/tutor/debit` for
     * `endReason`), all optional, all independently written, none of them
     * backfilled onto older rows.
     *
     * Together with `about` they let History say the sentence it could not
     * say before: "you set up X, talked for N turns, and it ended because Y."
     */

    /** The confirmed goal — the session's spine. `text` is one line (<= 200
     * chars), `forms` the grammatical forms it implies (<= 8 x 60), `source`
     * how it was captured (plan / tool / extracted), which is also how much
     * to trust it: an extracted goal was never said back to the learner. */
    goal: v.optional(sessionGoalValidator),
    /**
     * Why the conversation stopped, from the worker's teardown debit — the
     * one half that knows. Absent on a row that is still open, and on every
     * row written before this field existed, so absent means "we do not
     * know", never "it ended cleanly". Written once and never overwritten:
     * the first `final` report is the one that was actually there.
     */
    endReason: v.optional(endReasonValidator),
    /** Learner turns committed by the worker's turn detector — the honest
     * measure of how much the learner actually spoke, which seconds are not
     * (a held session bills nothing and a silent one bills the same as a
     * talkative one). */
    turns: v.optional(v.number()),
    /**
     * 0..1: the share of those turns spoken mostly in the ANCHOR language.
     * High is the learner falling back to English, which is the exact input
     * support-on-evidence needs — and a number the tutor was measuring live
     * and discarding.
     */
    anchorRatio: v.optional(v.number()),
    /** The questions asked in the Ask tab, in order (<= 25 x 400 chars).
     * Answers are not stored: the question is what the learner did not know,
     * and that is the study record. */
    asks: v.optional(v.array(v.string())),
    /** Every select-to-translate lookup (<= 100, strings <= 200) — the span
     * highlighted and what it came back as. It lived in an overlay that
     * unmounted on resume, which meant the sharpest signal in the session was
     * also the only one nothing kept. */
    lookups: v.optional(v.array(translationLookupValidator)),
  })
    .index("by_room", ["room"])
    .index("by_user", ["userId"])
    // History reads one learner's recent sessions newest-first; `by_user`
    // alone would make it collect a lifetime of rows to show thirty. It is
    // also the one-open-session guard's read: `sessions.start` refuses while
    // this learner's newest row has no `endedAt` and is younger than fifteen
    // minutes.
    .index("by_user_startedAt", ["userId", "startedAt"])
    // The reconciliation cron's read (`convex/crons.ts`): every row still open
    // and older than two hours. `endedAt` is the first field so `eq(undefined)`
    // selects exactly the unfinished rows and `startedAt` orders them — the
    // alternative is a full table scan every hour, forever.
    .index("by_endedAt_startedAt", ["endedAt", "startedAt"])
    // History's read: one learner's FINISHED rows, newest first.
    // `by_user_startedAt` could not express "finished" at all, so the query
    // over-fetched and filtered in JS — a learner with a run of abandoned rows
    // pushed real conversations off their own history page. Ordering on
    // `endedAt` with a `gte(0)` bound selects exactly the finished rows and
    // pages them properly, however many open rows sit alongside.
    .index("by_user_endedAt", ["userId", "endedAt"]),

  purchases: defineTable({
    userId: v.id("users"),
    stripeSessionId: v.string(),
    pack: v.string(),
    minutes: v.number(),
    amountCents: v.number(),
    status: v.union(
      v.literal("pending"),
      v.literal("paid"),
      v.literal("failed")
    ),
    createdAt: v.number(),
  })
    .index("by_stripe_session_id", ["stripeSessionId"])
    .index("by_user", ["userId"]),
})
