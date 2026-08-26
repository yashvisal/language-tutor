import { convexTest } from "convex-test"
import { describe, expect, test } from "vitest"

import { api, internal } from "./_generated/api"
import type { Doc, Id } from "./_generated/dataModel"
import schema from "./schema"
import type { sessionPlanValidator } from "./validators"
import {
  DELTA_CAP_PREFIX,
  MAX_DELTA_PER_CALL_S,
  OPEN_SESSION_PREFIX,
  OPEN_SESSION_WINDOW_MS,
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
    await t
      .withIdentity({ subject: "user_owner" })
      .mutation(api.sessions.start, { room, plan: PLAN })

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
    await t
      .withIdentity({ subject: "user_owner" })
      .mutation(api.sessions.start, { room, plan: PLAN })

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
    await as.mutation(api.sessions.start, { room, plan: PLAN })
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
    await as.mutation(api.sessions.start, { room, plan: PLAN })

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
    await t
      .withIdentity({ subject: "user_owner" })
      .mutation(api.sessions.start, { room, plan: PLAN })
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
})

describe("sessions.history", () => {
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
    await as.mutation(api.sessions.start, { room, plan: PLAN })
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
