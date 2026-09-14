/**
 * Shared marketing constants. The product is lengua (lengua.chat); the wordmark is
 * plain lowercase; the accent is the Aura's blue (the same
 * `#3b82f6` / Tailwind blue-500 family `TutorAura` renders, and now the value
 * of `--primary`), used sparingly —
 * the CTA and one highlight per page, never a wash or a gradient.
 */

import { MINUTE_PACKS, SIGNUP_GRANT_MINUTES } from "@/lib/billing"

export const WORDMARK = "lengua"

/** Inline accent for the single highlight on each page. */
export const ACCENT_TEXT = "text-primary"

/** The grant is quoted from `lib/billing.ts`, never typed out: change the
 * number a new account is given and every place the landing promises it moves
 * with it. */
export const CTA_LABEL = `Start speaking — your first ${SIGNUP_GRANT_MINUTES} minutes are free`

/** The packs, from their one home in `lib/billing.ts` — the app's Billing
 * dialog quotes the same list, and the two must never drift. */
export const PACKS = MINUTE_PACKS

/* -------------------------------------------------------------------------- */
/*  Legal placeholders                                                        */
/* -------------------------------------------------------------------------- */

/**
 * The values the legal pages need and the product has not all settled. They
 * live here, once each, so that signing them off is a single edit in a single
 * file rather than a hunt through two documents — and so that the draft flag
 * on `LegalPage` and the values it warns about can never drift apart.
 *
 * Every constant below is: to confirm with Yash before removing the draft flag.
 */

/** Where support, refund requests and data requests go. Yash's own address
 * for now (settled 2026-09-14); a lengua.chat mailbox can replace it here. */
export const SUPPORT_EMAIL = "yashvisal@gmail.com"

/** Reads inside "governed by the laws of ___, and disputes go to the courts
 * there". Deliberately still the hedge the draft has always carried rather
 * than a jurisdiction nobody has chosen. */
export const GOVERNING_LAW = "the place we operate from"

/** The age floor stated in the privacy policy's Children section. */
export const MINIMUM_AGE = 16

/** How long after a purchase unused minutes can be refunded. Nothing can be
 * bought yet, so this binds nobody until checkout ships. */
export const REFUND_WINDOW_DAYS = 14

/** The date both documents print at the top. Move it whenever the copy
 * changes, not whenever the file is touched. */
export const LEGAL_LAST_UPDATED = "2026-09-14"
