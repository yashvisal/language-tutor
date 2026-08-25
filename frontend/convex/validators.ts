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

import type { Correction, SessionPlan } from "../lib/session/contract"
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
