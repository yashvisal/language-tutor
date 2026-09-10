import { convexTest } from "convex-test"
import { describe, expect, test } from "vitest"

import { api, internal } from "./_generated/api"
import type { Doc, Id } from "./_generated/dataModel"
import schema from "./schema"
import type { sessionPlanValidator } from "./validators"
import {
  DELTA_CAP_PREFIX,
  LEASE_TTL_MS,
  MAX_DELTA_PER_CALL_S,
  MAX_STARTS_PER_HOUR,
  SIGNUP_GRANT_SECONDS,
  START_WINDOW_MS,
} from "../lib/billing"

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

const GRANT = SIGNUP_GRANT_SECONDS

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

/**
 * The worker joining a room. This is the only thing that opens a session row
 * now: the token route signs a token and writes nothing, so every test that
 * used to "start" a session by calling the client's mutation reaches the same
 * state by pretending a worker turned up. Internal, so there is no identity to
 * act as — the clerk id is the argument.
 */
function openRoom(
  t: TestConvex,
  clerkId: string,
  room: string,
  jobId = "job_1"
) {
  return t.mutation(internal.sessions.open, { room, clerkId, jobId, plan: PLAN })
}

/** This room's row, read straight out of the database. */
function roomRow(t: TestConvex, room: string) {
  return t.run(async (ctx) =>
    ctx.db
      .query("sessions")
      .withIndex("by_room", (q) => q.eq("room", room))
      .unique()
  )
}

/** Move a room's lease, standing in for time passing. */
async function setLease(t: TestConvex, room: string, leaseUntil: number) {
  const row = await roomRow(t, room)
  await t.run(async (ctx) => ctx.db.patch(row!._id, { leaseUntil }))
  return leaseUntil
}

/** Close a room's row the way the worker's final debit or the cron does. */
async function closeRoom(t: TestConvex, room: string, endedAt = Date.now()) {
  const row = await roomRow(t, room)
  await t.run(async (ctx) => ctx.db.patch(row!._id, { endedAt }))
  return endedAt
}

/**
 * Taking the lease.
 *
 * The row is the worker's now: it is inserted when the worker joins, not when
 * a token is minted, and the one-open-session guard is a LEASE rather than an
 * open flag. That changes what has to be true. A refusal is a returned code,
 * not an exception, because the worker on the other end has to leave politely;
 * and a row whose lease has run out must not lock a learner out of their own
 * account, because the worker holding it is dead.
 */
describe("sessions.open", () => {
  test("refuses a room another learner already owns", async () => {
    const t = setup()
    await makeLearner(t, "user_owner")
    await makeLearner(t, "user_attacker")

    const room = "lesson-owner-1-aaaa"
    await openRoom(t, "user_owner", room)

    // The exploit B1 describes: the room carries the debit's high-water mark,
    // so joining a room that has already been billed makes a fresh worker
    // clock report under the mark and debit nothing. This is the lock behind
    // the room name.
    await expect(openRoom(t, "user_attacker", room)).rejects.toThrow(
      /Not this learner's room/
    )
  })

  test("refuses a learner who has no account row", async () => {
    const t = setup()
    await expect(openRoom(t, "user_nobody", "room-a")).rejects.toThrow(
      /No such user/
    )
  })

  test("opens the row with a lease in the future", async () => {
    const t = setup()
    const userId = await makeLearner(t, "user_owner")

    const before = Date.now()
    expect(await openRoom(t, "user_owner", "room-a")).toEqual({
      ok: true,
      balanceSeconds: GRANT,
      secondsBilled: 0,
    })

    const [row] = await sessionsOf(t, userId)
    // The lease is what makes this row a live conversation: the guard below
    // reads it, and so does the cron.
    expect(row.leaseUntil).toBeGreaterThanOrEqual(before + LEASE_TTL_MS)
    expect(row.endedAt).toBeUndefined()
  })

  test("refuses a second conversation while one is live", async () => {
    const t = setup()
    const userId = await makeLearner(t, "user_owner")

    await openRoom(t, "user_owner", "room-a")

    // Two tabs, one balance: each worker budgets the *whole* balance, both
    // debit at teardown, and the ledger goes negative by (N-1) x balance.
    expect(await openRoom(t, "user_owner", "room-b")).toEqual({
      ok: false,
      code: "open_session",
    })
    // Refused means nothing written — the second worker gets no row to meter.
    expect(await sessionsOf(t, userId)).toHaveLength(1)
  })

  test("allows the next conversation once the open one has ended", async () => {
    const t = setup()
    const userId = await makeLearner(t, "user_owner")

    await openRoom(t, "user_owner", "room-a")
    await closeRoom(t, "room-a")

    expect((await openRoom(t, "user_owner", "room-b")).ok).toBe(true)
    expect(await sessionsOf(t, userId)).toHaveLength(2)
  })

  test("allows the next conversation once the lease has run out", async () => {
    const t = setup()
    const userId = await makeLearner(t, "user_owner")

    // A row nobody ever closed — a killed worker, a process that vanished.
    // The lease is a window, not a lock: a learner must not be shut out of
    // their own account by a crash while the reconciliation cron catches up.
    await openRoom(t, "user_owner", "room-a")
    await setLease(t, "room-a", Date.now() - 1000)

    expect((await openRoom(t, "user_owner", "room-b")).ok).toBe(true)
    expect(await sessionsOf(t, userId)).toHaveLength(2)
  })

  test("a row from before the lease existed does not block", async () => {
    const t = setup()
    const userId = await makeLearner(t, "user_owner")

    // Nothing renews a legacy row, so nothing would ever release it. It is not
    // live; the cron closes it by age instead.
    await t.run(async (ctx) => {
      await ctx.db.insert("sessions", {
        userId,
        room: "room-legacy",
        plan: PLAN,
        startedAt: Date.now(),
      })
    })

    expect((await openRoom(t, "user_owner", "room-b")).ok).toBe(true)
    expect(await sessionsOf(t, userId)).toHaveLength(2)
  })

  test("re-opening the same room renews the lease and hands back its meter", async () => {
    const t = setup()
    const userId = await makeLearner(t, "user_owner")
    const room = "room-a"

    await openRoom(t, "user_owner", room)
    await t.mutation(internal.sessions.debit, {
      room,
      clerkId: "user_owner",
      jobId: "job_1",
      seconds: 90,
      seq: 1,
    })
    const shortened = await setLease(t, room, Date.now() + 1000)

    // A renewal, or a redispatch after a crash: either way the worker needs
    // the room's high-water mark so its own reports stay room-cumulative
    // rather than restarting at zero under a mark of 90.
    expect(await openRoom(t, "user_owner", room, "job_2")).toEqual({
      ok: true,
      balanceSeconds: GRANT - 90,
      secondsBilled: 90,
    })

    const rows = await sessionsOf(t, userId)
    // One row, not two: two rows would give the debit two high-water marks.
    expect(rows).toHaveLength(1)
    expect(rows[0].leaseUntil).toBeGreaterThan(shortened)
  })

  test("refuses a room that has already ended", async () => {
    const t = setup()
    const userId = await makeLearner(t, "user_owner")

    await openRoom(t, "user_owner", "room-a")
    await closeRoom(t, "room-a")

    // A reused token. The room carries the debit's high-water mark, so a
    // worker re-joining one that was billed for N seconds would report under
    // the mark for its whole run and bill nothing.
    expect(await openRoom(t, "user_owner", "room-a", "job_2")).toEqual({
      ok: false,
      code: "closed",
    })
    expect(await sessionsOf(t, userId)).toHaveLength(1)
  })

  test("one learner's live session does not block another's", async () => {
    const t = setup()
    await makeLearner(t, "user_a")
    const userB = await makeLearner(t, "user_b")

    await openRoom(t, "user_a", "room-a")
    expect((await openRoom(t, "user_b", "room-b")).ok).toBe(true)

    expect(await sessionsOf(t, userB)).toHaveLength(1)
  })
})

