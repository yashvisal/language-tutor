"use client"

/**
 * ONE CONVERSATION, ONE RECORD.
 *
 * The post-session summary and the History modal render the same stored row —
 * `sessions.byRoom` — and the pieces of it that are not corrections, Review
 * material or transcript live here, for the same reason `review-material.tsx`
 * and `transcript-record.tsx` exist: the two surfaces must not be able to tell
 * different stories about one conversation, and the cheapest way to guarantee
 * that is for there to be one component per fact.
 *
 * Purely presentational, and every piece renders NOTHING when it has nothing:
 * a session with no goal, a clean ending, no questions and no lookups is an
 * ordinary session, not a record full of empty headings.
 *
 * Nothing here is a metric. `turns` and `anchorRatio` ride the same record and
 * are deliberately not rendered anywhere — a turn count is a score, and the
 * vision doc's "calm over gamified" is not negotiable for a number that would
 * make a short honest conversation look like a failure.
 */

import type { ReactNode } from "react"

import { Overline } from "@/components/overline"
import type {
  SessionEndReason,
  TranslationLookup,
} from "@/lib/session/contract"
import { ANCHOR_LANGUAGE, TARGET_LANGUAGE } from "@/lib/session/protocol"
import { cn } from "@/lib/utils"

/**
 * What was set out to be done, against `about`'s what was actually done.
 *
 * Deliberately the plainest possible presentation — the label and the line the
 * learner and the tutor agreed on, verbatim. "You set out to…" was the other
 * candidate and it editorializes: it turns a record into a verdict on whether
 * they got there, which is precisely the reading this product does not want.
 */
export function GoalLine({
  goal,
  /** The label above it. "Today" while the session is live, "Goal" after. */
  label = "Goal",
  className,
}: {
  goal: string | null | undefined
  label?: string
  className?: string
}) {
  const text = goal?.trim()
  if (!text) return null
  return (
    <div className={className}>
      <Overline>{label}</Overline>
      <p
        lang={ANCHOR_LANGUAGE}
        className="mt-1.5 text-sm leading-relaxed text-foreground"
      >
        {text}
      </p>
    </div>
  )
}

/**
 * Why it stopped, in plain words, when that is worth saying.
 *
 * `"ended"` and a missing reason both render nothing: a conversation that
 * ended is not an event. The rest are stated flatly and without blame — no
 * red, no icon, no "error". A learner whose tutor dropped out did nothing
 * wrong, and the sentence they get should read like the weather.
 */
const END_REASON_NOTES: Partial<Record<SessionEndReason, string>> = {
  learner_left: "The connection dropped.",
  hold_idle: "The session timed out while paused.",
  out_of_minutes_idle: "The session ended after running out of minutes.",
  model_error: "The tutor lost its connection.",
  ledger_failure:
    "We couldn't reach the account service, so the session ended early.",
  tutor_silent: "The tutor never joined.",
}

/** The sentence for a stored reason, or null where there is nothing to say. */
export function endReasonNote(
  reason: SessionEndReason | null | undefined
): string | null {
  if (!reason) return null
  return END_REASON_NOTES[reason] ?? null
}

export function EndReasonNote({
  reason,
  className,
}: {
  reason: SessionEndReason | null | undefined
  className?: string
}) {
  const note = endReasonNote(reason)
  if (note === null) return null
  return (
    <p
      className={cn("text-sm leading-relaxed text-muted-foreground", className)}
    >
      {note}
    </p>
  )
}

/**
 * The questions the learner asked during their holds.
 *
 * The answers do not travel with them, and that is on purpose: the answer was
 * for the moment it was asked in, while the QUESTION is the record — it is the
 * sharpest thing a session produces about what someone did not yet understand.
 */
export function AsksList({
  asks,
  className,
}: {
  asks: readonly string[] | null | undefined
  className?: string
}) {
  if (!asks || asks.length === 0) return null
  return (
    <RecordSection label="You asked" className={className}>
      <ul className="space-y-1.5">
        {asks.map((question, index) => (
          <li
            key={`${index}-${question}`}
            lang={ANCHOR_LANGUAGE}
            className="text-sm leading-relaxed text-foreground"
          >
            {question}
          </li>
        ))}
      </ul>
    </RecordSection>
  )
}

/**
 * Every span the learner selected and had translated, source beside gloss —
 * the same two-column grammar as the Review vocabulary list, because it is the
 * same kind of thing: a pair worth reading again.
 */
export function LookupsList({
  lookups,
  className,
}: {
  lookups: readonly TranslationLookup[] | null | undefined
  className?: string
}) {
  if (!lookups || lookups.length === 0) return null
  return (
    <RecordSection label="You looked up" className={className}>
      <dl className="text-sm">
        {lookups.map((lookup, index) => (
          <div
            key={`${index}-${lookup.source}`}
            className="flex gap-6 border-t border-border/40 py-1.5 first:border-t-0"
          >
            <dt
              lang={TARGET_LANGUAGE}
              className="flex-1 tracking-[-0.011em] text-foreground"
            >
              {lookup.source}
            </dt>
            <dd lang={ANCHOR_LANGUAGE} className="flex-1 text-muted-foreground">
              {lookup.translation}
            </dd>
          </div>
        ))}
      </dl>
    </RecordSection>
  )
}

/** A labelled block of the record. One label style in the product. */
function RecordSection({
  label,
  className,
  children,
}: {
  label: string
  className?: string
  children: ReactNode
}) {
  return (
    <section className={className}>
      <Overline>{label}</Overline>
      <div className="mt-3">{children}</div>
    </section>
  )
}
