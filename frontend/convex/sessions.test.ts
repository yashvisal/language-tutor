import { convexTest } from "convex-test"
import { describe, expect, test } from "vitest"

import { api, internal } from "./_generated/api"
import type { Doc, Id } from "./_generated/dataModel"
import schema from "./schema"
import type { sessionPlanValidator } from "./validators"
import { OPEN_SESSION_PREFIX, OPEN_SESSION_WINDOW_MS } from "../lib/billing"

/**
 * The money seam, tested where it is decided.
 *
 * Everything here is one of the four ways a learner could talk for free or be
 * charged for someone else's conversation, written as the attack rather than
 * as the function: a replayed room name, a second tab, a redispatched job, a
 * stale report. The delta arithmetic is tested too, because "bills only what
 * is new" is the property every one of those defences rests on.
 *
 * `import.meta.glob` is how `convex-test` finds the function modules — it runs
 * them in-process against an in-memory database, so these are the real
 * mutations against the real schema and indexes, not a mock of them. It is
 * Vite's, and Vite here is vitest's; the cast is so that `tsc` — which type-
 * checks this file as part of the Next app, where no such thing exists —
 * doesn't have to be told about `vite/client` project-wide.
 */
const modules = (
  import.meta as ImportMeta & {
    glob: (pattern: string) => Record<string, () => Promise<unknown>>
  }
).glob("./**/*.*s")

/** One in-memory deployment, schema and all. Every test gets its own: the
 * database is state, and a shared one turns "this learner has a session open"
 * into whichever test ran first. */
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

const GRANT = 600

/** A learner with a row and a signup grant — the state `/welcome` leaves. */
async function makeLearner(
  t: TestConvex,
  clerkId: string
): Promise<Id<"users">> {
  return await t.run(async (ctx) => {
    const userId = await ctx.db.insert("users", {
      clerkId,
      targetLang: "es",
      anchorLang: "en",
      createdAt: Date.now(),
    })
    await ctx.db.insert("creditLedger", {
      userId,
      kind: "signup_grant",
      seconds: GRANT,
      ref: `signup:${clerkId}`,
      createdAt: Date.now(),
    })
    return userId
  })
}

function sessionsOf(t: TestConvex, userId: Id<"users">) {
  return t.run(async (ctx) =>
    ctx.db
      .query("sessions")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .collect()
  )
}

function debitsOf(t: TestConvex, userId: Id<"users">) {
  return t.run(async (ctx) => {
    const rows = await ctx.db
      .query("creditLedger")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .collect()
    return rows.filter((row: Doc<"creditLedger">) => row.kind === "debit")
  })
}

