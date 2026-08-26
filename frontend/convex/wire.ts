/**
 * The worker's wire, as pure functions.
 *
 * Everything here takes an already-parsed JSON body and answers with either
 * the exact argument object the internal mutation takes or the one sentence
 * the worker gets back in a `400`. Nothing in this file touches a `Request`, a
 * `Response`, `ctx`, or the database — which is the whole point: the rules
 * that decide whether a teardown report is accepted are the most consequential
 * lines in the seam and the hardest to exercise through an HTTP action, so
 * they live where a unit test can call them directly (`convex/wire.test.ts`).
 *
 * `convex/http.ts` keeps what genuinely needs the runtime: the M2M token
 * check, reading the body under a size ceiling, and running the functions.
 * The wire CONTRACT — paths, field names, bounds, status codes — is still the
 * comment block at the top of `http.ts`; this file enforces it.
 *
 * The shape of every checker is the same and deliberate: absent means "the
 * worker did not send this", which for an optional field is not an error and
 * must stay distinguishable from "sent something wrong". So the parsers return
 * `undefined` for absent and an error string for wrong, and never coerce.
 */

import { SESSION_END_REASONS, SUMMARY_LIMITS } from "./validators"

/* -------------------------------------------------------------------------- */
/*  Bounds                                                                     */
/* -------------------------------------------------------------------------- */

/** Ceiling on a single report's cumulative seconds. A day of continuous
 * conversation is not a conversation, and an unbounded `seconds` behind a
 * leaked credential is an arbitrarily large debit against a known Clerk id. */
export const MAX_SECONDS = 86400

/** Ceiling on the reported learner-turn count. A day of conversation at one
 * turn every three seconds is nowhere near this; anything above it is a
 * counter that ran away, and it is printed on the History card. */
export const MAX_TURNS = 100000

/** Ceiling on the worker's estimated model spend for one session, in USD.
 * A realtime-audio hour costs single-digit dollars, so a thousand is orders
 * of magnitude above anything real and still small enough that a runaway
 * accumulator is caught at the wire rather than stored and averaged into a
 * report. Internal-only: no surface prints it. */
export const MAX_EST_COST_USD = 1000

export const MAX_ROOM_CHARS = 256
export const MAX_USER_ID_CHARS = 256
export const MAX_JOB_ID_CHARS = 128

/* -------------------------------------------------------------------------- */
/*  The result shape                                                           */
/* -------------------------------------------------------------------------- */

/** Either the validated arguments or the sentence the worker reads in the
 * `400`. A discriminated union rather than exceptions: every caller has to
 * handle the failure, and the failure carries the reason. */
export type WireResult<T> =
  { ok: true; value: T } | { ok: false; error: string }

const fail = (error: string): { ok: false; error: string } => ({
  ok: false,
  error,
})

const pass = <T>(value: T): { ok: true; value: T } => ({ ok: true, value })

/* -------------------------------------------------------------------------- */
/*  Primitives                                                                 */
/* -------------------------------------------------------------------------- */

/** A required, non-empty, bounded string field. `null` when it is none of
 * those — the caller turns that into one 400 naming the whole expected shape,
 * rather than confirming field by field which one a prober got right. */
export function boundedString(value: unknown, max: number): string | null {
  if (typeof value !== "string") return null
  const trimmed = value.trim()
  if (trimmed.length === 0 || trimmed.length > max) return null
  return trimmed
}

/** An array field, or `null` if it is not an array or is over its count.
 * Absent is handled by the caller — it must be able to tell "not sent" (leave
 * the column alone) from "sent something wrong" (400). */
export function boundedArray(value: unknown, max: number): unknown[] | null {
  if (!Array.isArray(value) || value.length > max) return null
  return value
}

/** A study pair or a table row: exactly two string fields, each bounded. The
 * key names differ (`target`/`anchor`, `person`/`form`) but the shape does
 * not, so one checker does both. Returns the coerced pair or `null`. */
