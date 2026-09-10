/**
 * Shared marketing constants. The product has no name yet, so the wordmark is
 * a plain lowercase placeholder; the accent is the Aura's blue (the same
 * `#3b82f6` / Tailwind blue-500 family `TutorAura` renders, and now the value
 * of `--primary`), used sparingly —
 * the CTA and one highlight per page, never a wash or a gradient.
 */

import { MINUTE_PACKS, SIGNUP_GRANT_MINUTES } from "@/lib/billing"

export const WORDMARK = "tutor"

/** Inline accent for the single highlight on each page. */
export const ACCENT_TEXT = "text-primary"

/** The grant is quoted from `lib/billing.ts`, never typed out: change the
 * number a new account is given and every place the landing promises it moves
 * with it. */
export const CTA_LABEL = `Start speaking — your first ${SIGNUP_GRANT_MINUTES} minutes are free`

/** The packs, from their one home in `lib/billing.ts` — the app's Billing
 * dialog quotes the same list, and the two must never drift. */
export const PACKS = MINUTE_PACKS

export const PACKS_NOTE = "Minutes never expire. Pausing to study is free."
