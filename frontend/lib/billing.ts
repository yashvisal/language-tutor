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
export const SIGNUP_GRANT_SECONDS = 300

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
/*  The session lease                                                         */
/* -------------------------------------------------------------------------- */

/**
 * How long a `sessions` row counts as a live conversation after the worker
 * last renewed it.
 *
 * The row is the one-open-session reservation: two tabs would each be
 * dispatched a worker that budgets the *whole* balance (`clock.py`), both
 * would debit, and the ledger would go negative by (N-1) x balance. The
 * reservation is owned by the WORKER — it opens the row when it joins the
 * room (`POST /tutor/open`), renews it every `LEASE_RENEW_S` whether the
 * clock is running or held, and its final debit closes it. Nothing the
 * browser sends can release it (audit 2026-09-06, L1).
 *
 * Three minutes is two missed renewals plus slack: a killed worker frees the
 * learner in three minutes instead of fifteen, and a two-hour conversation
 * is never mistaken for an abandoned one while its worker is alive (L2).
 * The reconciliation cron closes what has expired.
 */
export const LEASE_TTL_MS = 3 * 60 * 1000

/** How often the worker renews, in seconds. Here because the ledger's TTL
 * above is sized from it, and the two must not drift; the worker's copy in
 * `backend/src/billing.py` is asserted against this by its tests. */
export const LEASE_RENEW_S = 60

/**
 * The most one debit report may add to a session's `secondsBilled`.
 *
 * The worker reports every 60 active seconds and five consecutive failures
 * end the session (phase 7 step 1 contracts), so a legitimate catch-up is
 * minutes, never an hour. A larger delta is a bug or a leaked credential, and
 * Convex refuses the whole report — nothing billed, the mark unmoved — rather
 * than clamping it, which would silently bill the wrong amount.
 */
export const MAX_DELTA_PER_CALL_S = 3600

/** Prefix on the error `sessions.debit` throws for that refusal, so the HTTP
 * action can answer 400 (a bad request) rather than 500 (a fault). */
export const DELTA_CAP_PREFIX = "delta-cap:"

/* -------------------------------------------------------------------------- */
/*  The session-start rate limit                                              */
/* -------------------------------------------------------------------------- */

/**
 * How many conversations one learner may START in a rolling hour.
 *
 * The free grant is per Clerk id and signup is instant, so nothing but this
 * stands between a script and N accounts x ten free minutes (audit B12). The
 * other half of that fix is at Clerk — bot protection and required email
 * verification — and belongs to the production instance, not to the code.
 *
 * Twelve, because the two populations have to be separable by this number
 * alone. A real learner starts a handful of conversations in an hour and may
 * retry a failed start a few times on top of that; twelve is well above
 * anything that is not deliberate. A script minting rooms to burn grants does
 * hundreds, and hits it in seconds.
 *
 * Counted off `sessions.by_user_startedAt`, which already exists for History
 * and the open-session guard — no new table, no counter to keep in sync, and
 * the count is bounded by this number rather than by how many rows there are.
 */
export const MAX_STARTS_PER_HOUR = 12

/** The window those starts are counted over. */
export const START_WINDOW_MS = 60 * 60 * 1000

/*
 * Ordering matters and is tested: the open-session check runs FIRST, in both
 * `sessions.startCheck` and `sessions.open`. A second tab is a thing the
 * learner can act on ("end it there"), and it must keep saying so even for a
 * learner who is also near the hourly limit.
 */