/**
 * The hourly start limit (audit B12).
 *
 * The grant is per Clerk id and signup is instant, so the only thing between
 * a script and N accounts x five free minutes is how fast one account can mint
 * rooms. These tests are written as the two populations the number has to
 * separate: a learner who really does start a dozen conversations, and one
 * who is not a learner.
 *
 * Every start here is closed before the next, so what is being tested is the
 * rate limit and never the one-open-session guard sitting in front of it.
 */
describe("sessions.open rate limit", () => {
  /** Open a conversation and close it, the way a learner who finishes one and
   * begins another leaves the table. */
  async function startAndEnd(t: TestConvex, clerkId: string, room: string) {
    await openRoom(t, clerkId, room)
    await closeRoom(t, room)
  }

  test("allows the whole hour's allowance and refuses the one after it", async () => {
    const t = setup()
    const userId = await makeLearner(t, "user_owner")

    for (let i = 0; i < MAX_STARTS_PER_HOUR; i++) {
      await startAndEnd(t, "user_owner", `room-${i}`)
    }
    // The limit is a ceiling on a *scripted* rate, so the last legitimate
    // start has to land: a learner retrying a failed connect a few times must
    // never meet it.
    expect(await sessionsOf(t, userId)).toHaveLength(MAX_STARTS_PER_HOUR)

    expect(await openRoom(t, "user_owner", "room-over")).toEqual({
      ok: false,
      code: "rate_limited",
    })
    // Refused means nothing written: a refused start must not itself count
    // toward the window, or the limit would never lift.
    expect(await sessionsOf(t, userId)).toHaveLength(MAX_STARTS_PER_HOUR)
  })

  test("starts older than the window do not count", async () => {
    const t = setup()
    const userId = await makeLearner(t, "user_owner")

    // A full allowance, but yesterday's. The window rolls; it is not a quota.
    const old = Date.now() - START_WINDOW_MS - 60_000
    await t.run(async (ctx) => {
      for (let i = 0; i < MAX_STARTS_PER_HOUR; i++) {
        await ctx.db.insert("sessions", {
          userId,
          room: `old-${i}`,
          plan: PLAN,
          startedAt: old,
          endedAt: old + 60_000,
        })
      }
    })

    expect((await openRoom(t, "user_owner", "room-today")).ok).toBe(true)
    expect(await sessionsOf(t, userId)).toHaveLength(MAX_STARTS_PER_HOUR + 1)
  })

  test("one learner's starts are not counted against another's", async () => {
    const t = setup()
    await makeLearner(t, "user_a")
    const userB = await makeLearner(t, "user_b")

    for (let i = 0; i < MAX_STARTS_PER_HOUR; i++) {
      await startAndEnd(t, "user_a", `a-${i}`)
    }

    // The limit is per learner, and it is read off `by_user_startedAt` with
    // the user id fixed — a busy neighbour cannot lock anyone else out.
    expect((await openRoom(t, "user_b", "b-0")).ok).toBe(true)
    expect(await sessionsOf(t, userB)).toHaveLength(1)
  })

  test("a second tab still hears 'already open', not the limit", async () => {
    const t = setup()
    await makeLearner(t, "user_owner")

    // The allowance is exactly used up AND the last one is still live. Both
    // refusals apply; the learner must get the one they can act on.
    for (let i = 0; i < MAX_STARTS_PER_HOUR - 1; i++) {
      await startAndEnd(t, "user_owner", `room-${i}`)
    }
    await openRoom(t, "user_owner", "room-open")

    expect(await openRoom(t, "user_owner", "room-next")).toEqual({
      ok: false,
      code: "open_session",
    })
  })
})

/**
 * The token route's pre-check. It is a READ, and it can be stale by the time a
 * worker joins — `open` is the check that counts. This exists so a learner
 * with a second tab hears "you already have one running" before a token is
 * minted, rather than from a worker that turned up and left again.
 */
describe("sessions.startCheck", () => {
  const check = (t: TestConvex, clerkId: string) =>
    t.withIdentity({ subject: clerkId }).query(api.sessions.startCheck, {})

  test("says so when the learner has no account row yet", async () => {
    const t = setup()
    // Signed in at Clerk, but `users.ensureUser` has not landed. The route
    // needs to tell those apart from a refusal.
    expect(await check(t, "user_new")).toBe("no_account")
  })

  test("is ok for a learner with nothing running", async () => {
    const t = setup()
    await makeLearner(t, "user_owner")
    expect(await check(t, "user_owner")).toBe("ok")
  })

  test("reports a live conversation", async () => {
    const t = setup()
    await makeLearner(t, "user_owner")
    await openRoom(t, "user_owner", "room-a")
    expect(await check(t, "user_owner")).toBe("open_session")

    // ...and stops reporting one the moment the lease runs out, so a crash
    // does not lock the learner out of their own account.
    await setLease(t, "room-a", Date.now() - 1000)
    expect(await check(t, "user_owner")).toBe("ok")
  })

  test("reports the hourly limit", async () => {
    const t = setup()
    const userId = await makeLearner(t, "user_owner")
    const now = Date.now()
    await t.run(async (ctx) => {
      for (let i = 0; i < MAX_STARTS_PER_HOUR; i++) {
        await ctx.db.insert("sessions", {
          userId,
          room: `room-${i}`,
          plan: PLAN,
          startedAt: now - 1000,
          endedAt: now - 500,
        })
      }
    })
    expect(await check(t, "user_owner")).toBe("rate_limited")
  })
})