describe("sessions.start", () => {
  test("refuses a room another learner already owns", async () => {
    const t = setup()
    await makeLearner(t, "user_owner")
    await makeLearner(t, "user_attacker")

    const room = "lesson-owner-1-aaaa"
    await t
      .withIdentity({ subject: "user_owner" })
      .mutation(api.sessions.start, { room, plan: PLAN })

    // The exploit B1 describes: the room carries the debit's high-water mark,
    // so joining a room that has already been billed makes a fresh worker
    // clock report under the mark and debit nothing. The route no longer lets
    // a client name a room; this is the lock behind that one.
    await expect(
      t
        .withIdentity({ subject: "user_attacker" })
        .mutation(api.sessions.start, { room, plan: PLAN })
    ).rejects.toThrow(/Not your session/)
  })

  test("a retried token request for the learner's own room is a no-op", async () => {
    const t = setup()
    const userId = await makeLearner(t, "user_owner")
    const as = t.withIdentity({ subject: "user_owner" })
    const room = "lesson-owner-1-aaaa"

    await as.mutation(api.sessions.start, { room, plan: PLAN })
    await as.mutation(api.sessions.start, { room, plan: PLAN })

    // One row, not two: two rows would give the debit two high-water marks.
    expect(await sessionsOf(t, userId)).toHaveLength(1)
  })

  test("refuses a second conversation while one is open", async () => {
    const t = setup()
    await makeLearner(t, "user_owner")
    const as = t.withIdentity({ subject: "user_owner" })

    await as.mutation(api.sessions.start, { room: "room-a", plan: PLAN })

    // Two tabs, one balance: each worker budgets the *whole* balance, both
    // debit at teardown, and the ledger goes negative by (N-1) x balance.
    await expect(
      as.mutation(api.sessions.start, { room: "room-b", plan: PLAN })
    ).rejects.toThrow(new RegExp(OPEN_SESSION_PREFIX))
  })

  test("allows the next conversation once the open one has ended", async () => {
    const t = setup()
    const userId = await makeLearner(t, "user_owner")
    const as = t.withIdentity({ subject: "user_owner" })

    await as.mutation(api.sessions.start, { room: "room-a", plan: PLAN })
    await t.run(async (ctx) => {
      const open = await ctx.db
        .query("sessions")
        .withIndex("by_room", (q) => q.eq("room", "room-a"))
        .unique()
      await ctx.db.patch(open!._id, { endedAt: Date.now() })
    })

    await as.mutation(api.sessions.start, { room: "room-b", plan: PLAN })
    expect(await sessionsOf(t, userId)).toHaveLength(2)
  })

  test("allows the next conversation once the open one is stale", async () => {
    const t = setup()
    const userId = await makeLearner(t, "user_owner")

    // A row nobody ever closed — a killed worker, a crashed tab. The guard is
    // a window, not a lock: a learner must not be shut out of their own
    // account by a crash while the reconciliation cron catches up.
    await t.run(async (ctx) => {
      await ctx.db.insert("sessions", {
        userId,
        room: "room-stale",
        plan: PLAN,
        startedAt: Date.now() - OPEN_SESSION_WINDOW_MS - 1000,
      })
    })

    await t
      .withIdentity({ subject: "user_owner" })
      .mutation(api.sessions.start, { room: "room-b", plan: PLAN })
    expect(await sessionsOf(t, userId)).toHaveLength(2)
  })

  test("one learner's open session does not block another's", async () => {
    const t = setup()
    await makeLearner(t, "user_a")
    const userB = await makeLearner(t, "user_b")

    await t
      .withIdentity({ subject: "user_a" })
      .mutation(api.sessions.start, { room: "room-a", plan: PLAN })
    await t
      .withIdentity({ subject: "user_b" })
      .mutation(api.sessions.start, { room: "room-b", plan: PLAN })

    expect(await sessionsOf(t, userB)).toHaveLength(1)
  })
})

