/**
 * Money facts that both halves of the app have to agree on.
 *
 * Deliberately dependency-free: this module is imported from Convex functions
 * (`convex/users.ts`, which grants the credit) and from the marketing and
 * onboarding copy that promises it. A number the learner is told and a number
 * the ledger writes must be the same number, so there is exactly one.
 *
 * The unit is SECONDS. The meter counts the seconds a learner actually talks
 * (plans/product-vision.md, 2026-08-24 #1), so the ledger stores seconds and
 * only the copy rounds — a ledger in minutes could not record a 47-second
 * conversation without lying in one direction or the other.
 */

/** How many free seconds a new account starts with. */
export const SIGNUP_GRANT_SECONDS = 600

/** The same grant as the learner is told it: whole minutes. */
export const SIGNUP_GRANT_MINUTES = SIGNUP_GRANT_SECONDS / 60

/** Seconds → whole minutes, the way every balance is displayed. Floors: a
 * learner with 119 seconds has one minute they can count on, not two. */
export function minutesFromSeconds(seconds: number): number {
  return Math.floor(Math.max(0, seconds) / 60)
}

/** Seconds → `m:ss`, the way time is shown wherever exactness matters: the
 * dashboard, the header, the in-session clock. Never rounds. */
export function formatClock(seconds: number): string {
  const total = Math.max(0, Math.floor(seconds))
  const m = Math.floor(total / 60)
  const s = total % 60
  return `${m}:${s.toString().padStart(2, "0")}`
}

/** Under this many seconds the balance is "low": one 5-minute pack. */
export const LOW_BALANCE_SECONDS = 300
