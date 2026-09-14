import { convexTest } from "convex-test"
import { describe, expect, test } from "vitest"

import { api, internal } from "./_generated/api"
import type { Id } from "./_generated/dataModel"
import schema from "./schema"
import type { sessionPlanValidator } from "./validators"
import { SIGNUP_GRANT_SECONDS } from "../lib/billing"

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
        seconds: SIGNUP_GRANT_SECONDS,
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

describe("users.setBalance", () => {
  test("writes one adjustment for the difference, and nothing when there is none", async () => {
    const t = setup()
    const userId = await makeLearner(t, "user_owner", { ledgerRows: 1, sessionRows: 0 })

    expect(
      await t.mutation(internal.users.setBalance, { clerkId: "user_owner", seconds: 900 })
    ).toEqual({ before: SIGNUP_GRANT_SECONDS, after: 900 })
    expect(
      await t.mutation(internal.users.setBalance, { clerkId: "user_owner", seconds: 900 })
    ).toEqual({ before: 900, after: 900 })
    expect(
      await t.mutation(internal.users.setBalance, { clerkId: "user_owner", seconds: 60 })
    ).toEqual({ before: 900, after: 60 })

    const rows = await t.run(async (ctx) =>
      ctx.db
        .query("creditLedger")
        .withIndex("by_user", (q) => q.eq("userId", userId))
        .collect()
    )
    // The grant, +600, then -840: a ledger of what happened, not a number edited.
    expect(rows.map((row) => [row.kind, row.seconds])).toEqual([
      ["signup_grant", SIGNUP_GRANT_SECONDS],
      ["adjustment", 900 - SIGNUP_GRANT_SECONDS],
      ["adjustment", 60 - 900],
    ])
    await expect(
      t.mutation(internal.users.setBalance, { clerkId: "user_nobody", seconds: 1 })
    ).rejects.toThrow("No such user")
  })

  test("a ref names one row: the same ref again is refused, not applied twice", async () => {
    const t = setup()
    const userId = await makeLearner(t, "user_owner", { ledgerRows: 1, sessionRows: 0 })

    expect(
      await t.mutation(internal.users.setBalance, {
        clerkId: "user_owner",
        seconds: 900,
        ref: "support:1234",
      })
    ).toEqual({ before: SIGNUP_GRANT_SECONDS, after: 900 })
    await expect(
      t.mutation(internal.users.setBalance, {
        clerkId: "user_owner",
        seconds: 1800,
        ref: "support:1234",
      })
    ).rejects.toThrow("Ledger ref already used")

    const rows = await t.run(async (ctx) =>
      ctx.db
        .query("creditLedger")
        .withIndex("by_user", (q) => q.eq("userId", userId))
        .collect()
    )
    expect(rows.map((row) => [row.kind, row.seconds])).toEqual([
      ["signup_grant", SIGNUP_GRANT_SECONDS],
      ["adjustment", 900 - SIGNUP_GRANT_SECONDS],
    ])
  })
})

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

/* -------------------------------------------------------------------------- */
/*  The money entry point                                                     */
/* -------------------------------------------------------------------------- */

/**
 * `ensureUser` is where every learner's balance comes from, and until now it
 * had no tests at all (launch checklist C4). The free grant is the whole
 * product for a beta with no checkout: minting two of them is money, and
 * minting none of them is a learner who cannot start a conversation.
 *
 * The grant is keyed on `signup:<clerkId>` and checked against `by_ref`, so
 * these are the three ways that key has to hold: called twice at once, called
 * against a row that somehow has no grant, and called never (which is what
 * `viewer` has to render).
 */
