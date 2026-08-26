/**
 * Argument and column validators shared across the Convex functions and the
 * schema, derived from the frontend's catalogs rather than restated next to
 * them. Convex bundles ordinary project imports, so `lib/session/*` is reachable
 * from here — and the modules imported below are dependency-free by design, so
 * nothing browser-only travels with them.
 *
 * The point of the file: a level or a plan shape has one definition, and the
 * type assertions at the bottom of each section fail the build if the validator
 * and the TypeScript contract ever drift apart.
 */

import { v, type Infer } from "convex/values"

import type {
  ConjugationTable,
  Correction,
  ReviewItem,
  ReviewMaterial,
  SessionPlan,
  Speaker,
} from "../lib/session/contract"
import { LEVEL_VALUES, type LevelValue } from "../lib/session/plan"

/** Compile-time equality — invariant, so `string` does not pass for a union. */
type Equals<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2
    ? true
    : false

type Assert<T extends true> = T

/* -------------------------------------------------------------------------- */
/*  Level                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * The self-declared level, closed to exactly the catalog the UI offers. Both
 * mutations that write `users.level` take this, so an unknown level is rejected
 * at the boundary instead of reaching the tutor prompt.
 */
export const levelValidator = v.union(
  v.literal(LEVEL_VALUES[0]),
  v.literal(LEVEL_VALUES[1]),
  v.literal(LEVEL_VALUES[2])
)

export type LevelMatchesCatalog = Assert<
  Equals<Infer<typeof levelValidator>, LevelValue>
>

/* -------------------------------------------------------------------------- */
/*  Session plan                                                              */
/* -------------------------------------------------------------------------- */

/**
 * The bounded `SessionPlan` as stored on a `sessions` row. Mirrors
 * `SessionPlan` in `lib/session/contract.ts`, which cannot be generated from a
 * validator without dragging Convex into the frontend contract — so the
 * assertion below stands in for generation.
 */
export const sessionPlanValidator = v.object({
  scenario: v.union(v.string(), v.null()),
  topic: v.union(v.string(), v.null()),
  tenses: v.array(v.string()),
  // Optional, unlike their contract counterparts: rows written before the two
  // open notes existed have no such field, and a stored session is history —
  // it is never rewritten to match a newer plan shape.
  focusNote: v.optional(v.union(v.string(), v.null())),
  note: v.optional(v.union(v.string(), v.null())),
  vocab: v.array(v.string()),
  level: v.union(v.string(), v.null()),
})

/** Drops the `?` the back-compat fields carry, so the assertion below still
 * compares the two shapes field for field. */
type Filled<T> = { [K in keyof T]-?: Exclude<T[K], undefined> }

export type SessionPlanMatchesContract = Assert<
  Equals<Filled<Infer<typeof sessionPlanValidator>>, SessionPlan>
>

/* -------------------------------------------------------------------------- */
/*  Correction                                                                */
/* -------------------------------------------------------------------------- */

/**
 * One analyzer finding, as stored on a finished session's `outcome`. Mirrors
 * `Correction` in `lib/session/contract.ts`.
 *
 * `category` and `severity` are `v.string()` rather than the contract's literal
 * unions, for the same reason `sessionPlanValidator` widens `level`: a stored
 * session is history. Retiring or renaming a category later must not make rows
 * written today fail schema validation, and nothing downstream branches on an
 * unknown category — the UI labels what it recognizes and prints the raw value
 * otherwise.
 */
export const correctionValidator = v.object({
  id: v.string(),
  original: v.string(),
  replacement: v.string(),
  category: v.string(),
  severity: v.string(),
  explanation: v.string(),
})

/** `Correction` with the two enums widened, which is what is stored. Mapped
 * rather than intersected so the assertion still compares field for field. */
type StoredCorrection = {
  [K in keyof Correction]: K extends "category" | "severity"
    ? string
    : Correction[K]
}

