import { describe, expect, test } from "vitest"

import { SESSION_END_REASONS, SUMMARY_LIMITS } from "./validators"
import {
  MAX_EST_COST_USD,
  MAX_SECONDS,
  MAX_TURNS,
  parseBalanceBody,
  parseDebitBody,
  parseSummaryBody,
} from "./wire"

/**
 * The wire, tested as the 400s.
 *
 * `convex/sessions.test.ts` proves what the mutations DO with a body that got
 * through. This file proves which bodies get through at all — the half that
 * used to be reachable only by constructing a `Request`, and therefore the
 * half nobody tested. Every case here is a way the Python worker could be
 * wrong (a float where an integer is required, a role the schema does not
 * know, a counter that ran away) and the answer it should read back.
 *
 * Two properties are asserted throughout, because both are load-bearing:
 *
 * - **Absent is not an error.** Every optional field left out of the body must
 *   come back absent from the args, not `null` or `0` — `recordSummary` reads
 *   absent as "leave the column alone", which is what lets the worker send the
 *   goal at the top of the conversation and the transcript at the end.
 * - **Wrong is a sentence, not a throw.** A `400` the worker can log beats a
 *   `500` it can only retry.
 */

const ROOM = "lesson-learner-ab12cd34-1756000000000-9f8e7d6c"
const USER = "user_2abcDEF"
const JOB = "AJ_9xKq"

/** The three identifiers every route requires, spread into each case. */
const IDS = { room: ROOM, userId: USER, jobId: JOB }

/** Unwraps a success, failing the test with the error if it is not one. */
function value<T>(
  result: { ok: true; value: T } | { ok: false; error: string }
) {
  if (!result.ok) throw new Error(`expected ok, got: ${result.error}`)
  return result.value
}

/** Asserts a rejection and hands back the message so the case can name what
 * the worker is supposed to learn from it. */
function error(
  result: { ok: true; value: unknown } | { ok: false; error: string }
) {
  if (result.ok) throw new Error("expected a rejection, got a valid body")
  return result.error
}

describe("/tutor/debit", () => {
  test("a well-formed periodic report maps onto the mutation's args", () => {
    const args = value(parseDebitBody({ ...IDS, seconds: 137, seq: 3 }))
    // `userId` on the wire is `clerkId` in the mutation: the worker speaks
    // Clerk, the database speaks its own ids, and the rename happens once.
    expect(args).toMatchObject({
      room: ROOM,
      clerkId: USER,
      jobId: JOB,
      seconds: 137,
      seq: 3,
    })
    expect(args.final).toBeUndefined()
    expect(args.reason).toBeUndefined()
  })

  test("missing identifiers name the whole expected shape, not the one that was wrong", () => {
    // Deliberately not "userId is required": a prober must not be able to
    // confirm field by field which identifier it got right.
    expect(error(parseDebitBody({ room: ROOM, seconds: 1, seq: 1 }))).toBe(
      "expected { room, userId, jobId, seconds, seq }"
    )
  })

  test("seconds is bounded on both ends", () => {
    expect(error(parseDebitBody({ ...IDS, seconds: -1, seq: 1 }))).toContain(
      "seconds must be"
    )
    expect(
      error(parseDebitBody({ ...IDS, seconds: MAX_SECONDS + 1, seq: 1 }))
    ).toContain("seconds must be")
    // NaN passes `typeof x === "number"`, which is exactly why it is checked.
    expect(error(parseDebitBody({ ...IDS, seconds: NaN, seq: 1 }))).toContain(
      "seconds must be"
    )
    expect(
      value(parseDebitBody({ ...IDS, seconds: MAX_SECONDS, seq: 1 })).seconds
    ).toBe(MAX_SECONDS)
  })

  test("seq must be a non-negative integer, because it becomes the ledger ref", () => {
    // A float would stringify into `<room>:<jobId>:1.0000000000000002` and
    // quietly defeat the idempotency check — every retry a fresh debit.
    expect(error(parseDebitBody({ ...IDS, seconds: 10, seq: 1.5 }))).toBe(
      "seq must be a non-negative integer"
    )
    expect(error(parseDebitBody({ ...IDS, seconds: 10, seq: -1 }))).toBe(
      "seq must be a non-negative integer"
    )
    expect(value(parseDebitBody({ ...IDS, seconds: 10, seq: 0 })).seq).toBe(0)
  })

  test("final must be a real boolean, never a truthy string", () => {
    // `"false"` is truthy. Coercing it would end a conversation that is still
    // happening, so the type is checked rather than the value.
    expect(
      error(parseDebitBody({ ...IDS, seconds: 10, seq: 1, final: "true" }))
    ).toBe("final must be a boolean")
    expect(
      value(parseDebitBody({ ...IDS, seconds: 10, seq: 1, final: true })).final
    ).toBe(true)
  })

  test("reason is checked against the enum on every report, not only the final one", () => {
    const rejected = error(
      parseDebitBody({ ...IDS, seconds: 10, seq: 1, reason: "gave_up" })
    )
    expect(rejected).toContain("reason must be one of")
    // The message lists the set, so a worker with a stale copy can diff it.
    for (const reason of SESSION_END_REASONS) expect(rejected).toContain(reason)
    // Validated on a periodic report too — a wrong value should be learned
    // from the first debit, not from the teardown one that mattered.
    expect(
      value(
        parseDebitBody({ ...IDS, seconds: 10, seq: 1, reason: "model_error" })
      ).reason
    ).toBe("model_error")
  })

  test('"stale" is syntactically accepted even though it is the cron\'s word', () => {
    // It is in the enum, so the wire takes it; the reconciliation cron is the
    // only thing that has a reason to write it.
    expect(
      value(
        parseDebitBody({
          ...IDS,
          seconds: 10,
          seq: 1,
          final: true,
          reason: "stale",
        })
      ).reason
    ).toBe("stale")
  })
})