describe("users.ensureUser", () => {
  test("grants the free minutes exactly once across two concurrent calls", async () => {
    const t = setup()
    const asLearner = t.withIdentity({
      subject: "user_new",
      email: "new@example.com",
    })

    // The real race: the server ensures the viewer on the first signed-in
    // request, and a reload or a second tab fires the same call again before
    // the first has committed.
    await Promise.all([
      asLearner.mutation(api.users.ensureUser, {}),
      asLearner.mutation(api.users.ensureUser, {}),
    ])

    const rows = await t.run(async (ctx) => ({
      users: await ctx.db.query("users").collect(),
      ledger: await ctx.db.query("creditLedger").collect(),
    }))
    expect(rows.users).toHaveLength(1)
    expect(rows.ledger).toHaveLength(1)
    expect(rows.ledger[0].kind).toBe("signup_grant")
    expect(rows.ledger[0].seconds).toBe(SIGNUP_GRANT_SECONDS)
    expect(rows.ledger[0].ref).toBe("signup:user_new")
    expect(await asLearner.query(api.users.viewer, {})).toMatchObject({
      onboarded: true,
      seconds: SIGNUP_GRANT_SECONDS,
    })
  })

  test("an existing row with no grant still gets one", async () => {
    const t = setup()
    // An early tester, or a partial write: the row exists and the ledger is
    // empty. The grant is deliberately not tied to row creation for this.
    const userId = await t.run(async (ctx) =>
      ctx.db.insert("users", {
        clerkId: "user_rowonly",
        email: "rowonly@example.com",
        createdAt: Date.now(),
      })
    )

    await t
      .withIdentity({ subject: "user_rowonly", email: "rowonly@example.com" })
      .mutation(api.users.ensureUser, {})

    const rows = await t.run(async (ctx) => ({
      users: await ctx.db.query("users").collect(),
      ledger: await ctx.db
        .query("creditLedger")
        .withIndex("by_user", (q) => q.eq("userId", userId))
        .collect(),
    }))
    // One grant, and no second `users` row alongside the one that was there.
    expect(rows.users).toHaveLength(1)
    expect(rows.users[0]._id).toBe(userId)
    expect(rows.ledger.map((row) => [row.kind, row.seconds])).toEqual([
      ["signup_grant", SIGNUP_GRANT_SECONDS],
    ])

    // ...and calling it again after that changes nothing.
    await t
      .withIdentity({ subject: "user_rowonly", email: "rowonly@example.com" })
      .mutation(api.users.ensureUser, {})
    expect(
      await t.run(async (ctx) => ctx.db.query("creditLedger").collect())
    ).toHaveLength(1)
  })
})

describe("users.viewer", () => {
  test("an identity with no row is onboarded: false with a zero balance", async () => {
    const t = setup()

    // The documented shape. `/home` creates the row on the server and
    // redirects on `null`, so this is the state between signing up and the
    // first ensured request — and it must render, not throw.
    expect(
      await t
        .withIdentity({ subject: "user_rowless", email: "rowless@example.com" })
        .query(api.users.viewer, {})
    ).toEqual({
      clerkId: "user_rowless",
      email: "rowless@example.com",
      onboarded: false,
      seconds: 0,
      minutes: 0,
    })
  })

  test("is null signed out", async () => {
    const t = setup()
    expect(await t.query(api.users.viewer, {})).toBeNull()
  })
})

/* -------------------------------------------------------------------------- */
/*  The balance checkpoint                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Reading a balance used to mean reading a lifetime of ledger rows (audit L9,
 * launch checklist C2) — one row per active minute, on every dashboard render
 * and three times per debit, until a heavy learner crossed Convex's per-query
 * document limit and everything that touches money broke at once.
 *
 * The checkpoint is a cache of a sum, so the only property that really matters
 * is that it is EXACTLY the sum: every test here compares the answer against
 * the whole ledger added up by hand.
 */
