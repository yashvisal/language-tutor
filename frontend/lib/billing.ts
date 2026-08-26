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

/**
 * The packs, minutes first and price second — never credits. Sold in fives and
 * cheaper per minute at the top (plans/phases/phase-6-metered-conversation.md).
 *
 * Here rather than in the marketing constants because two surfaces now quote
 * them: the pricing section on the landing page and the Billing dialog in the
 * app. Same rule as the signup grant — a number the learner is told is a number
 * with exactly one home.
 */
export const MINUTE_PACKS = [
  { minutes: 5, price: "$1.99", per: "$0.40 per minute" },
  { minutes: 20, price: "$5.99", per: "$0.30 per minute" },
  { minutes: 60, price: "$16.99", per: "$0.28 per minute" },
] as const

/* -------------------------------------------------------------------------- */
/*  The one-open-session guard                                                */
/* -------------------------------------------------------------------------- */

/**
 * How long a `sessions` row with no `endedAt` blocks the same learner from
 * starting another conversation.
 *
 * Two tabs would each be dispatched a worker that budgets the *whole* balance
 * (`clock.py`), both would debit at teardown, and the ledger would go negative
 * by (N-1) x balance. Nothing reserves the balance at mint time, so the row
 * itself is the reservation.
 *
 * Fifteen minutes rather than forever because `endedAt` is not guaranteed: a
 * killed worker or a closed tab leaves the row open, and a learner locked out
 * of their own account by a crash is a worse bug than the one being fixed.
 * The reconciliation cron (`convex/crons.ts`) closes what is left after two
 * hours; this window is what the learner feels.
 */
export const OPEN_SESSION_WINDOW_MS = 15 * 60 * 1000

/**
 * Prefix on the error `sessions.start` throws when that guard fires.
 *
 * A Convex mutation failure reaches the token route as text, so the only way
 * to tell "you already have one open" (a 409, a state) from "the write failed"
 * (a 500, a fault) is a marker in the message. Kept beside the window it
 * guards so the two never drift.
 */
export const OPEN_SESSION_PREFIX = "open-session:"
