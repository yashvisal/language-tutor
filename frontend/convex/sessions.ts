import { v } from "convex/values"

import { internalMutation, mutation } from "./_generated/server"
import type { Doc } from "./_generated/dataModel"
import { secondsFor, userByClerkId } from "./users"
import { sessionPlanValidator } from "./validators"

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