describe("sessions.debit", () => {
  const room = "lesson-owner-1-aaaa"

  async function started(clerkId = "user_owner") {
    const t = setup()
    const userId = await makeLearner(t, clerkId)
    await t
      .withIdentity({ subject: clerkId })
      .mutation(api.sessions.start, { room, plan: PLAN })
    return { t, userId }
  }

  test("bills the delta against the high-water mark", async () => {
    const { t, userId } = await started()

    let result = await t.mutation(internal.sessions.debit, {
      room,
      clerkId: "user_owner",
      jobId: "job_1",
      seconds: 100,
      seq: 1,
    })
    expect(result.balanceSeconds).toBe(GRANT - 100)

    // The worker reports a running total, so the second report is +50, not
    // +150: the amount written is always what is new.
    result = await t.mutation(internal.sessions.debit, {
      room,
      clerkId: "user_owner",
      jobId: "job_1",
      seconds: 150,
      seq: 2,
    })
    expect(result.balanceSeconds).toBe(GRANT - 150)

    // A stale or out-of-order report lands under the mark and costs nothing.
    result = await t.mutation(internal.sessions.debit, {
      room,
      clerkId: "user_owner",
      jobId: "job_1",
      seconds: 120,
      seq: 3,
    })
    expect(result.balanceSeconds).toBe(GRANT - 150)

    expect(await debitsOf(t, userId)).toHaveLength(2)
    const [session] = await sessionsOf(t, userId)
    expect(session.secondsBilled).toBe(150)
    // The clock holding at zero is not the end of the session.
    expect(session.endedAt).toBeUndefined()
  })

  test("is idempotent on the ref", async () => {
    const { t, userId } = await started()
    const args = {
      room,
      clerkId: "user_owner",
      jobId: "job_1",
      seconds: 100,
      seq: 1,
    }

    const first = await t.mutation(internal.sessions.debit, args)
    const replay = await t.mutation(internal.sessions.debit, args)

    expect(replay.balanceSeconds).toBe(first.balanceSeconds)
    expect(await debitsOf(t, userId)).toHaveLength(1)
  })

  test("a redispatched job bills its own seconds instead of colliding", async () => {
    const { t, userId } = await started()

    await t.mutation(internal.sessions.debit, {
      room,
      clerkId: "user_owner",
      jobId: "job_1",
      seconds: 100,
      seq: 1,
    })

    // B3: `seq` restarts at 1 for every job. With the job id out of the ref
    // this second job replayed `room:1` and every debit it ever made was
    // dropped as a duplicate — a crash mid-session used to cost the whole
    // remainder of the session's revenue.
    const result = await t.mutation(internal.sessions.debit, {
      room,
      clerkId: "user_owner",
      jobId: "job_2",
      // Room-cumulative: the job read 100 from `billedSecondsForRoom` at start
      // and adds its own 30 active seconds.
      seconds: 130,
      seq: 1,
    })

    expect(result.balanceSeconds).toBe(GRANT - 130)
    expect(await debitsOf(t, userId)).toHaveLength(2)
  })

  test("a final report closes the row, once", async () => {
    const { t, userId } = await started()

    await t.mutation(internal.sessions.debit, {
      room,
      clerkId: "user_owner",
      jobId: "job_1",
      seconds: 60,
      seq: 1,
    })
    // A periodic report, or the debit at a hold on zero, is not the end.
    expect((await sessionsOf(t, userId))[0].endedAt).toBeUndefined()

    await t.mutation(internal.sessions.debit, {
      room,
      clerkId: "user_owner",
      jobId: "job_1",
      seconds: 90,
      seq: 2,
      final: true,
    })
    const closed = (await sessionsOf(t, userId))[0]
    expect(closed.endedAt).toBeTypeOf("number")
    expect(closed.secondsBilled).toBe(90)

    // A later report — a redispatch, a retry, a straggler — bills what is new
    // and leaves the end where it was. The row is history now.
    await t.mutation(internal.sessions.debit, {
      room,
      clerkId: "user_owner",
      jobId: "job_2",
      seconds: 95,
      seq: 1,
    })
    const after = (await sessionsOf(t, userId))[0]
    expect(after.endedAt).toBe(closed.endedAt)
    expect(after.secondsBilled).toBe(95)
  })

  test("never overwrites an end the client already wrote", async () => {
    const { t, userId } = await started()
    const endedAt = Date.now() - 5000
    await t.run(async (ctx) => {
      const [session] = await ctx.db
        .query("sessions")
        .withIndex("by_user", (q) => q.eq("userId", userId))
        .collect()
      await ctx.db.patch(session._id, { endedAt })
    })

    await t.mutation(internal.sessions.debit, {
      room,
      clerkId: "user_owner",
      jobId: "job_1",
      seconds: 90,
      seq: 1,
      final: true,
    })

    // `sessions.finish` wrote the outcome and the end; the worker's teardown
    // only ever fills in an end nobody else was going to.
    expect((await sessionsOf(t, userId))[0].endedAt).toBe(endedAt)
  })

  test("a final report frees the learner to start again", async () => {
    const { t, userId } = await started()

    // The crash case: no `sessions.finish`, so without the final debit this
    // learner would be locked out of their own account for fifteen minutes.
    await t.mutation(internal.sessions.debit, {
      room,
      clerkId: "user_owner",
      jobId: "job_1",
      seconds: 90,
      seq: 1,
      final: true,
    })

    await t
      .withIdentity({ subject: "user_owner" })
      .mutation(api.sessions.start, { room: "room-next", plan: PLAN })
    expect(await sessionsOf(t, userId)).toHaveLength(2)
  })

  test("refuses to charge a learner for a room they do not own", async () => {
    const { t, userId } = await started()
    await makeLearner(t, "user_other")

    await expect(
      t.mutation(internal.sessions.debit, {
        room,
        clerkId: "user_other",
        jobId: "job_1",
        seconds: 100,
        seq: 1,
      })
    ).rejects.toThrow(/Not this learner's room/)

    // Nothing written on either side of the refusal.
    expect(await debitsOf(t, userId)).toHaveLength(0)
    const [session] = await sessionsOf(t, userId)
    expect(session.secondsBilled).toBeUndefined()
  })

  test("adopts a room the app never recorded", async () => {
    const t = setup()
    const userId = await makeLearner(t, "user_owner")

    // A manual dispatch, or a token route that failed after minting. The
    // seconds were still spoken, so they are still billed.
    const result = await t.mutation(internal.sessions.debit, {
      room: "room-unrecorded",
      clerkId: "user_owner",
      jobId: "job_1",
      seconds: 42,
      seq: 1,
    })

    expect(result.balanceSeconds).toBe(GRANT - 42)
    expect(await sessionsOf(t, userId)).toHaveLength(1)
  })
})

describe("sessions.billedSecondsForRoom", () => {
  test("is what a starting job seeds its report base with", async () => {
    const t = setup()
    await makeLearner(t, "user_owner")
    await t
      .withIdentity({ subject: "user_owner" })
      .mutation(api.sessions.start, { room: "room-a", plan: PLAN })

    expect(
      await t.query(internal.sessions.billedSecondsForRoom, { room: "room-a" })
    ).toBe(0)

    await t.mutation(internal.sessions.debit, {
      room: "room-a",
      clerkId: "user_owner",
      jobId: "job_1",
      seconds: 90,
      seq: 1,
    })

    expect(
      await t.query(internal.sessions.billedSecondsForRoom, { room: "room-a" })
    ).toBe(90)
    // A room with no row has nothing to resume from.
    expect(
      await t.query(internal.sessions.billedSecondsForRoom, { room: "nope" })
    ).toBe(0)
  })
})

describe("sessions.reconcileStale", () => {
  test("closes an abandoned row at the last second the ledger can prove", async () => {
    const t = setup()
    const userId = await makeLearner(t, "user_owner")
    const startedAt = Date.now() - 3 * 60 * 60 * 1000

    const [abandoned, unbilled, recent] = await t.run(async (ctx) => [
      await ctx.db.insert("sessions", {
        userId,
        room: "room-abandoned",
        plan: PLAN,
        startedAt,
        secondsBilled: 120,
      }),
      await ctx.db.insert("sessions", {
        userId,
        room: "room-unbilled",
        plan: PLAN,
        startedAt,
      }),
      await ctx.db.insert("sessions", {
        userId,
        room: "room-live",
        plan: PLAN,
        startedAt: Date.now(),
      }),
    ])

    expect(await t.mutation(internal.sessions.reconcileStale, {})).toBe(2)

    const rows = await t.run(async (ctx) => ({
      abandoned: await ctx.db.get(abandoned),
      unbilled: await ctx.db.get(unbilled),
      recent: await ctx.db.get(recent),
    }))
    // Not `Date.now()`: that would invent hours nobody talked.
    expect(rows.abandoned!.endedAt).toBe(startedAt + 120_000)
    expect(rows.unbilled!.endedAt).toBe(startedAt)
    // A conversation that is happening right now is not abandoned.
    expect(rows.recent!.endedAt).toBeUndefined()
  })
})
