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

import type { SessionPlan } from "../lib/session/contract"
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
  vocab: v.array(v.string()),
  level: v.union(v.string(), v.null()),
})

export type SessionPlanMatchesContract = Assert<
  Equals<Infer<typeof sessionPlanValidator>, SessionPlan>
>
