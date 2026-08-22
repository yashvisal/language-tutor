import { query } from "./_generated/server"

/**
 * Smoke query for the Clerk↔Convex wiring: null signed out, the Clerk
 * identity signed in. The phase-5 `users` table replaces this as the real
 * source of user state; keep the name — `viewer` is what the UI will keep
 * asking for.
 */
export const viewer = query({
  args: {},
  handler: async (ctx) => {
    const identity = await ctx.auth.getUserIdentity()
    if (identity === null) return null
    return { clerkId: identity.subject, email: identity.email ?? null }
  },
})
