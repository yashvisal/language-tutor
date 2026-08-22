import { v } from "convex/values"

import {
  mutation,
  query,
  type MutationCtx,
  type QueryCtx,
} from "./_generated/server"
import type { Doc } from "./_generated/dataModel"
import { levelValidator } from "./validators"
import { SIGNUP_GRANT_MINUTES } from "../lib/billing"

/** Spanish only until the loop is monetized — see the vision doc. */
const TARGET_LANG = "es"
const ANCHOR_LANG = "en"

/** The one lookup every authenticated function starts from. */
async function userByClerkId(
  ctx: QueryCtx | MutationCtx,
  clerkId: string
): Promise<Doc<"users"> | null> {
  return await ctx.db
    .query("users")
    .withIndex("by_clerk_id", (q) => q.eq("clerkId", clerkId))
    .unique()
}

/** Balance is always summed from the ledger, never read off a field. */
async function minutesFor(
  ctx: QueryCtx | MutationCtx,
  userId: Doc<"users">["_id"]
): Promise<number> {
  const entries = await ctx.db
    .query("creditLedger")
    .withIndex("by_user", (q) => q.eq("userId", userId))
    .collect()
  return entries.reduce((sum, entry) => sum + entry.minutes, 0)
}

/**
 * Everything the signed-in UI needs about the learner, in one reactive read:
 * identity, declared level, and the minute balance.
 *
 * Three answers, and the callers depend on the difference:
 * - `null` — signed out.
 * - `level: null` — signed in with no `users` row yet, i.e. this account has
 *   never been through `/welcome`. The shell sends them there.
 * - a level — a real learner.
 *
 * Email comes from the Clerk identity rather than the row, so a change in
 * Clerk shows up without a sync job.
 */
export const viewer = query({
  args: {},
  handler: async (ctx) => {
    const identity = await ctx.auth.getUserIdentity()
    if (identity === null) return null

    const user = await userByClerkId(ctx, identity.subject)
    return {
      clerkId: identity.subject,
      // `||`, not `??`: an empty string is an absent email, and rows written
      // before that was true still carry one. The UI never sees "".
      email: identity.email || user?.email || null,
      level: user?.level ?? null,
      minutes: user === null ? 0 : await minutesFor(ctx, user._id),
    }
  },
})

/**
 * Creates the learner's row and hands them their free minutes. Called from
 * `/welcome`, but written to survive being called from anywhere, any number of
 * times: the row is created once, the level is updated when passed, and the
 * signup grant is keyed on `signup:<clerkId>` so a double-submit, a retry or a
 * second visit to `/welcome` cannot mint a second one.
 */
export const ensureUser = mutation({
  args: { level: v.optional(levelValidator) },
  handler: async (ctx, args) => {
    const identity = await ctx.auth.getUserIdentity()
    if (identity === null) throw new Error("Not signed in")

    const clerkId = identity.subject
    const existing = await userByClerkId(ctx, clerkId)

    let userId
    if (existing === null) {
      userId = await ctx.db.insert("users", {
        clerkId,
        // Absent, not empty: see the schema note on `users.email`.
        email: identity.email || undefined,
        level: args.level,
        targetLang: TARGET_LANG,
        anchorLang: ANCHOR_LANG,
        createdAt: Date.now(),
      })
    } else {
      userId = existing._id
      if (args.level !== undefined && args.level !== existing.level) {
        await ctx.db.patch(userId, { level: args.level })
      }
    }

    // The grant is separate from row creation on purpose: an account that
    // somehow got a row without one (an early tester, a partial write) still
    // gets its ten minutes, and one that already has it never gets a second.
    const ref = `signup:${clerkId}`
    const granted = await ctx.db
      .query("creditLedger")
      .withIndex("by_ref", (q) => q.eq("ref", ref))
      .first()
    if (granted === null) {
      await ctx.db.insert("creditLedger", {
        userId,
        kind: "signup_grant",
        minutes: SIGNUP_GRANT_MINUTES,
        ref,
        createdAt: Date.now(),
      })
    }

    return null
  },
})

/** The only editable field on the account page. */
export const setLevel = mutation({
  args: { level: levelValidator },
  handler: async (ctx, args) => {
    const identity = await ctx.auth.getUserIdentity()
    if (identity === null) throw new Error("Not signed in")

    const user = await userByClerkId(ctx, identity.subject)
    if (user === null) throw new Error("No account yet")

    await ctx.db.patch(user._id, { level: args.level })
    return null
  },
})