export function pair<A extends string, B extends string>(
  value: unknown,
  first: A,
  second: B,
  max: number = SUMMARY_LIMITS.reviewItemChars
): { [K in A | B]: string } | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return null
  }
  const record = value as Record<string, unknown>
  const a = record[first]
  const b = record[second]
  if (typeof a !== "string" || typeof b !== "string") return null
  if (a.length > max || b.length > max) return null
  return { [first]: a, [second]: b } as { [K in A | B]: string }
}

/** The three identifiers every worker report carries, so the logs on both
 * sides join up. All required; one message for all three, for the reason
 * `boundedString` gives. */
function identifiers(
  body: Record<string, unknown>
): { room: string; userId: string; jobId: string } | null {
  const room = boundedString(body.room, MAX_ROOM_CHARS)
  const userId = boundedString(body.userId, MAX_USER_ID_CHARS)
  const jobId = boundedString(body.jobId, MAX_JOB_ID_CHARS)
  if (room === null || userId === null || jobId === null) return null
  return { room, userId, jobId }
}

/* -------------------------------------------------------------------------- */
/*  POST /tutor/debit                                                          */
/* -------------------------------------------------------------------------- */

export type EndReason = (typeof SESSION_END_REASONS)[number]

export interface DebitArgs {
  room: string
  /** The learner's Clerk id, as `sessions.debit` takes it. */
  clerkId: string
  jobId: string
  seconds: number
  seq: number
  final?: boolean
  reason?: EndReason
}

export function parseDebitBody(
  body: Record<string, unknown>
): WireResult<DebitArgs> {
  const ids = identifiers(body)
  if (ids === null) {
    return fail("expected { room, userId, jobId, seconds, seq }")
  }

  const seconds: unknown = body.seconds
  if (
    typeof seconds !== "number" ||
    !Number.isFinite(seconds) ||
    seconds < 0 ||
    seconds > MAX_SECONDS
  ) {
    return fail(`seconds must be a number between 0 and ${MAX_SECONDS}`)
  }

  // An integer, not merely finite: a float `seq` would stringify into the ref
  // as `1.0000000000000002` and quietly defeat the idempotency check.
  const seq: unknown = body.seq
  if (typeof seq !== "number" || !Number.isSafeInteger(seq) || seq < 0) {
    return fail("seq must be a non-negative integer")
  }

  // Absent or a real boolean. A truthy string ("false", say) must not end a
  // conversation, so this is checked rather than coerced.
  const final: unknown = body.final
  if (final !== undefined && typeof final !== "boolean") {
    return fail("final must be a boolean")
  }

  // Validated whenever it is present, even on a periodic report that will
  // ignore it: a worker sending a reason the schema does not know is a worker
  // whose teardown report is about to 500, and it should learn that from the
  // first one it sends rather than from the last.
  const reason: unknown = body.reason
  if (
    reason !== undefined &&
    !(SESSION_END_REASONS as readonly unknown[]).includes(reason)
  ) {
    return fail(`reason must be one of ${SESSION_END_REASONS.join(", ")}`)
  }

  return pass({
    room: ids.room,
    clerkId: ids.userId,
    jobId: ids.jobId,
    seconds,
    seq,
    final: final as boolean | undefined,
    reason: reason as EndReason | undefined,
  })
}

/* -------------------------------------------------------------------------- */
/*  POST /tutor/balance                                                        */
/* -------------------------------------------------------------------------- */

export interface BalanceArgs {
  clerkId: string
  /** `null` when the worker did not name a room — a resume already knows its
   * room's total from its own clock, and only a starting job needs telling.
   * Absent is `secondsBilled: 0`, not an error. */
  room: string | null
}

export function parseBalanceBody(
  body: Record<string, unknown>
): WireResult<BalanceArgs> {
  const userId = boundedString(body.userId, MAX_USER_ID_CHARS)
  if (userId === null) return fail("expected { userId, room? }")

  if (body.room === undefined) return pass({ clerkId: userId, room: null })

  const room = boundedString(body.room, MAX_ROOM_CHARS)
  if (room === null) return fail("room must be a non-empty string")
  return pass({ clerkId: userId, room })
}

/* -------------------------------------------------------------------------- */
/*  POST /tutor/summary                                                        */
/* -------------------------------------------------------------------------- */

export interface TranscriptTurn {
  role: "learner" | "tutor"
  text: string
}

