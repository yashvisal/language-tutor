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
import { MoveRight } from "lucide-react"

import { Overline } from "@/components/overline"
import type {
  SessionEndReason,
  TranslationLookup,
} from "@/lib/session/contract"
import { ANCHOR_LANGUAGE, TARGET_LANGUAGE } from "@/lib/session/protocol"
import { cn } from "@/lib/utils"

/**
 * ONE CORRECTION, ONE ROW: what was said, an arrow, what should have been.
 *
 * Written three times before this existed — in the mark's popover on the live
 * stage, in the post-session summary, and in the History modal — with three
 * different arrow colours and the `lang` attribute on two of the three. A
 * learner meets the same correction on all three surfaces, so it is one shape.
 *
 * The row is target-language text throughout, hence `lang` on the container:
 * the two halves are the same sentence, one wrong and one right.
 */
export function CorrectionDiff({
  original,
  replacement,
  /** The category's colour where the surface has one; plain otherwise. */
  accentClassName,
  className,
}: {
  original: string
  replacement: string
  accentClassName?: string
  className?: string
}) {
  return (
    <p
      lang={TARGET_LANGUAGE}
      className={cn(
        "flex flex-wrap items-center gap-x-2 gap-y-0.5 text-sm",
        className
      )}
    >
      <span className="text-muted-foreground line-through decoration-muted-foreground/40">
        {original}
      </span>
      <MoveRight
        aria-hidden
        className="size-3.5 shrink-0 text-muted-foreground"
      />
      <span className={cn("font-medium", accentClassName ?? "text-foreground")}>
        {replacement}
      </span>
    </p>
  )
}

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
  // Nobody closed the row: the tab went away without a goodbye and the
  // reconciliation cron finished it hours later. Stated as what happened, not
  // as a fault — the seconds were billed either way.
  stale: "The session was left open and closed later.",
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