describe("the balance checkpoint", () => {
  /** The naive answer: every row, added up. What the checkpoint must equal. */
  function wholeLedger(t: TestConvex, userId: Id<"users">) {
    return t.run(async (ctx) => {
      const rows = await ctx.db
        .query("creditLedger")
        .withIndex("by_user", (q) => q.eq("userId", userId))
        .collect()
      return rows.reduce((sum, row) => sum + row.seconds, 0)
    })
  }

  function checkpointsOf(t: TestConvex, userId: Id<"users">) {
    return t.run(async (ctx) =>
      ctx.db
        .query("ledgerCheckpoints")
        .withIndex("by_user", (q) => q.eq("userId", userId))
        .collect()
    )
  }

  /** One room's worth of conversation: `reports` periodic debits, a minute
   * apart on the meter, the way a real session bills. */
  async function talk(
    t: TestConvex,
    clerkId: string,
    room: string,
    reports: number
  ) {
    for (let seq = 1; seq <= reports; seq++) {
      await t.mutation(internal.sessions.debit, {
        room,
        clerkId,
        jobId: "job_1",
        seconds: seq * 60,
        seq,
      })
    }
  }

  test("a fresh account reads its balance with no checkpoint at all", async () => {
    const t = setup()
    const userId = await makeLearner(t, "user_new", { sessionRows: 0 })

    expect(await checkpointsOf(t, userId)).toHaveLength(0)
    expect(
      await t.query(internal.users.balanceByClerkId, { clerkId: "user_new" })
    ).toEqual({ balanceSeconds: SIGNUP_GRANT_SECONDS })
    expect(await wholeLedger(t, userId)).toBe(SIGNUP_GRANT_SECONDS)
  })

  test("the balance is the checkpoint plus the rows after it, exactly", async () => {
    const t = setup()
    const userId = await makeLearner(t, "user_talker", { sessionRows: 0 })
    // Enough minutes to pay for the conversation this is about to have.
    await t.mutation(internal.users.setBalance, {
      clerkId: "user_talker",
      seconds: 60 * 60 * 4,
    })

    // Past the checkpoint threshold, so one is written mid-conversation...
    await talk(t, "user_talker", "room-long", 60)
    const checkpoints = await checkpointsOf(t, userId)
    expect(checkpoints.length).toBeGreaterThan(0)
    expect(await wholeLedger(t, userId)).toBe(
      await t
        .query(internal.users.balanceByClerkId, { clerkId: "user_talker" })
        .then((result) => result.balanceSeconds)
    )

    // ...and the rows written after it are still counted.
    await talk(t, "user_talker", "room-after", 5)
    const newest = (await checkpointsOf(t, userId)).at(-1)!
    const rowsAfter = await t.run(async (ctx) =>
      ctx.db
        .query("creditLedger")
        .withIndex("by_user", (q) =>
          q
            .eq("userId", userId)
            .gt("_creationTime", newest.throughCreationTime)
        )
        .collect()
    )
    expect(rowsAfter.length).toBeGreaterThan(0)
    expect(
      (await t.query(internal.users.balanceByClerkId, { clerkId: "user_talker" }))
        .balanceSeconds
    ).toBe(await wholeLedger(t, userId))
  })

  test("checkpointing again with nothing new writes nothing", async () => {
    const t = setup()
    const userId = await makeLearner(t, "user_talker", { sessionRows: 0 })
    await t.mutation(internal.users.setBalance, {
      clerkId: "user_talker",
      seconds: 60 * 60 * 4,
    })
    await talk(t, "user_talker", "room-long", 60)

    const before = await checkpointsOf(t, userId)
    const balance = await wholeLedger(t, userId)

    // A handful more debits: fewer than the threshold, so the tail has not
    // earned a checkpoint and the newest one stays where it is.
    await talk(t, "user_talker", "room-short", 3)

    const after = await checkpointsOf(t, userId)
    expect(after.at(-1)!._id).toBe(before.at(-1)!._id)
    expect(
      (await t.query(internal.users.balanceByClerkId, { clerkId: "user_talker" }))
        .balanceSeconds
    ).toBe(await wholeLedger(t, userId))
    // ...and the extra minutes really were billed, so this is not a balance
    // that simply stopped moving.
    expect(await wholeLedger(t, userId)).toBeLessThan(balance)
  })

  test("deleting the account takes the checkpoints with it", async () => {
    const t = setup()
    const userId = await makeLearner(t, "user_talker", { sessionRows: 0 })
    await t.mutation(internal.users.setBalance, {
      clerkId: "user_talker",
      seconds: 60 * 60 * 4,
    })
    await talk(t, "user_talker", "room-long", 60)
    expect((await checkpointsOf(t, userId)).length).toBeGreaterThan(0)

    await t.mutation(internal.users.deleteByClerkId, { clerkId: "user_talker" })
    await t.finishAllScheduledFunctions(() => {})

    expect(await checkpointsOf(t, userId)).toHaveLength(0)
    expect(await remainsOf(t, userId)).toEqual({
      user: 0,
      ledger: 0,
      sessions: 0,
    })
  })
})