export interface StoredCorrection {
  id: string
  original: string
  replacement: string
  category: string
  severity: string
  explanation: string
}

export interface ReviewPayload {
  vocab: Array<{ target: string; anchor: string }>
  phrases: Array<{ target: string; anchor: string }>
  tables: Array<{
    verb: string
    tense: string
    rows: Array<{ person: string; form: string }>
  }>
}

/** Exactly `sessions.recordSummary`'s arguments — no `jobId`. It is required
 * on the wire so every worker report carries the same three identifiers and
 * the logs on both sides join up, but this write is a last-write-wins patch,
 * not a ledger entry, so it needs no idempotency key and nothing stores it.
 * Kept out of this type so the route cannot pass it on by accident. */
export interface SummaryArgs {
  room: string
  clerkId: string
  about?: string
  transcript?: TranscriptTurn[]
  review?: ReviewPayload
  corrections?: StoredCorrection[]
  goal?: {
    text: string
    forms: string[]
    source: "plan" | "tool" | "extracted"
  }
  turns?: number
  anchorRatio?: number
  asks?: string[]
  lookups?: Array<{ source: string; translation: string }>
  estCostUsd?: number
}

const CORRECTION_FIELDS = [
  "id",
  "original",
  "replacement",
  "category",
  "severity",
  "explanation",
] as const

/** The validated summary: the mutation's arguments, plus the `jobId` the route
 * checked and does not pass on. */
export interface SummaryReport {
  jobId: string
  args: SummaryArgs
}

