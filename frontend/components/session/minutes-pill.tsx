"use client"

/**
 * The clock, as the surface shows it.
 *
 * The worker owns the meter: this renders `tutor.minutes_left` verbatim and
 * computes nothing. If the attribute has not arrived (a replay surface, a
 * worker without the clock) the pill does not exist — a session with no visible
 * clock is better than a session with an invented one.
 *
 * The last minute gets its own state, and it is an invitation rather than an
 * alarm: no red, no countdown, no motion. The tutor is being told to bring the
 * conversation to a close at the same moment, so the learner should feel a
 * natural ending arriving, not a timer expiring.
 */

import type { AriaAttributes } from "react"

import { cn } from "@/lib/utils"

export function MinutesPill({ minutesLeft }: { minutesLeft: number | null }) {
  if (minutesLeft === null) return null

  const wrapping = minutesLeft <= 1
  const label = wrapping
    ? minutesLeft === 0
      ? "Wrapping up"
      : "About a minute left — find a good place to stop"
    : `${minutesLeft} min left`

  // Politely announced: the learner is mid-sentence in a second language, and
  // an assertive live region would cut across a screen reader's transcript.
  const live: AriaAttributes["aria-live"] = "polite"

  return (
    <div className="pointer-events-none absolute bottom-[4.75rem] left-1/2 z-10 -translate-x-1/2">
      <span
        aria-live={live}
        className={cn(
          "text-[11px] tracking-[0.1em] whitespace-nowrap uppercase transition-colors duration-500",
          wrapping ? "text-primary/80" : "text-muted-foreground/50"
        )}
      >
        {label}
      </span>
    </div>
  )
}
