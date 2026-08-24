import { defineSchema, defineTable } from "convex/server"
import { v } from "convex/values"

import { levelValidator, sessionPlanValidator } from "./validators"

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
     * index first: `signup:<clerkId>`, a Stripe session id, or `<room>:<seq>`
     * for a worker debit.
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
    corrections: v.optional(v.number()),
  })
    .index("by_room", ["room"])
    .index("by_user", ["userId"]),

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
