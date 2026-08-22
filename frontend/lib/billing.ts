/**
 * Money facts that both halves of the app have to agree on.
 *
 * Deliberately dependency-free: this module is imported from Convex functions
 * (`convex/users.ts`, which grants the credit) and from the marketing and
 * onboarding copy that promises it. A number the learner is told and a number
 * the ledger writes must be the same number, so there is exactly one.
 */

/** How many free minutes a new account starts with (one credit). */
export const SIGNUP_GRANT_MINUTES = 10
