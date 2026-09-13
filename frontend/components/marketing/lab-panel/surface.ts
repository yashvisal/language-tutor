/**
 * The one surface treatment the panel page uses: lifted in light, recessed in
 * dark. Shared so the hero panel and the three miniatures are one language.
 *
 * Its own module, without "use client": a string exported from a client
 * module reaches a server component as a client reference, not a string, and
 * `cn` silently dropped it — the miniatures rendered with no frame at all.
 */
export const PANEL_SURFACE =
  "rounded-2xl border border-border/60 bg-muted/40 shadow-xs dark:bg-card/40 dark:shadow-none"