describe("/tutor/balance", () => {
  test("room is optional, and absent means null rather than an error", () => {
    // A resuming job knows its own total; only a starting one needs telling.
    expect(value(parseBalanceBody({ userId: USER }))).toEqual({
      clerkId: USER,
      room: null,
    })
    expect(value(parseBalanceBody({ userId: USER, room: ROOM })).room).toBe(
      ROOM
    )
  })

  test("a present but empty room is a rejection, not an omission", () => {
    // Sending `""` is a bug in the caller; treating it as "no room" would hide
    // it and answer `secondsBilled: 0` for a room that has been billed.
    expect(error(parseBalanceBody({ userId: USER, room: "   " }))).toBe(
      "room must be a non-empty string"
    )
    expect(error(parseBalanceBody({ room: ROOM }))).toBe(
      "expected { userId, room? }"
    )
  })
})

/** The summary parser answers `{ jobId, args }` — the mutation's arguments,
 * plus the identifier the route checks and deliberately does not pass on. Most
 * cases below care only about the arguments. */
function summary<T>(
  result:
    | { ok: true; value: { jobId: string; args: T } }
    | { ok: false; error: string }
): T {
  return value(result).args
}

describe("/tutor/summary", () => {
  test("the identifiers alone are a valid body: every payload field is optional", () => {
    const report = value(parseSummaryBody({ ...IDS }))
    // `jobId` rides alongside rather than inside: the route checks it, logs
    // join on it, and `recordSummary` must never be handed it.
    expect(report.jobId).toBe(JOB)
    const args = report.args
    expect(args).toEqual({ room: ROOM, clerkId: USER })
    // Absent, not null — `recordSummary` reads absent as "leave it alone".
    expect("about" in args).toBe(false)
    expect("estCostUsd" in args).toBe(false)
  })

  test("an about that is only whitespace is absent, not a stored empty string", () => {
    expect(
      summary(parseSummaryBody({ ...IDS, about: "   " })).about
    ).toBeUndefined()
    expect(
      summary(parseSummaryBody({ ...IDS, about: "  a cafe  " })).about
    ).toBe("a cafe")
    expect(
      error(
        parseSummaryBody({
          ...IDS,
          about: "x".repeat(SUMMARY_LIMITS.aboutChars + 1),
        })
      )
    ).toContain("about must be a string")
  })

  test("goal.text must be a non-empty line and goal.source one of three", () => {
    // An absent goal is ordinary; a goal OBJECT with no line in it is a bug
    // that would render as an empty "you set up" on the History card.
    expect(
      error(
        parseSummaryBody({
          ...IDS,
          goal: { text: "  ", forms: [], source: "tool" },
        })
      )
    ).toContain("goal.text must be a non-empty string")
    expect(
      error(
        parseSummaryBody({
          ...IDS,
          goal: { text: "order coffee", forms: [], source: "vibes" },
        })
      )
    ).toBe('goal.source must be "plan", "tool" or "extracted"')
    expect(error(parseSummaryBody({ ...IDS, goal: "order coffee" }))).toBe(
      "goal must be { text, forms, source }"
    )
    expect(
      error(
        parseSummaryBody({
          ...IDS,
          goal: {
            text: "order coffee",
            forms: Array(SUMMARY_LIMITS.goalForms + 1).fill("present"),
            source: "plan",
          },
        })
      )
    ).toContain("goal.forms must be an array")
    expect(
      summary(
        parseSummaryBody({
          ...IDS,
          goal: { text: " order coffee ", forms: ["present"], source: "plan" },
        })
      ).goal
    ).toEqual({ text: "order coffee", forms: ["present"], source: "plan" })
  })

  test("an unknown transcript role is a 400, not a silent drop", () => {
    // It would fail the mutation's validator and turn the whole teardown
    // report into a 500 — losing the conversation over one bad turn.
    expect(
      error(
        parseSummaryBody({
          ...IDS,
          transcript: [{ role: "assistant", text: "hola" }],
        })
      )
    ).toBe('transcript role must be "learner" or "tutor"')
    expect(
      error(
        parseSummaryBody({ ...IDS, transcript: [{ role: "tutor", text: 7 }] })
      )
    ).toContain("transcript text must be a string")
    expect(
      error(
        parseSummaryBody({
          ...IDS,
          transcript: Array(SUMMARY_LIMITS.transcriptTurns + 1).fill({
            role: "tutor",
            text: "hola",
          }),
        })
      )
    ).toContain("transcript must be an array")
    expect(
      summary(
        parseSummaryBody({
          ...IDS,
          transcript: [{ role: "learner", text: "hola" }],
        })
      ).transcript
    ).toEqual([{ role: "learner", text: "hola" }])
  })

  test("review needs all three keys and the right pair shape inside each", () => {
    // `ready` is deliberately not among them: it is a property of the poll,
    // not of the material.
    expect(
      error(parseSummaryBody({ ...IDS, review: { vocab: [], phrases: [] } }))
    ).toContain("review must be { vocab, phrases, tables }")
    expect(
      error(
        parseSummaryBody({
          ...IDS,
          review: { vocab: [{ target: "la cuenta" }], phrases: [], tables: [] },
        })
      )
    ).toBe("review vocab items must be { target, anchor }")
    expect(
      error(
        parseSummaryBody({
          ...IDS,
          review: {
            vocab: [],
            phrases: [],
            tables: [
              { verb: "querer", tense: "present", rows: [{ person: "yo" }] },
            ],
          },
        })
      )
    ).toBe("review table rows must be { person, form }")
    expect(
      summary(
        parseSummaryBody({
          ...IDS,
          review: {
            vocab: [{ target: "la cuenta", anchor: "the bill" }],
            phrases: [],
            tables: [
              {
                verb: "querer",
                tense: "present",
                rows: [{ person: "yo", form: "quiero" }],
              },
            ],
          },
        })
      ).review
    ).toEqual({
      vocab: [{ target: "la cuenta", anchor: "the bill" }],
      phrases: [],
      tables: [
        {
          verb: "querer",
          tense: "present",
          rows: [{ person: "yo", form: "quiero" }],
        },
      ],
    })
  })

  test("corrections name the offending field, and are bounded like the client's", () => {
    expect(
      error(
        parseSummaryBody({
          ...IDS,
          corrections: [
            {
              id: "c1",
              original: "yo gustaria",
              replacement: "me gustaria",
              category: "grammar",
              severity: "minor",
              // Missing `explanation` — the field is named so the worker can
              // fix the one thing rather than bisect its payload.
            },
          ],
        })
      )
    ).toContain("corrections.explanation")
  })

  test("anchorRatio is a ratio and turns is a count", () => {
    // Both are printed, so both are checked at their real bounds: a ratio of
    // 4 or a negative turn count reads as a broken product.
    expect(error(parseSummaryBody({ ...IDS, anchorRatio: 1.5 }))).toBe(
      "anchorRatio must be a number between 0 and 1"
    )
    expect(error(parseSummaryBody({ ...IDS, anchorRatio: NaN }))).toBe(
      "anchorRatio must be a number between 0 and 1"
    )
    expect(
      summary(parseSummaryBody({ ...IDS, anchorRatio: 0 })).anchorRatio
    ).toBe(0)
    expect(error(parseSummaryBody({ ...IDS, turns: 3.5 }))).toContain(
      "turns must be an integer"
    )
    expect(error(parseSummaryBody({ ...IDS, turns: MAX_TURNS + 1 }))).toContain(
      "turns must be an integer"
    )
    expect(summary(parseSummaryBody({ ...IDS, turns: 34 })).turns).toBe(34)
  })

  test("asks and lookups are bounded by count and by string length", () => {
    expect(
      error(
        parseSummaryBody({
          ...IDS,
          asks: Array(SUMMARY_LIMITS.asks + 1).fill("?"),
        })
      )
    ).toContain("asks must be an array")
    expect(
      error(
        parseSummaryBody({
          ...IDS,
          asks: ["x".repeat(SUMMARY_LIMITS.askChars + 1)],
        })
      )
    ).toContain("asks entries must be strings")
    expect(
      error(
        parseSummaryBody({
          ...IDS,
          lookups: Array(SUMMARY_LIMITS.lookups + 1).fill({
            source: "la cuenta",
            translation: "the bill",
          }),
        })
      )
    ).toContain("lookups must be an array")
    expect(
      error(parseSummaryBody({ ...IDS, lookups: [{ source: "la cuenta" }] }))
    ).toContain("lookups must be { source, translation }")
    expect(
      summary(
        parseSummaryBody({
          ...IDS,
          asks: ["why me gustaria?"],
          lookups: [{ source: "la cuenta", translation: "the bill" }],
        })
      )
    ).toMatchObject({
      asks: ["why me gustaria?"],
      lookups: [{ source: "la cuenta", translation: "the bill" }],
    })
  })

  test("estCostUsd is finite money between 0 and the ceiling", () => {
    // Internal, never rendered — which is exactly why it is bounded here: a
    // column that gets summed is worthless if it can hold NaN or a runaway
    // accumulator's total.
    expect(error(parseSummaryBody({ ...IDS, estCostUsd: -0.01 }))).toBe(
      `estCostUsd must be a number between 0 and ${MAX_EST_COST_USD}`
    )
    expect(
      error(parseSummaryBody({ ...IDS, estCostUsd: MAX_EST_COST_USD + 1 }))
    ).toContain("estCostUsd must be")
    expect(error(parseSummaryBody({ ...IDS, estCostUsd: NaN }))).toContain(
      "estCostUsd must be"
    )
    expect(error(parseSummaryBody({ ...IDS, estCostUsd: "0.42" }))).toContain(
      "estCostUsd must be"
    )
    expect(
      summary(parseSummaryBody({ ...IDS, estCostUsd: 0.4213 })).estCostUsd
    ).toBe(0.4213)
    expect(
      summary(parseSummaryBody({ ...IDS, estCostUsd: 0 })).estCostUsd
    ).toBe(0)
  })

  test("a summary with no identifiers names the whole payload", () => {
    const message = error(parseSummaryBody({ room: ROOM, jobId: JOB }))
    expect(message).toContain("expected { room, userId, jobId")
    expect(message).toContain("estCostUsd?")
  })
})