export function parseSummaryBody(
  body: Record<string, unknown>
): WireResult<SummaryReport> {
  const ids = identifiers(body)
  if (ids === null) {
    return fail(
      "expected { room, userId, jobId, about?, goal?, transcript?, review?, " +
        "corrections?, turns?, anchorRatio?, asks?, lookups?, estCostUsd? }"
    )
  }

  const args: SummaryArgs = { room: ids.room, clerkId: ids.userId }

  // Every payload field below is optional and independently written. Absent
  // means "leave the column alone", which is what lets the worker send the
  // goal the moment it is confirmed, the transcript at teardown, and the
  // Review whenever it finished generating.

  if (body.about !== undefined) {
    if (
      typeof body.about !== "string" ||
      body.about.length > SUMMARY_LIMITS.aboutChars
    ) {
      return fail(
        `about must be a string of at most ${SUMMARY_LIMITS.aboutChars} chars`
      )
    }
    // Trimmed, and an empty line is "we did not write one" rather than a
    // stored `""` every surface would have to special-case — the same rule
    // `users.email` follows.
    const trimmed = body.about.trim()
    if (trimmed.length > 0) args.about = trimmed
  }

  if (body.transcript !== undefined) {
    const raw = boundedArray(body.transcript, SUMMARY_LIMITS.transcriptTurns)
    if (raw === null) {
      return fail(
        `transcript must be an array of at most ${SUMMARY_LIMITS.transcriptTurns} turns`
      )
    }
    const turns: TranscriptTurn[] = []
    for (const entry of raw) {
      if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
        return fail("transcript turns must be { role, text }")
      }
      const { role, text } = entry as Record<string, unknown>
      // A role the schema does not know would fail the mutation's validator
      // and turn a whole teardown report into a 500. Rejected by name here,
      // where the answer is a 400 the worker can read.
      if (role !== "learner" && role !== "tutor") {
        return fail('transcript role must be "learner" or "tutor"')
      }
      if (typeof text !== "string" || text.length > SUMMARY_LIMITS.turnChars) {
        return fail(
          `transcript text must be a string of at most ${SUMMARY_LIMITS.turnChars} chars`
        )
      }
      turns.push({ role, text })
    }
    args.transcript = turns
  }

  if (body.review !== undefined) {
    const material = body.review
    if (
      material === null ||
      typeof material !== "object" ||
      Array.isArray(material)
    ) {
      return fail("review must be { vocab, phrases, tables }")
    }
    const {
      vocab: rawVocab,
      phrases: rawPhrases,
      tables: rawTables,
    } = material as Record<string, unknown>
    const vocabRaw = boundedArray(rawVocab, SUMMARY_LIMITS.reviewVocab)
    const phrasesRaw = boundedArray(rawPhrases, SUMMARY_LIMITS.reviewPhrases)
    const tablesRaw = boundedArray(rawTables, SUMMARY_LIMITS.reviewTables)
    if (vocabRaw === null || phrasesRaw === null || tablesRaw === null) {
      return fail(
        `review must be { vocab, phrases, tables } with at most ` +
          `${SUMMARY_LIMITS.reviewVocab} / ${SUMMARY_LIMITS.reviewPhrases} / ` +
          `${SUMMARY_LIMITS.reviewTables} entries`
      )
    }
    const vocab: Array<{ target: string; anchor: string }> = []
    for (const entry of vocabRaw) {
      const item = pair(entry, "target", "anchor")
      if (item === null) {
        return fail("review vocab items must be { target, anchor }")
      }
      vocab.push(item)
    }
    const phrases: Array<{ target: string; anchor: string }> = []
    for (const entry of phrasesRaw) {
      const item = pair(entry, "target", "anchor")
      if (item === null)
        return fail("review phrases must be { target, anchor }")
      phrases.push(item)
    }
    const tables: ReviewPayload["tables"] = []
    for (const entry of tablesRaw) {
      const head = pair(entry, "verb", "tense")
      if (head === null) {
        return fail("review tables must be { verb, tense, rows }")
      }
      const rowsRaw = boundedArray(
        (entry as Record<string, unknown>).rows,
        SUMMARY_LIMITS.tableRows
      )
      if (rowsRaw === null) {
        return fail(
          `review table rows must be an array of at most ${SUMMARY_LIMITS.tableRows}`
        )
      }
      const rows: Array<{ person: string; form: string }> = []
      for (const row of rowsRaw) {
        const cell = pair(row, "person", "form")
        if (cell === null)
          return fail("review table rows must be { person, form }")
        rows.push(cell)
      }
      tables.push({ verb: head.verb, tense: head.tense, rows })
    }
    args.review = { vocab, phrases, tables }
  }

  // The corrections the worker's analyzer produced. Same element shape as the
  // client's `SessionOutcome.corrections`, and the same bounds
  // `sessions.finish` clamps to, because it lands in the same column.
  if (body.corrections !== undefined) {
    const raw = boundedArray(body.corrections, SUMMARY_LIMITS.corrections)
    if (raw === null) {
      return fail(
        `corrections must be an array of at most ${SUMMARY_LIMITS.corrections}`
      )
    }
    const found: StoredCorrection[] = []
    for (const entry of raw) {
      if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
        return fail(
          "corrections must be { id, original, replacement, category, severity, explanation }"
        )
      }
      const record = entry as Record<string, unknown>
      for (const field of CORRECTION_FIELDS) {
        const value = record[field]
        if (
          typeof value !== "string" ||
          value.length > SUMMARY_LIMITS.correctionChars
        ) {
          return fail(
            `corrections.${field} must be a string of at most ${SUMMARY_LIMITS.correctionChars} chars`
          )
        }
      }
      found.push({
        id: record.id as string,
        original: record.original as string,
        replacement: record.replacement as string,
        category: record.category as string,
        severity: record.severity as string,
        explanation: record.explanation as string,
      })
    }
    args.corrections = found
  }

  // The goal is the only field that is an OBJECT, and the only one whose
  // shape a wrong worker could get subtly wrong. `source` is checked by name
  // because it is what the surfaces branch on — an unknown source is a 400
  // here rather than a 500 out of the mutation's closed union.
  if (body.goal !== undefined) {
    const raw = body.goal
    if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
      return fail("goal must be { text, forms, source }")
    }
    const {
      text: rawText,
      forms: rawForms,
      source: rawSource,
    } = raw as Record<string, unknown>
    if (typeof rawText !== "string") return fail("goal.text must be a string")
    // Trimmed and required non-empty, unlike `about`: an absent `about` is an
    // ordinary state (nobody summarized), but a goal object with no line in it
    // is not a goal — it is a bug that would render as an empty "you set up"
    // on the History card.
    const text = rawText.trim()
    if (text.length === 0 || text.length > SUMMARY_LIMITS.goalChars) {
      return fail(
        `goal.text must be a non-empty string of at most ${SUMMARY_LIMITS.goalChars} chars`
      )
    }
    const formsRaw = boundedArray(rawForms, SUMMARY_LIMITS.goalForms)
    if (formsRaw === null) {
      return fail(
        `goal.forms must be an array of at most ${SUMMARY_LIMITS.goalForms} strings`
      )
    }
    const forms: string[] = []
    for (const form of formsRaw) {
      if (
        typeof form !== "string" ||
        form.length > SUMMARY_LIMITS.goalFormChars
      ) {
        return fail(
          `goal.forms entries must be strings of at most ${SUMMARY_LIMITS.goalFormChars} chars`
        )
      }
      forms.push(form)
    }
    if (
      rawSource !== "plan" &&
      rawSource !== "tool" &&
      rawSource !== "extracted"
    ) {
      return fail('goal.source must be "plan", "tool" or "extracted"')
    }
    args.goal = { text, forms, source: rawSource }
  }

  // A count and a ratio. Both are checked at their real bounds rather than
  // merely "is a number", because both are printed: a negative turn count or
  // a ratio of 4 reads as a broken product, and NaN passes `typeof number`.
  if (body.turns !== undefined) {
    if (
      typeof body.turns !== "number" ||
      !Number.isSafeInteger(body.turns) ||
      body.turns < 0 ||
      body.turns > MAX_TURNS
    ) {
      return fail(`turns must be an integer between 0 and ${MAX_TURNS}`)
    }
    args.turns = body.turns
  }

  if (body.anchorRatio !== undefined) {
    if (
      typeof body.anchorRatio !== "number" ||
      !Number.isFinite(body.anchorRatio) ||
      body.anchorRatio < 0 ||
      body.anchorRatio > 1
    ) {
      return fail("anchorRatio must be a number between 0 and 1")
    }
    args.anchorRatio = body.anchorRatio
  }

  // The questions, not the answers: what the learner did not know is the
  // study record, and the answer is already in the transcript of the pause.
  if (body.asks !== undefined) {
    const raw = boundedArray(body.asks, SUMMARY_LIMITS.asks)
    if (raw === null) {
      return fail(
        `asks must be an array of at most ${SUMMARY_LIMITS.asks} questions`
      )
    }
    const questions: string[] = []
    for (const question of raw) {
      if (
        typeof question !== "string" ||
        question.length > SUMMARY_LIMITS.askChars
      ) {
        return fail(
          `asks entries must be strings of at most ${SUMMARY_LIMITS.askChars} chars`
        )
      }
      questions.push(question)
    }
    args.asks = questions
  }

  if (body.lookups !== undefined) {
    const raw = boundedArray(body.lookups, SUMMARY_LIMITS.lookups)
    if (raw === null) {
      return fail(
        `lookups must be an array of at most ${SUMMARY_LIMITS.lookups} entries`
      )
    }
    const found: Array<{ source: string; translation: string }> = []
    for (const entry of raw) {
      const item = pair(
        entry,
        "source",
        "translation",
        SUMMARY_LIMITS.lookupChars
      )
      if (item === null) {
        return fail(
          `lookups must be { source, translation } with strings of at most ${SUMMARY_LIMITS.lookupChars} chars`
        )
      }
      found.push(item)
    }
    args.lookups = found
  }

  // The worker's estimated model spend for this session, in USD. Internal:
  // nothing renders it, and that is why it is bounded rather than clamped
  // silently — a cost column only earns its keep if the numbers in it are
  // ones you would put in a report.
  if (body.estCostUsd !== undefined) {
    if (
      typeof body.estCostUsd !== "number" ||
      !Number.isFinite(body.estCostUsd) ||
      body.estCostUsd < 0 ||
      body.estCostUsd > MAX_EST_COST_USD
    ) {
      return fail(
        `estCostUsd must be a number between 0 and ${MAX_EST_COST_USD}`
      )
    }
    args.estCostUsd = body.estCostUsd
  }

  return pass({ jobId: ids.jobId, args })
}