describe("sessions.debit", () => {
  const room = "lesson-owner-1-aaaa"

  async function started(clerkId = "user_owner") {
    const t = setup()
    const userId = await makeLearner(t, clerkId)
    await openRoom(t, clerkId, room)
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

  test("refuses a report that would add more than the per-call cap", async () => {
    const { t, userId } = await started()

    await t.mutation(internal.sessions.debit, {
      room,
      clerkId: "user_owner",
      jobId: "job_1",
      seconds: 100,
      seq: 1,
    })

    // 100 → 3701 is +3601: one second over what one call may add. The
    // cadence is 60 s and five failures end the session, so this is never a
    // legitimate catch-up — it is refused whole, and the mark does not move.
    await expect(
      t.mutation(internal.sessions.debit, {
        room,
        clerkId: "user_owner",
        jobId: "job_1",
        seconds: 3701,
        seq: 2,
      })
    ).rejects.toThrow(DELTA_CAP_PREFIX)

    expect(await debitsOf(t, userId)).toHaveLength(1)
    const [session] = await sessionsOf(t, userId)
    expect(session.secondsBilled).toBe(100)

    // Exactly the cap is still fine.
    const result = await t.mutation(internal.sessions.debit, {
      room,
      clerkId: "user_owner",
      jobId: "job_1",
      seconds: 100 + MAX_DELTA_PER_CALL_S,
      seq: 3,
    })
    expect(result.balanceSeconds).toBe(GRANT - 100 - MAX_DELTA_PER_CALL_S)
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

  test("a periodic report renews the lease and a final one does not", async () => {
    const { t, userId } = await started()
    const shortened = await setLease(t, room, Date.now() + 1000)

    // A worker that is debiting is a worker that is alive, so the renewal
    // comes for free with the report and the cron leaves the row alone.
    await t.mutation(internal.sessions.debit, {
      room,
      clerkId: "user_owner",
      jobId: "job_1",
      seconds: 60,
      seq: 1,
    })
    const live = (await sessionsOf(t, userId))[0]
    expect(live.leaseUntil).toBeGreaterThan(shortened)
    expect(live.endedAt).toBeUndefined()

    // The last report closes the row instead. It leaves the lease where it
    // was: `endedAt` is what makes a row history, and a closed row is not
    // live whatever its lease says.
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
    expect(closed.leaseUntil).toBe(live.leaseUntil)
  })

  test("never overwrites an end somebody already wrote", async () => {
    const { t, userId } = await started()
    const endedAt = await closeRoom(t, room, Date.now() - 5000)

    await t.mutation(internal.sessions.debit, {
      room,
      clerkId: "user_owner",
      jobId: "job_1",
      seconds: 90,
      seq: 1,
      final: true,
    })

    // The cron closed this row when its lease ran out; a redispatched job's
    // teardown is guessing about a session it did not see end.
    expect((await sessionsOf(t, userId))[0].endedAt).toBe(endedAt)
  })

  test("a final report frees the learner to start again", async () => {
    const { t, userId } = await started()

    // The crash case: the browser's `finish` no longer closes anything, so
    // without the final debit this learner waits out the whole lease.
    await t.mutation(internal.sessions.debit, {
      room,
      clerkId: "user_owner",
      jobId: "job_1",
      seconds: 90,
      seq: 1,
      final: true,
    })

    expect((await openRoom(t, "user_owner", "room-next")).ok).toBe(true)
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
    const rows = await sessionsOf(t, userId)
    expect(rows).toHaveLength(1)
    // The adopted row is a live conversation like any other: something is
    // metering it, so it holds a lease and the cron will not close it.
    expect(rows[0].leaseUntil).toBeGreaterThan(Date.now())
  })
})

describe("sessions.billedSecondsForRoom", () => {
  test("is what a starting job seeds its report base with", async () => {
    const t = setup()
    await makeLearner(t, "user_owner")
    await openRoom(t, "user_owner", "room-a")

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
  test("closes a row whose lease ran out, at the last second the ledger can prove", async () => {
    const t = setup()
    const userId = await makeLearner(t, "user_owner")
    const now = Date.now()
    const startedAt = now - 3 * 60 * 60 * 1000
    const expired = now - 1000

    const [abandoned, unbilled, justDied, live] = await t.run(async (ctx) => [
      await ctx.db.insert("sessions", {
        userId,
        room: "room-abandoned",
        plan: PLAN,
        startedAt,
        leaseUntil: expired,
        secondsBilled: 120,
      }),
      await ctx.db.insert("sessions", {
        userId,
        room: "room-unbilled",
        plan: PLAN,
        startedAt,
        leaseUntil: expired,
      }),
      // Age is not the question any more: a worker that died a minute into a
      // conversation leaves a row that is minutes old and already dead.
      await ctx.db.insert("sessions", {
        userId,
        room: "room-just-died",
        plan: PLAN,
        startedAt: now - 60_000,
        leaseUntil: expired,
        secondsBilled: 30,
      }),
      // ...and neither is age a reason to close one. A long conversation with
      // a worker still renewing it is a conversation.
      await ctx.db.insert("sessions", {
        userId,
        room: "room-live",
        plan: PLAN,
        startedAt,
        leaseUntil: now + LEASE_TTL_MS,
      }),
    ])

    expect(await t.mutation(internal.sessions.reconcileStale, {})).toBe(3)

    const rows = await t.run(async (ctx) => ({
      abandoned: await ctx.db.get(abandoned),
      unbilled: await ctx.db.get(unbilled),
      justDied: await ctx.db.get(justDied),
      live: await ctx.db.get(live),
    }))
    // Not `Date.now()`: that would invent hours nobody talked.
    expect(rows.abandoned!.endedAt).toBe(startedAt + 120_000)
    expect(rows.unbilled!.endedAt).toBe(startedAt)
    expect(rows.justDied!.endedAt).toBe(now - 60_000 + 30_000)
    expect(rows.live!.endedAt).toBeUndefined()
    // ...and it says so. A row the cron swept up used to be indistinguishable
    // on the History card from a row written before `endReason` existed, and
    // the two are not the same fact.
    expect(rows.abandoned!.endReason).toBe("stale")
    expect(rows.unbilled!.endReason).toBe("stale")
    expect(rows.justDied!.endReason).toBe("stale")
    expect(rows.live!.endReason).toBeUndefined()
  })

  test("sweeps a row from before the lease existed by age alone", async () => {
    const t = setup()
    const userId = await makeLearner(t, "user_owner")
    const now = Date.now()

    // A legacy row carries no lease, so "the lease ran out" says nothing
    // about it. Nothing renews it either, so the only honest test left is
    // whether it is older than any real conversation.
    const [young, old] = await t.run(async (ctx) => [
      await ctx.db.insert("sessions", {
        userId,
        room: "room-legacy-young",
        plan: PLAN,
        startedAt: now - 60 * 60 * 1000,
      }),
      await ctx.db.insert("sessions", {
        userId,
        room: "room-legacy-old",
        plan: PLAN,
        startedAt: now - 3 * 60 * 60 * 1000,
        secondsBilled: 60,
      }),
    ])

    expect(await t.mutation(internal.sessions.reconcileStale, {})).toBe(1)

    const rows = await t.run(async (ctx) => ({
      young: await ctx.db.get(young),
      old: await ctx.db.get(old),
    }))
    expect(rows.young!.endedAt).toBeUndefined()
    expect(rows.old!.endedAt).toBe(now - 3 * 60 * 60 * 1000 + 60_000)
    expect(rows.old!.endReason).toBe("stale")
  })

  test("never overwrites a reason somebody who was there already gave", async () => {
    const t = setup()
    const userId = await makeLearner(t, "user_owner")
    const startedAt = Date.now() - 3 * 60 * 60 * 1000

    // The worker's teardown report writes the reason WITHOUT `endedAt` when
    // the client already closed the row — so a row can reach the cron
    // explained and still open. That explanation beats this one.
    const explained = await t.run(async (ctx) =>
      ctx.db.insert("sessions", {
        userId,
        room: "room-explained",
        plan: PLAN,
        startedAt,
        secondsBilled: 60,
        endReason: "model_error" as const,
      })
    )

    expect(await t.mutation(internal.sessions.reconcileStale, {})).toBe(1)

    const row = await t.run(async (ctx) => ctx.db.get(explained))
    expect(row!.endReason).toBe("model_error")
    expect(row!.endedAt).toBe(startedAt + 60_000)
  })
})

/* -------------------------------------------------------------------------- */
/*  The after-session record                                                  */
/* -------------------------------------------------------------------------- */

const REVIEW = {
  vocab: [{ target: "la cuenta", anchor: "the bill" }],
  phrases: [{ target: "para llevar", anchor: "to go" }],
  tables: [
    {
      verb: "querer",
      tense: "present",
      rows: [{ person: "yo", form: "quiero" }],
    },
  ],
}

describe("sessions.recordSummary", () => {
  const room = "lesson-owner-1-aaaa"

  test("writes the record onto the row the token minted", async () => {
    const t = setup()
    const userId = await makeLearner(t, "user_owner")
    await openRoom(t, "user_owner", room)

    await t.mutation(internal.sessions.recordSummary, {
      room,
      clerkId: "user_owner",
      about: "Ordering at a cafe.",
      transcript: [
        { role: "learner", text: "hola" },
        { role: "tutor", text: "buenas" },
      ],
      review: REVIEW,
    })

    // One row, not a second one keyed on the same name.
    const rows = await sessionsOf(t, userId)
    expect(rows).toHaveLength(1)
    expect(rows[0].about).toBe("Ordering at a cafe.")
    expect(rows[0].transcript).toHaveLength(2)
    expect(rows[0].review?.vocab[0].target).toBe("la cuenta")
    // The record is not the meter, and it is not the end of the session.
    expect(rows[0].secondsBilled).toBeUndefined()
    expect(rows[0].endedAt).toBeUndefined()
  })

  test("adopts a room the app never recorded", async () => {
    const t = setup()
    const userId = await makeLearner(t, "user_owner")

    await t.mutation(internal.sessions.recordSummary, {
      room: "room-unrecorded",
      clerkId: "user_owner",
      about: "A conversation nobody wrote a row for.",
    })

    const rows = await sessionsOf(t, userId)
    expect(rows).toHaveLength(1)
    expect(rows[0].about).toBe("A conversation nobody wrote a row for.")
  })

  test("leaves a field absent from the call untouched", async () => {
    const t = setup()
    const userId = await makeLearner(t, "user_owner")

    await t.mutation(internal.sessions.recordSummary, {
      room,
      clerkId: "user_owner",
      transcript: [{ role: "learner", text: "hola" }],
    })
    // The Review finished generating after the transcript was sent. Sending it
    // on its own must not erase what the first call wrote.
    await t.mutation(internal.sessions.recordSummary, {
      room,
      clerkId: "user_owner",
      review: REVIEW,
    })

    const [row] = await sessionsOf(t, userId)
    expect(row.transcript).toHaveLength(1)
    expect(row.review?.phrases[0].anchor).toBe("to go")

    // Sending a field again replaces it wholesale — there is no merge.
    await t.mutation(internal.sessions.recordSummary, {
      room,
      clerkId: "user_owner",
      transcript: [
        { role: "learner", text: "adios" },
        { role: "tutor", text: "hasta luego" },
      ],
    })
    const [after] = await sessionsOf(t, userId)
    expect(after.transcript?.map((turn) => turn.text)).toEqual([
      "adios",
      "hasta luego",
    ])
  })

  test("clamps a record that is merely long instead of refusing it", async () => {
    const t = setup()
    const userId = await makeLearner(t, "user_owner")

    await t.mutation(internal.sessions.recordSummary, {
      room,
      clerkId: "user_owner",
      about: "a".repeat(500),
      transcript: Array.from({ length: 260 }, () => ({
        role: "learner" as const,
        text: "b".repeat(900),
      })),
      review: {
        vocab: Array.from({ length: 60 }, () => ({
          target: "c".repeat(400),
          anchor: "d",
        })),
        phrases: [],
        tables: Array.from({ length: 20 }, () => ({
          verb: "querer",
          tense: "present",
          rows: Array.from({ length: 40 }, () => ({
            person: "yo",
            form: "quiero",
          })),
        })),
      },
    })

    const [row] = await sessionsOf(t, userId)
    expect(row.about).toHaveLength(200)
    expect(row.transcript).toHaveLength(200)
    expect(row.transcript?.[0].text).toHaveLength(500)
    expect(row.review?.vocab).toHaveLength(40)
    expect(row.review?.vocab[0].target).toHaveLength(200)
    expect(row.review?.tables).toHaveLength(8)
    expect(row.review?.tables[0].rows).toHaveLength(12)
  })

  test("refuses to write into another learner's room", async () => {
    const t = setup()
    const userId = await makeLearner(t, "user_owner")
    await makeLearner(t, "user_other")
    await openRoom(t, "user_owner", room)

    // A leaked secret must not let one account's transcript be written into
    // another account's history.
    await expect(
      t.mutation(internal.sessions.recordSummary, {
        room,
        clerkId: "user_other",
        about: "not yours",
      })
    ).rejects.toThrow(/Not this learner's room/)

    expect((await sessionsOf(t, userId))[0].about).toBeUndefined()
  })

  test("refuses an unknown learner", async () => {
    const t = setup()
    await expect(
      t.mutation(internal.sessions.recordSummary, {
        room,
        clerkId: "user_nobody",
        about: "hello",
      })
    ).rejects.toThrow(/No such user/)
  })

  test("lands either side of the final debit", async () => {
    // Summary first, then the debit onto the row the summary created.
    const before = setup()
    await makeLearner(before, "user_owner")
    await before.mutation(internal.sessions.recordSummary, {
      room,
      clerkId: "user_owner",
      about: "summary arrived first",
      review: REVIEW,
    })
    await before.mutation(internal.sessions.debit, {
      room,
      clerkId: "user_owner",
      jobId: "job_1",
      seconds: 90,
      seq: 1,
      final: true,
    })

    // Debit first, then the summary onto the row the debit created.
    const after = setup()
    await makeLearner(after, "user_owner")
    await after.mutation(internal.sessions.debit, {
      room,
      clerkId: "user_owner",
      jobId: "job_1",
      seconds: 90,
      seq: 1,
      final: true,
    })
    await after.mutation(internal.sessions.recordSummary, {
      room,
      clerkId: "user_owner",
      about: "summary arrived second",
      review: REVIEW,
    })

    for (const [t, about] of [
      [before, "summary arrived first"],
      [after, "summary arrived second"],
    ] as const) {
      const row = await t.run(async (ctx) =>
        ctx.db
          .query("sessions")
          .withIndex("by_room", (q) => q.eq("room", room))
          .unique()
      )
      // The same record either way: one row, the meter intact, the record
      // intact, and the row closed.
      expect(row!.about).toBe(about)
      expect(row!.review?.vocab).toHaveLength(1)
      expect(row!.secondsBilled).toBe(90)
      expect(row!.endedAt).toBeTypeOf("number")
    }
  })
})

describe("sessions.byRoom", () => {
  const room = "lesson-owner-1-aaaa"

  test("is the one record the summary and the History modal both read", async () => {
    const t = setup()
    await makeLearner(t, "user_owner")
    const as = t.withIdentity({ subject: "user_owner" })
    await openRoom(t, "user_owner", room)
    await t.mutation(internal.sessions.recordSummary, {
      room,
      clerkId: "user_owner",
      about: "Ordering at a cafe.",
      transcript: [{ role: "learner", text: "hola" }],
      review: REVIEW,
    })
    await t.mutation(internal.sessions.debit, {
      room,
      clerkId: "user_owner",
      jobId: "job_1",
      seconds: 90,
      seq: 1,
      final: true,
    })

    const record = await as.query(api.sessions.byRoom, { room })
    expect(record).not.toBeNull()
    expect(record!.about).toBe("Ordering at a cafe.")
    expect(record!.transcript).toHaveLength(1)
    expect(record!.review?.tables[0].verb).toBe("querer")
    expect(record!.secondsBilled).toBe(90)
    expect(record!.plan.topic).toBe("food")
    expect(record!.endedAt).toBeTypeOf("number")
  })

  test("a row with nothing written yet comes back as explicit nulls", async () => {
    const t = setup()
    await makeLearner(t, "user_owner")
    const as = t.withIdentity({ subject: "user_owner" })
    await openRoom(t, "user_owner", room)

    const record = await as.query(api.sessions.byRoom, { room })
    expect(record).toMatchObject({
      about: null,
      transcript: null,
      review: null,
      outcome: null,
      secondsBilled: 0,
      endedAt: null,
    })
  })

  test("is null for another learner's room, an unknown room, and signed out", async () => {
    const t = setup()
    await makeLearner(t, "user_owner")
    await makeLearner(t, "user_other")
    await openRoom(t, "user_owner", room)
    await t.mutation(internal.sessions.recordSummary, {
      room,
      clerkId: "user_owner",
      transcript: [{ role: "learner", text: "something private" }],
    })

    // Room names are guessable enough that "this exists but is not yours" is a
    // fact worth not confirming — and the transcript is unreadable either way.
    expect(
      await t
        .withIdentity({ subject: "user_other" })
        .query(api.sessions.byRoom, { room })
    ).toBeNull()
    expect(
      await t
        .withIdentity({ subject: "user_owner" })
        .query(api.sessions.byRoom, { room: "room-nonexistent" })
    ).toBeNull()
    expect(await t.query(api.sessions.byRoom, { room })).toBeNull()
  })

  test("carries the session's cost, which is never null once reported", async () => {
    const t = setup()
    await makeLearner(t, "user_owner")
    const as = t.withIdentity({ subject: "user_owner" })
    await openRoom(t, "user_owner", room)

    // Nothing renders `estCostUsd` — it is what the session COST to run, not
    // what the learner was billed. It rides this query because this is the one
    // read of a whole session, and `null` until the worker reports one.
    expect(
      (await as.query(api.sessions.byRoom, { room }))!.estCostUsd
    ).toBeNull()

    await t.mutation(internal.sessions.recordSummary, {
      room,
      clerkId: "user_owner",
      estCostUsd: 0.4213,
    })
    expect((await as.query(api.sessions.byRoom, { room }))!.estCostUsd).toBe(
      0.4213
    )

    // Floored at zero, and a non-finite cost is dropped rather than stored as
    // 0: a column that gets summed is worthless if it can hold NaN, and a
    // wrong cost is worse than a missing one.
    await t.mutation(internal.sessions.recordSummary, {
      room,
      clerkId: "user_owner",
      estCostUsd: -5,
    })
    expect((await as.query(api.sessions.byRoom, { room }))!.estCostUsd).toBe(0)
    await t.mutation(internal.sessions.recordSummary, {
      room,
      clerkId: "user_owner",
      estCostUsd: Number.NaN,
    })
    expect((await as.query(api.sessions.byRoom, { room }))!.estCostUsd).toBe(0)
  })
})

describe("sessions.history", () => {
  test("a conversation the learner just ended is listed before the worker closes it", async () => {
    const t = setup()
    const userId = await makeLearner(t, "user_owner")
    const now = Date.now()
    await t.run(async (ctx) => {
      // Ended by the learner, not yet closed by the worker: the row the home
      // page must show the moment they land on it.
      await ctx.db.insert("sessions", {
        userId,
        room: "room-ending",
        plan: PLAN,
        startedAt: now - 300_000,
        leaseUntil: now + 100_000,
        secondsBilled: 180,
        outcome: { corrections: [], secondsTalked: 221, endedByClock: false },
        corrections: 0,
      })
      // Still being talked in: nothing from either half. Not history.
      await ctx.db.insert("sessions", {
        userId,
        room: "room-live",
        plan: PLAN,
        startedAt: now - 60_000,
        leaseUntil: now + 100_000,
        secondsBilled: 30,
      })
      // Closed by the worker earlier tonight.
      await ctx.db.insert("sessions", {
        userId,
        room: "room-done",
        plan: PLAN,
        startedAt: now - 3_600_000,
        endedAt: now - 3_400_000,
        secondsBilled: 200,
        about: "earlier",
      })
    })

    const rows = await t
      .withIdentity({ subject: "user_owner" })
      .query(api.sessions.history, {})
    expect(rows.map((row) => row.room)).toEqual(["room-ending", "room-done"])
    // The worker's number, where it has one, over the browser's.
    expect(rows[0].secondsTalked).toBe(180)
    // No close yet, so the nearest honest end: start plus what was talked.
    expect(rows[0].endedAt).toBe(now - 300_000 + 221_000)
  })

  test("pages finished rows even behind a run of abandoned ones", async () => {
    const t = setup()
    const userId = await makeLearner(t, "user_owner")
    const base = Date.now() - 10_000_000

    await t.run(async (ctx) => {
      // Forty abandoned rows, started AFTER every finished one: under the old
      // take(limit * 2)-then-filter-in-JS shape these filled the page and
      // pushed real conversations out of the learner's own history.
      for (let i = 0; i < 40; i++) {
        await ctx.db.insert("sessions", {
          userId,
          room: `room-open-${i}`,
          plan: PLAN,
          startedAt: base + 5_000_000 + i,
        })
      }
      for (let i = 0; i < 35; i++) {
        await ctx.db.insert("sessions", {
          userId,
          room: `room-done-${i}`,
          plan: PLAN,
          startedAt: base + i * 1000,
          endedAt: base + i * 1000 + 500,
          secondsBilled: 60,
          about: `conversation ${i}`,
        })
      }
    })

    const rows = await t
      .withIdentity({ subject: "user_owner" })
      .query(api.sessions.history, {})

    expect(rows).toHaveLength(30)
    // Newest finished first, and every one of them finished.
    expect(rows.every((row) => row.endedAt > 0)).toBe(true)
    expect(rows[0].about).toBe("conversation 34")
    expect(rows[29].about).toBe("conversation 5")
  })

  test("carries the one-line about, null where nobody wrote one", async () => {
    const t = setup()
    const userId = await makeLearner(t, "user_owner")
    await t.run(async (ctx) => {
      await ctx.db.insert("sessions", {
        userId,
        room: "room-old",
        plan: PLAN,
        startedAt: 1000,
        endedAt: 2000,
        secondsBilled: 30,
      })
      await ctx.db.insert("sessions", {
        userId,
        room: "room-new",
        plan: PLAN,
        startedAt: 3000,
        endedAt: 4000,
        secondsBilled: 30,
        about: "Ordering at a cafe.",
      })
    })

    const rows = await t
      .withIdentity({ subject: "user_owner" })
      .query(api.sessions.history, {})
    expect(rows.map((row) => row.about)).toEqual(["Ordering at a cafe.", null])
  })

  test("shows one learner nothing of another's", async () => {
    const t = setup()
    const userId = await makeLearner(t, "user_owner")
    await makeLearner(t, "user_other")
    await t.run(async (ctx) => {
      await ctx.db.insert("sessions", {
        userId,
        room: "room-done",
        plan: PLAN,
        startedAt: 1000,
        endedAt: 2000,
        about: "private",
      })
    })

    expect(
      await t
        .withIdentity({ subject: "user_other" })
        .query(api.sessions.history, {})
    ).toEqual([])
  })
})

describe("sessions.costReport", () => {
  test("totals model cost against billed minutes per day, and counts the unpriced", async () => {
    const t = setup()
    const userId = await makeLearner(t, "user_owner")
    const day = Date.UTC(2026, 8, 8, 6, 0, 0)
    await t.run(async (ctx) => {
      await ctx.db.insert("sessions", {
        userId,
        room: "room-a",
        plan: PLAN,
        startedAt: day,
        endedAt: day + 221_000,
        secondsBilled: 221,
        estCostUsd: 0.4176,
      })
      await ctx.db.insert("sessions", {
        userId,
        room: "room-b",
        plan: PLAN,
        startedAt: day + 3_600_000,
        endedAt: day + 3_700_000,
        secondsBilled: 79,
      })
      await ctx.db.insert("sessions", {
        userId,
        room: "room-open",
        plan: PLAN,
        startedAt: day + 7_200_000,
        secondsBilled: 10,
      })
    })

    const report = await t.query(internal.sessions.costReport, { days: 36500 })
    expect(report).toEqual([
      {
        day: "2026-09-08",
        sessions: 2,
        unpriced: 1,
        billedSeconds: 300,
        estCostUsd: 0.4176,
        usdPerBilledMinute: 0.0835,
      },
    ])
  })
})

describe("the corrections backstop", () => {
  const room = "lesson-owner-1-aaaa"

  const CORRECTION = {
    id: "c1",
    original: "yo va",
    replacement: "yo voy",
    category: "agreement",
    severity: "error",
    explanation: "First person of ir is voy.",
  }

  const OUTCOME = {
    corrections: [{ ...CORRECTION, id: "c-client" }],
    secondsTalked: 87,
    endedByClock: true,
  }

  async function started(t: TestConvex) {
    await makeLearner(t, "user_owner")
    const as = t.withIdentity({ subject: "user_owner" })
    await openRoom(t, "user_owner", room)
    return as
  }

  function rowOf(t: TestConvex) {
    return t.run(async (ctx) =>
      ctx.db
        .query("sessions")
        .withIndex("by_room", (q) => q.eq("room", room))
        .unique()
    )
  }

  test("the worker's outcome stands until the client overwrites it", async () => {
    const t = setup()
    const as = await started(t)

    await t.mutation(internal.sessions.recordSummary, {
      room,
      clerkId: "user_owner",
      corrections: [CORRECTION],
    })
    expect((await rowOf(t))!.outcome?.corrections[0].id).toBe("c1")

    // The tab came back — or never left. The client knows the real
    // `secondsTalked` and whether the clock ended it; the worker was guessing.
    await as.mutation(api.sessions.finish, { room, outcome: OUTCOME })

    const row = await rowOf(t)
    expect(row!.outcome?.corrections[0].id).toBe("c-client")
    expect(row!.outcome?.secondsTalked).toBe(87)
    expect(row!.outcome?.endedByClock).toBe(true)
    expect(row!.corrections).toBe(1)
  })

  test("a client outcome is never overwritten by the worker's", async () => {
    const t = setup()
    const as = await started(t)

    await as.mutation(api.sessions.finish, { room, outcome: OUTCOME })
    await t.mutation(internal.sessions.recordSummary, {
      room,
      clerkId: "user_owner",
      about: "Ordering at a cafe.",
      corrections: [CORRECTION],
    })

    const row = await rowOf(t)
    // The record stays the client's, whole.
    expect(row!.outcome?.corrections[0].id).toBe("c-client")
    expect(row!.outcome?.secondsTalked).toBe(87)
    expect(row!.outcome?.endedByClock).toBe(true)
    // Everything else on the same call still lands.
    expect(row!.about).toBe("Ordering at a cafe.")
  })

  test("a tab that never finished still gets a record, metered", async () => {
    const t = setup()
    await started(t)

    // The crash: no `finish`, ever. The worker's teardown is the only writer.
    await t.mutation(internal.sessions.debit, {
      room,
      clerkId: "user_owner",
      jobId: "job_1",
      seconds: 137,
      seq: 1,
      final: true,
    })
    await t.mutation(internal.sessions.recordSummary, {
      room,
      clerkId: "user_owner",
      about: "Ordering at a cafe.",
      corrections: [CORRECTION],
    })

    const row = await rowOf(t)
    // `secondsTalked` is what the meter can prove, not an invention.
    expect(row!.outcome?.secondsTalked).toBe(137)
    expect(row!.outcome?.endedByClock).toBe(false)
    expect(row!.corrections).toBe(1)

    // And it reaches the surfaces: the History list counts it, the record reads.
    const rows = await t
      .withIdentity({ subject: "user_owner" })
      .query(api.sessions.history, {})
    expect(rows).toHaveLength(1)
    expect(rows[0].corrections).toHaveLength(1)
    expect(rows[0].secondsTalked).toBe(137)
    expect(rows[0].about).toBe("Ordering at a cafe.")
  })
})

/**
 * The browser's half of the record — and only that half.
 *
 * `finish` used to write `endedAt`, and `start` read it as proof the
 * conversation was over: a client that called it on a running room and then
 * started another had two workers spending one balance (audit 2026-09-06,
 * L1). Closing a tab is a request to end. The worker's final debit is the
 * proof, so what is tested here is as much what `finish` no longer does.
 */
describe("sessions.finish", () => {
  const room = "lesson-owner-1-aaaa"

  const OUTCOME = {
    corrections: [
      {
        id: "c1",
        original: "yo va",
        replacement: "yo voy",
        category: "agreement",
        severity: "error",
        explanation: "First person of ir is voy.",
      },
    ],
    secondsTalked: 87,
    endedByClock: true,
  }

  test("writes the outcome and the count, and leaves the row open", async () => {
    const t = setup()
    await makeLearner(t, "user_owner")
    const as = t.withIdentity({ subject: "user_owner" })
    await openRoom(t, "user_owner", room)

    await as.mutation(api.sessions.finish, { room, outcome: OUTCOME })

    const row = await roomRow(t, room)
    expect(row!.outcome?.corrections[0].id).toBe("c1")
    expect(row!.corrections).toBe(1)
    // The row is still live: the lease is untouched and nothing has closed it,
    // so the learner cannot start a second conversation by closing the tab.
    expect(row!.endedAt).toBeUndefined()
    expect(await openRoom(t, "user_owner", "room-next")).toEqual({
      ok: false,
      code: "open_session",
    })
  })

  test("the row reaches History the moment the learner ends it, and the worker's close fills it in", async () => {
    const t = setup()
    await makeLearner(t, "user_owner")
    const as = t.withIdentity({ subject: "user_owner" })
    await openRoom(t, "user_owner", room)

    await as.mutation(api.sessions.finish, { room, outcome: OUTCOME })
    // Listed from what the browser wrote: the learner is looking at the home
    // page now, and the worker's close is a reconnect grace away.
    const early = await as.query(api.sessions.history, {})
    expect(early).toHaveLength(1)
    expect(early[0].secondsTalked).toBe(OUTCOME.secondsTalked)

    await t.mutation(internal.sessions.debit, {
      room,
      clerkId: "user_owner",
      jobId: "job_1",
      seconds: 90,
      seq: 1,
      final: true,
    })

    const rows = await as.query(api.sessions.history, {})
    expect(rows).toHaveLength(1)
    // The worker's number, not the browser's 87: it is what was charged, and
    // the browser cannot write it.
    expect(rows[0].secondsTalked).toBe(90)
  })

  test("is a silent no-op on a room the learner does not own", async () => {
    const t = setup()
    const userId = await makeLearner(t, "user_owner")
    await makeLearner(t, "user_other")
    await openRoom(t, "user_owner", room)

    // Nothing on the summary screen should break because a record is missing
    // — but nothing of somebody else's should be written either.
    await t
      .withIdentity({ subject: "user_other" })
      .mutation(api.sessions.finish, { room, outcome: OUTCOME })

    expect((await sessionsOf(t, userId))[0].outcome).toBeUndefined()
  })
})

/**
 * Step 3's half of the after-session record: what was set up, how much was
 * done, and why it stopped.
 *
 * Same three properties as the fields before them, so the same three
 * questions: does a bound clamp rather than refuse, is each field independent
 * of the others, and does what is written reach the two surfaces. Plus the one
 * property `endReason` has that nothing else on the row does — it is written
 * once, by the first worker that says the session ended, and never again.
 */
describe("the goal, the counts and the study residue", () => {
  const room = "lesson-owner-1-aaaa"

  const GOAL = {
    text: "Order food and drinks confidently in a cafe.",
    forms: ["present", "conditional"],
    source: "tool" as const,
  }

  test("stores the confirmed goal, source and all", async () => {
    const t = setup()
    const userId = await makeLearner(t, "user_owner")

    await t.mutation(internal.sessions.recordSummary, {
      room,
      clerkId: "user_owner",
      goal: GOAL,
    })

    const [row] = await sessionsOf(t, userId)
    expect(row.goal?.text).toBe(GOAL.text)
    expect(row.goal?.forms).toEqual(["present", "conditional"])
    // How the goal was captured is how much to trust it: an "extracted" goal
    // was never said back to the learner, and the surfaces say so.
    expect(row.goal?.source).toBe("tool")
  })

  test("clamps a goal that is merely long instead of refusing it", async () => {
    const t = setup()
    const userId = await makeLearner(t, "user_owner")

    await t.mutation(internal.sessions.recordSummary, {
      room,
      clerkId: "user_owner",
      goal: {
        text: "g".repeat(500),
        forms: Array.from({ length: 20 }, () => "f".repeat(200)),
        source: "extracted",
      },
    })

    const [row] = await sessionsOf(t, userId)
    expect(row.goal?.text).toHaveLength(200)
    expect(row.goal?.forms).toHaveLength(8)
    expect(row.goal?.forms[0]).toHaveLength(60)
  })

  test("rounds the turn count and never lets it go negative", async () => {
    const t = setup()
    const userId = await makeLearner(t, "user_owner")

    await t.mutation(internal.sessions.recordSummary, {
      room,
      clerkId: "user_owner",
      turns: 34.6,
    })
    expect((await sessionsOf(t, userId))[0].turns).toBe(35)

    // A negative count would print. The wire rejects it; this is the half
    // that has to hold if that bound is ever loosened.
    await t.mutation(internal.sessions.recordSummary, {
      room,
      clerkId: "user_owner",
      turns: -5,
    })
    expect((await sessionsOf(t, userId))[0].turns).toBe(0)
  })

  test("clamps the anchor ratio into 0..1, NaN included", async () => {
    const t = setup()
    const userId = await makeLearner(t, "user_owner")

    for (const [sent, stored] of [
      [0.12, 0.12],
      [4, 1],
      [-1, 0],
      // `v.number()` accepts NaN and "NaN% anchor" would render. Zero is
      // "we measured nothing", which is what it means.
      [Number.NaN, 0],
    ] as const) {
      await t.mutation(internal.sessions.recordSummary, {
        room,
        clerkId: "user_owner",
        anchorRatio: sent,
      })
      expect((await sessionsOf(t, userId))[0].anchorRatio).toBe(stored)
    }
  })

  test("clamps the Ask questions and the translate lookups", async () => {
    const t = setup()
    const userId = await makeLearner(t, "user_owner")

    await t.mutation(internal.sessions.recordSummary, {
      room,
      clerkId: "user_owner",
      asks: Array.from({ length: 40 }, () => "q".repeat(900)),
      lookups: Array.from({ length: 150 }, () => ({
        source: "s".repeat(400),
        translation: "t".repeat(400),
      })),
    })

    const [row] = await sessionsOf(t, userId)
    expect(row.asks).toHaveLength(25)
    expect(row.asks?.[0]).toHaveLength(400)
    expect(row.lookups).toHaveLength(100)
    expect(row.lookups?.[0].source).toHaveLength(200)
    expect(row.lookups?.[0].translation).toHaveLength(200)
  })

  test("each new field is independent, and sending one again replaces it", async () => {
    const t = setup()
    const userId = await makeLearner(t, "user_owner")

    // The goal is confirmed at the TOP of the conversation, so it is sent
    // long before the counts exist. A session that dies mid-way must still
    // record what it was set up to be.
    await t.mutation(internal.sessions.recordSummary, {
      room,
      clerkId: "user_owner",
      goal: GOAL,
    })
    await t.mutation(internal.sessions.recordSummary, {
      room,
      clerkId: "user_owner",
      turns: 34,
      anchorRatio: 0.2,
      asks: ["why the conditional here?"],
      lookups: [{ source: "la cuenta", translation: "the bill" }],
    })

    const [row] = await sessionsOf(t, userId)
    expect(row.goal?.text).toBe(GOAL.text)
    expect(row.turns).toBe(34)
    expect(row.asks).toEqual(["why the conditional here?"])

    // Wholesale, not merged.
    await t.mutation(internal.sessions.recordSummary, {
      room,
      clerkId: "user_owner",
      asks: ["a", "b"],
    })
    const [after] = await sessionsOf(t, userId)
    expect(after.asks).toEqual(["a", "b"])
    expect(after.goal?.text).toBe(GOAL.text)
    expect(after.turns).toBe(34)
  })

  test("byRoom hands the surfaces every new field, and explicit nulls without them", async () => {
    const t = setup()
    await makeLearner(t, "user_owner")
    const as = t.withIdentity({ subject: "user_owner" })
    await openRoom(t, "user_owner", room)

    // Nothing written yet: "the worker never measured this" is a state the
    // surfaces must render, and `0` would make it look like a silent session.
    expect(await as.query(api.sessions.byRoom, { room })).toMatchObject({
      goal: null,
      endReason: null,
      turns: null,
      anchorRatio: null,
      asks: null,
      lookups: null,
    })

    await t.mutation(internal.sessions.recordSummary, {
      room,
      clerkId: "user_owner",
      goal: GOAL,
      turns: 34,
      anchorRatio: 0.12,
      asks: ["why the conditional here?"],
      lookups: [{ source: "la cuenta", translation: "the bill" }],
    })
    await t.mutation(internal.sessions.debit, {
      room,
      clerkId: "user_owner",
      jobId: "job_1",
      seconds: 90,
      seq: 1,
      final: true,
      reason: "out_of_minutes_idle",
    })

    const record = await as.query(api.sessions.byRoom, { room })
    expect(record).toMatchObject({
      endReason: "out_of_minutes_idle",
      turns: 34,
      anchorRatio: 0.12,
      asks: ["why the conditional here?"],
      lookups: [{ source: "la cuenta", translation: "the bill" }],
    })
    // The whole object here, not just the line — the modal wants the forms
    // and the source too.
    expect(record!.goal).toEqual(GOAL)
  })

  test("history carries the goal line and the end reason, null where nobody said", async () => {
    const t = setup()
    const userId = await makeLearner(t, "user_owner")
    await t.run(async (ctx) => {
      await ctx.db.insert("sessions", {
        userId,
        room: "room-old",
        plan: PLAN,
        startedAt: 1000,
        endedAt: 2000,
        secondsBilled: 30,
      })
      await ctx.db.insert("sessions", {
        userId,
        room: "room-new",
        plan: PLAN,
        startedAt: 3000,
        endedAt: 4000,
        secondsBilled: 30,
        goal: GOAL,
        endReason: "learner_left",
      })
      // A start that failed: finished, but nothing in it. Still not history,
      // and the new columns must not sneak one back onto the page.
      await ctx.db.insert("sessions", {
        userId,
        room: "room-failed",
        plan: PLAN,
        startedAt: 5000,
        endedAt: 5001,
        goal: GOAL,
        endReason: "tutor_silent",
        turns: 0,
      })
    })

    const rows = await t
      .withIdentity({ subject: "user_owner" })
      .query(api.sessions.history, {})

    expect(rows.map((row) => row.room)).toEqual(["room-new", "room-old"])
    // The list wants one line, not the object.
    expect(rows[0].goal).toBe(GOAL.text)
    expect(rows[0].endReason).toBe("learner_left")
    // Absent is `null`, and `null` must never be read as a clean end.
    expect(rows[1].goal).toBeNull()
    expect(rows[1].endReason).toBeNull()
  })
})

describe("why a session ended", () => {
  const room = "lesson-owner-1-aaaa"

  function rowOf(t: TestConvex) {
    return t.run(async (ctx) =>
      ctx.db
        .query("sessions")
        .withIndex("by_room", (q) => q.eq("room", room))
        .unique()
    )
  }

  test("a reason on a periodic report is ignored, not recorded", async () => {
    const t = setup()
    await makeLearner(t, "user_owner")

    // A session that is still happening has not ended for any reason yet. If
    // this were written, the first minute of every conversation would decide
    // what History says about how it finished.
    await t.mutation(internal.sessions.debit, {
      room,
      clerkId: "user_owner",
      jobId: "job_1",
      seconds: 60,
      seq: 1,
      reason: "model_error",
    })

    const row = await rowOf(t)
    expect(row!.endReason).toBeUndefined()
    expect(row!.endedAt).toBeUndefined()
    expect(row!.secondsBilled).toBe(60)
  })

  test("the first final report writes the reason and no later one moves it", async () => {
    const t = setup()
    await makeLearner(t, "user_owner")

    await t.mutation(internal.sessions.debit, {
      room,
      clerkId: "user_owner",
      jobId: "job_1",
      seconds: 90,
      seq: 2,
      final: true,
      reason: "hold_idle",
    })
    expect((await rowOf(t))!.endReason).toBe("hold_idle")

    // A redispatched job's teardown is guessing about a session it did not
    // see end. The first report was the one that was actually there.
    await t.mutation(internal.sessions.debit, {
      room,
      clerkId: "user_owner",
      jobId: "job_2",
      seconds: 120,
      seq: 1,
      final: true,
      reason: "ledger_failure",
    })
    const row = await rowOf(t)
    expect(row!.endReason).toBe("hold_idle")
    // and the meter still moved, so this is a no-op on the reason alone.
    expect(row!.secondsBilled).toBe(120)
  })

  test("a final report with no reason leaves the column absent", async () => {
    const t = setup()
    await makeLearner(t, "user_owner")

    await t.mutation(internal.sessions.debit, {
      room,
      clerkId: "user_owner",
      jobId: "job_1",
      seconds: 90,
      seq: 1,
      final: true,
    })
    // Absent means "we do not know", never "it ended cleanly" — which is why
    // there is no default here.
    expect((await rowOf(t))!.endReason).toBeUndefined()
    expect((await rowOf(t))!.endedAt).toBeTypeOf("number")
  })

  test("a session that was already closed still gets its reason", async () => {
    const t = setup()
    await makeLearner(t, "user_owner")
    await openRoom(t, "user_owner", room)

    // The cron got there first — the worker's lease ran out and the row was
    // closed without anybody saying why. The reason is written on its own
    // condition precisely so it is not dropped along with the `endedAt` the
    // worker is not going to write; this is the case History most needs
    // explained.
    const closedAt = await closeRoom(t, room, Date.now() - 5000)

    await t.mutation(internal.sessions.debit, {
      room,
      clerkId: "user_owner",
      jobId: "job_1",
      seconds: 90,
      seq: 1,
      final: true,
      reason: "ended",
    })

    const row = await rowOf(t)
    expect(row!.endReason).toBe("ended")
    expect(row!.endedAt).toBe(closedAt)
  })
})
