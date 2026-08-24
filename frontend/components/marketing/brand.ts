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

/** Minutes first, price second; never credits. */
export const PACKS = [
  { minutes: 10, price: "$3.99", per: "$3.99 per 10 minutes" },
  { minutes: 50, price: "$15.99", per: "$3.20 per 10 minutes" },
  { minutes: 120, price: "$34.99", per: "$2.92 per 10 minutes" },
] as const

export const PACKS_NOTE = "Minutes never expire. Pausing to study is free."
