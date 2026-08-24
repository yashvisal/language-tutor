/**
 * Shared marketing constants. The product has no name yet, so the wordmark is
 * a plain lowercase placeholder; the accent is the Aura's blue (the same
 * `#3b82f6` / Tailwind blue-500 family `TutorAura` renders, and now the value
 * of `--primary`), used sparingly —
 * the CTA and one highlight per page, never a wash or a gradient.
 */

export const WORDMARK = "tutor"

/** Inline accent for the single highlight on each page. */
export const ACCENT_TEXT = "text-primary"

export const CTA_LABEL = "Start speaking — your first 10 minutes are free"

/**
 * Minutes first, price second; never credits. Sold in fives, cheaper per minute
 * in the larger packs (plans/phases/phase-6-metered-conversation.md).
 */
export const PACKS = [
  { minutes: 5, price: "$1.99", per: "$0.40 per minute" },
  { minutes: 20, price: "$5.99", per: "$0.30 per minute" },
  { minutes: 60, price: "$16.99", per: "$0.28 per minute" },
] as const

export const PACKS_NOTE = "Minutes never expire. Pausing to study is free."
