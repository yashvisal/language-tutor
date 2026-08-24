import { v } from "convex/values"

import {
  internalQuery,
  mutation,
  query,
  type MutationCtx,
  type QueryCtx,
} from "./_generated/server"
import type { Doc } from "./_generated/dataModel"
import { levelValidator } from "./validators"
import { minutesFromSeconds, SIGNUP_GRANT_SECONDS } from "../lib/billing"

/** Spanish only until the loop is monetized — see the vision doc. */
const TARGET_LANG = "es"
const ANCHOR_LANG = "en"

/** The one lookup every authenticated function starts from. Exported for the
 * HTTP actions, which are handed a Clerk id rather than an identity. */
export async function userByClerkId(
  ctx: QueryCtx | MutationCtx,
  clerkId: string
): Promise<Doc<"users"> | null> {
  return await ctx.db
    .query("users")
    .withIndex("by_clerk_id", (q) => q.eq("clerkId", clerkId))
    .unique()
}

/** Balance is always summed from the ledger, never read off a field. */
export async function secondsFor(
  ctx: QueryCtx | MutationCtx,
  userId: Doc<"users">["_id"]
): Promise<number> {
  const entries = await ctx.db
    .query("creditLedger")
    .withIndex("by_user", (q) => q.eq("userId", userId))
    .collect()
  return entries.reduce((sum, entry) => sum + entry.seconds, 0)
}

/**
 * Everything the signed-in UI needs about the learner, in one reactive read:
 * identity, declared level, and the balance — in seconds, which is what the
 * meter spends, plus the whole minutes every surface actually prints.
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
    const seconds = user === null ? 0 : await secondsFor(ctx, user._id)
    return {
      clerkId: identity.subject,
      // `||`, not `??`: an empty string is an absent email, and rows written
      // before that was true still carry one. The UI never sees "".
      email: identity.email || user?.email || null,
      level: user?.level ?? null,
      seconds,
      // Derived here rather than in each caller so "23 minutes left" means the
      // same thing on the dashboard, in the header and on the pre-flight.
      minutes: minutesFromSeconds(seconds),
    }
  },
})

/**
 * The learner's recent credit history, newest first — what the Billing dialog
 * prints under "Recent activity".
 *
 * Read straight off `by_user` and reversed rather than sorted by `createdAt`:
 * the index is already in insertion order, which is the order the ledger was
 * written in, and 20 rows is the whole page. Signed out, or signed in with no
 * row yet, is an empty list rather than an error — the dialog is reachable
 * before `/welcome` has run.
 */
export const ledger = query({
  args: {},
  handler: async (ctx) => {
    const identity = await ctx.auth.getUserIdentity()
    if (identity === null) return []

    const user = await userByClerkId(ctx, identity.subject)
    if (user === null) return []

    const entries = await ctx.db
      .query("creditLedger")
      .withIndex("by_user", (q) => q.eq("userId", user._id))
      .order("desc")
      .take(20)

    return entries.map((entry) => ({
      id: entry._id,
      kind: entry.kind,
      seconds: entry.seconds,
      createdAt: entry.createdAt,
    }))
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
    // gets its free minutes, and one that already has it never gets a second.
    const ref = `signup:${clerkId}`
    const granted = await ctx.db
      .query("creditLedger")
      .withIndex("by_ref", (q) => q.eq("ref", ref))
      .first()
    if (granted === null) {
      await ctx.db.insert("creditLedger", {
        userId,
        kind: "signup_grant",
        seconds: SIGNUP_GRANT_SECONDS,
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

/**
 * The balance, by Clerk id, for the worker.
 *
 * Internal: the only caller is `convex/http.ts`, which has already checked the
 * shared secret. There is no `ctx.auth` identity on that path — the worker acts
 * for the learner, it is not the learner — so the id arrives as an argument,
 * which is exactly why this must never be public.
 */
export const balanceByClerkId = internalQuery({
  args: { clerkId: v.string() },
  handler: async (ctx, args) => {
    const user = await userByClerkId(ctx, args.clerkId)
    if (user === null) return { balanceSeconds: 0 }
    return { balanceSeconds: await secondsFor(ctx, user._id) }
  },
})