export type CorrectionMatchesContract = Assert<
  Equals<Infer<typeof correctionValidator>, StoredCorrection>
>

/**
 * The snapshot of a finished session — the same `SessionOutcome` the summary
 * screen renders, minus `plan` (already a column on the row, and the plan the
 * session STARTED with is the one worth keeping).
 */
export const sessionOutcomeValidator = v.object({
  corrections: v.array(correctionValidator),
  secondsTalked: v.union(v.number(), v.null()),
  endedByClock: v.boolean(),
})

/* -------------------------------------------------------------------------- */
/*  The after-session record: what it was about, what was said, what to study  */
/* -------------------------------------------------------------------------- */

/**
 * Bounds on everything the worker writes at teardown. They are here rather
 * than at the writer because two halves enforce them — `convex/http.ts`
 * rejects a body that is absurd, `sessions.recordSummary` clamps a body that
 * is merely long — and a bound that is stated twice is a bound that drifts.
 *
 * The numbers are deliberately above anything a real conversation produces
 * (the worker generates at most 16 vocab and 12 phrases; see
 * `backend/src/review.py`) and below anything that would make a `sessions`
 * row expensive to read on the History list.
 */
export const SUMMARY_LIMITS = {
  /** One line, in the learner's anchor language: what this actually was. */
  aboutChars: 200,
  transcriptTurns: 200,
  turnChars: 500,
  reviewVocab: 40,
  reviewPhrases: 40,
  reviewTables: 8,
  /** Rows in one conjugation table — six persons, with room to spare. */
  tableRows: 12,
  /** Any single string inside the review material. */
  reviewItemChars: 200,
  /** The worker's corrections backstop — the same bounds `sessions.finish`
   * clamps the client's to, because it lands in the same column. */
  corrections: 200,
  correctionChars: 500,
} as const

/**
 * One line of the stored transcript. Deliberately NOT `Turn` from the
 * contract: a stored transcript is a record of what was said, not a live
 * reducer state, so the segment ids, the anchor text and the in-flight flags
 * are dropped. `role` reuses `Speaker` so the two halves cannot disagree about
 * who said what.
 */
export const transcriptTurnValidator = v.object({
  role: v.union(v.literal("learner"), v.literal("tutor")),
  text: v.string(),
})

export type TranscriptRoleMatchesSpeaker = Assert<
  Equals<Infer<typeof transcriptTurnValidator>["role"], Speaker>
>

/** A study pair — mirrors `ReviewItem` in `lib/session/protocol.ts`. */
export const reviewItemValidator = v.object({
  target: v.string(),
  anchor: v.string(),
})

export type ReviewItemMatchesContract = Assert<
  Equals<Infer<typeof reviewItemValidator>, ReviewItem>
>

/** One verb in one tense — mirrors `ConjugationTable`. Deterministic material
 * out of `backend/src/conjugation/`, so the rows are stored in the order they
 * are meant to be read. */
export const conjugationTableValidator = v.object({
  verb: v.string(),
  tense: v.string(),
  rows: v.array(v.object({ person: v.string(), form: v.string() })),
})

export type ConjugationTableMatchesContract = Assert<
  Equals<Infer<typeof conjugationTableValidator>, ConjugationTable>
>

/**
 * The Review snapshot as stored on a finished session — the same three lists
 * the `tutor.review` RPC answers with (`backend/src/review.py`), minus the
 * `ready` flag, which is a property of the poll and not of the material.
 *
 * Stored rather than regenerated because the material is made once per session
 * and then never changes: when the tab closes it is gone, and the summary
 * screen and the History modal both promise it is not.
 */
export const reviewMaterialValidator = v.object({
  vocab: v.array(reviewItemValidator),
  phrases: v.array(reviewItemValidator),
  tables: v.array(conjugationTableValidator),
})

export type ReviewMaterialMatchesContract = Assert<
  Equals<Infer<typeof reviewMaterialValidator>, ReviewMaterial>
>
