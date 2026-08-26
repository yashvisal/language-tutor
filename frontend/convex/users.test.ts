import { convexTest } from "convex-test"
import { describe, expect, test } from "vitest"

import { internal } from "./_generated/api"
import type { Id } from "./_generated/dataModel"
import schema from "./schema"
import type { sessionPlanValidator } from "./validators"

/**
 * Account deletion, tested as the promise it keeps.
 *
 * The Privacy page says a deleted account's data goes; before the Clerk
 * webhook existed, deleting a learner at Clerk left their `users`,
 * `creditLedger` and `sessions` rows here forever (audit B5) — including the
 * learner speech held in `sessions.transcript` and
 * `sessions.outcome.corrections`. So what is tested here is not "the mutation
 * runs" but "nothing of that learner is left, nothing of anyone else is
 * touched, and it finishes for an account too big for one transaction".
 *
 * See the note in `sessions.test.ts` on `import.meta.glob` and the cast.
 */
const modules = (
  import.meta as ImportMeta & {
    glob: (pattern: string) => Record<string, () => Promise<unknown>>
  }
).glob("./**/*.*s")

const setup = () => convexTest(schema, modules)
type TestConvex = ReturnType<typeof setup>

type SessionPlanArg = (typeof sessionPlanValidator)["type"]

const PLAN: SessionPlanArg = {
  scenario: null,
  topic: "food",
  tenses: [],
  vocab: [],
  level: null,
}

/** A learner with a row, a grant and some history — the state a real account
 * is in by the time anyone deletes it. */
async function makeLearner(
  t: TestConvex,
  clerkId: string,
  { ledgerRows = 1, sessionRows = 2 } = {}
): Promise<Id<"users">> {
  return await t.run(async (ctx) => {
    const userId = await ctx.db.insert("users", {
      clerkId,
      email: `${clerkId}@example.com`,
      targetLang: "es",
      anchorLang: "en",
      createdAt: Date.now(),
    })
    for (let i = 0; i < ledgerRows; i++) {
      await ctx.db.insert("creditLedger", {
        userId,
        kind: "signup_grant",
        seconds: 600,
        ref: `${clerkId}:${i}`,
        createdAt: Date.now(),
      })
    }
    for (let i = 0; i < sessionRows; i++) {
      await ctx.db.insert("sessions", {
        userId,
        room: `${clerkId}-room-${i}`,
        plan: PLAN,
        startedAt: Date.now(),
        endedAt: Date.now(),
        transcript: [{ role: "learner", text: "hola, quiero un cafe" }],
      })
    }
    return userId
  })
}

/** What is left of a learner: the three tables, counted. */
async function remainsOf(t: TestConvex, userId: Id<"users">) {
  return await t.run(async (ctx) => ({
    user: (await ctx.db.get(userId)) === null ? 0 : 1,
    ledger: (
      await ctx.db
        .query("creditLedger")
        .withIndex("by_user", (q) => q.eq("userId", userId))
        .collect()
    ).length,
    sessions: (
      await ctx.db
        .query("sessions")
        .withIndex("by_user", (q) => q.eq("userId", userId))
        .collect()
    ).length,
  }))
}

describe("users.deleteByClerkId", () => {
  test("erases the learner from all three tables", async () => {
    const t = setup()
    const userId = await makeLearner(t, "user_gone", {
      ledgerRows: 3,
      sessionRows: 4,
    })

    await t.mutation(internal.users.deleteByClerkId, { clerkId: "user_gone" })

    expect(await remainsOf(t, userId)).toEqual({
      user: 0,
      ledger: 0,
      sessions: 0,
    })
  })

  test("touches nothing of another learner", async () => {
    const t = setup()
    const gone = await makeLearner(t, "user_gone", {
      ledgerRows: 2,
      sessionRows: 3,
    })
    const kept = await makeLearner(t, "user_kept", {
      ledgerRows: 2,
      sessionRows: 3,
    })

    await t.mutation(internal.users.deleteByClerkId, { clerkId: "user_gone" })

    // Deleting one account must never be a way to delete another's ledger —
    // every read is bound to `by_user` with this learner's id.
    expect(await remainsOf(t, gone)).toEqual({
      user: 0,
      ledger: 0,
      sessions: 0,
    })
    expect(await remainsOf(t, kept)).toEqual({
      user: 1,
      ledger: 2,
      sessions: 3,
    })
  })

  test("is idempotent: an id with no row is a no-op, not a throw", async () => {
    const t = setup()
    const kept = await makeLearner(t, "user_kept")

    // Clerk retries a webhook it did not get a 2xx for, so the second
    // delivery of a delete that already succeeded has to succeed too.
    await expect(
      t.mutation(internal.users.deleteByClerkId, { clerkId: "user_never" })
    ).resolves.toBeNull()
    await t.mutation(internal.users.deleteByClerkId, { clerkId: "user_kept" })
    await expect(
      t.mutation(internal.users.deleteByClerkId, { clerkId: "user_kept" })
    ).resolves.toBeNull()

    expect(await remainsOf(t, kept)).toEqual({
      user: 0,
      ledger: 0,
      sessions: 0,
    })
  })

  test("drains an account too big for one transaction", async () => {
    const t = setup()
    // 450 ledger rows: more than two batches of 200, so the mutation has to
    // schedule itself twice and the `users` row must survive until the last
    // pass. This is the case that matters — a heavy user is exactly the
    // account whose deletion must not half-finish.
    const userId = await makeLearner(t, "user_heavy", {
      ledgerRows: 450,
      sessionRows: 5,
    })

    await t.mutation(internal.users.deleteByClerkId, { clerkId: "user_heavy" })

    // After one pass: a full batch gone, and the row still there as the
    // marker that this deletion is in flight.
    const midway = await remainsOf(t, userId)
    expect(midway.ledger).toBe(250)
    expect(midway.user).toBe(1)

    // The follow-ups it scheduled, and the ones those schedule in turn.
    await t.finishAllScheduledFunctions(() => {})

    expect(await remainsOf(t, userId)).toEqual({
      user: 0,
      ledger: 0,
      sessions: 0,
    })
  })
})
