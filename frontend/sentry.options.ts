/**
 * The options every Sentry surface in this app shares.
 *
 * Kept in one file because the three init sites (client, server, edge) must
 * agree: a scrubber that runs on the server and not in the browser is not a
 * scrubber. Nothing here reads a DSN — each init site decides whether it has
 * one, and initialises nothing when it does not.
 */
import type { ErrorEvent } from "@sentry/nextjs"

/** 10% of transactions. Errors are always sent; this is tracing only. */
export const SENTRY_TRACES_SAMPLE_RATE = 0.1

/**
 * Keys that carry what a learner actually said. Phase 8 decision (b): ids
 * only, never transcript — so these never leave the process, whatever put
 * them on the event.
 */
const REDACTED_KEYS = new Set(["transcript", "text"])

function scrubRecord(record: Record<string, unknown> | undefined) {
  if (!record) return
  for (const key of Object.keys(record)) {
    if (REDACTED_KEYS.has(key)) delete record[key]
  }
}

/**
 * `beforeSend`: drop any `transcript` / `text` key from the event's extras and
 * from every context object before it goes out.
 */
export function scrubLearnerText(event: ErrorEvent): ErrorEvent {
  scrubRecord(event.extra)
  if (event.contexts) {
    for (const context of Object.values(event.contexts)) {
      scrubRecord(context as Record<string, unknown> | undefined)
    }
  }
  return event
}
