import { v } from "convex/values"

import {
  internalMutation,
  internalQuery,
  mutation,
  query,
  type MutationCtx,
  type QueryCtx,
} from "./_generated/server"
import { internal } from "./_generated/api"
import type { Doc } from "./_generated/dataModel"
import { ledgerKindValidator, levelValidator } from "./validators"
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
  // `null` is a real answer here (signed out), so the return validator is a
  // union rather than an object: the three states this query distinguishes are
  // part of its contract, and a validator that only described the happy one
  // would let a refactor return `undefined` for "no row yet" unnoticed.
  returns: v.union(
    v.null(),
    v.object({
      clerkId: v.string(),
      /** From the Clerk identity, falling back to the row. `null` for an
       * account Clerk has no email for — never `""`. */
      email: v.union(v.string(), v.null()),
      /** `null` means "signed in, never been through `/welcome`" — the state
       * the shell redirects on. */
      level: v.union(levelValidator, v.null()),
      seconds: v.number(),
      minutes: v.number(),
    })
  ),
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
  returns: v.array(
    v.object({
      id: v.id("creditLedger"),
      kind: ledgerKindValidator,
      /** Signed seconds: grants positive, debits negative. */
      seconds: v.number(),
      createdAt: v.number(),
    })
  ),
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
  returns: v.null(),
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
  returns: v.null(),
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
  returns: v.object({ balanceSeconds: v.number() }),
  handler: async (ctx, args) => {
    const user = await userByClerkId(ctx, args.clerkId)
    if (user === null) return { balanceSeconds: 0 }
    return { balanceSeconds: await secondsFor(ctx, user._id) }
  },
})

/* -------------------------------------------------------------------------- */
/*  Account deletion                                                          */
/* -------------------------------------------------------------------------- */

/**
 * How many rows of one table one call may delete.
 *
 * A Convex mutation is a transaction with a bounded read/write budget, so
 * "delete everything this learner ever wrote" is not one call — a heavy user
 * has thousands of ledger rows. The batch is deliberately well under the
 * limit and the mutation re-schedules itself until there is nothing left, so
 * deletion completes for an account of any size instead of failing at the one
 * size that matters most.
 */
const DELETE_BATCH = 200

/**
 * Erase a learner, by their Clerk id. The Convex half of account deletion.
 *
 * Called only from `POST /clerk/webhook` (`convex/http.ts`) on Clerk's
 * `user.deleted` event, which is the only place that knows the account is
 * gone: Clerk owns identity, and before this route existed deleting a Clerk
 * user left the `users`, `creditLedger` and `sessions` rows here forever
 * (audit B5). The Privacy page promises deletion; this is the promise.
 *
 * Internal, and it must stay internal: it takes the id to erase as an
 * argument rather than from `ctx.auth`, which is only safe behind a verified
 * Clerk webhook signature.
 *
 * **Idempotent.** An id with no row is a no-op, not an error — Clerk retries a
 * webhook it did not get a 2xx for, and the second delivery of a delete that
 * already succeeded must be a success too.
 *
 * **Bounded, and it finishes.** Up to `DELETE_BATCH` rows per table per call;
 * if either table filled its batch there may be more, so it schedules itself
 * again and leaves the `users` row in place. The `users` row is deleted last
 * and only on the pass that drains both tables, so the row is also the marker
 * for "this deletion is still in flight" — a crash between batches leaves an
 * account that a re-delivery (or the next `user.deleted`) can still find.
 *
 * **`purchases` is not swept here** because nothing writes it yet: the Stripe
 * rail is phase 8. Whoever adds the first writer adds the third batch here,
 * and the test below is where they will notice they have to.
 */
export const deleteByClerkId = internalMutation({
  args: { clerkId: v.string() },
  returns: v.null(),
  handler: async (ctx, args) => {
    const user = await userByClerkId(ctx, args.clerkId)
    // Unknown id: nothing to do, and that is a success. See the note above.
    if (user === null) return null

    const ledger = await ctx.db
      .query("creditLedger")
      .withIndex("by_user", (q) => q.eq("userId", user._id))
      .take(DELETE_BATCH)
    for (const entry of ledger) await ctx.db.delete(entry._id)

    const sessions = await ctx.db
      .query("sessions")
      .withIndex("by_user", (q) => q.eq("userId", user._id))
      .take(DELETE_BATCH)
    for (const session of sessions) await ctx.db.delete(session._id)

    if (ledger.length === DELETE_BATCH || sessions.length === DELETE_BATCH) {
      // A full batch means there may be more. `runAfter(0, ...)` is scheduled
      // inside this transaction, so it is committed with the deletions or not
      // at all — there is no window where the batch lands and the follow-up
      // is lost.
      await ctx.scheduler.runAfter(0, internal.users.deleteByClerkId, args)
      return null
    }

    await ctx.db.delete(user._id)
    return null
  },
})
