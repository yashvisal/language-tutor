"use client"

/**
 * The clock, as the surface shows it — a STOPWATCH, not a countdown.
 *
 * A session is not a container to fill (plans/product-vision.md, 2026-08-24
 * #1), so there is nothing to count down from: what the learner sees is the
 * time they have talked, counting up. And it visibly stops while the session is
 * held, because that time is free — a frozen number with "paused · free" next
 * to it is the only place the product ever has to explain its own pricing.
 *
 * The worker owns the meter and publishes `tutor.elapsed_s` every five seconds;
 * this interpolates the seconds in between at 1 Hz so the display moves like a
 * clock rather than jumping in fives. Every worker reading re-anchors it, so
 * the drift can never accumulate: the interpolation is a smoothing of the
 * truth, never a substitute for it.
 *
 * One exception to "no countdown": inside the last thirty seconds of the
 * balance the pill turns into "0:30 left", in the accent. That is the honest
 * time-shaped moment — the tutor is being told to finish the thought at the
 * same instant — and it is the only countdown the learner ever sees.
 */

import { useEffect, useState } from "react"

import { formatClock } from "@/lib/billing"
import { cn } from "@/lib/utils"

/** Where the countdown starts. Matches the worker's nudge, by design. */
const REMAINING_THRESHOLD_S = 30

export function SessionClock({
  elapsedSeconds,
  remainingSeconds,
  held,
}: {
  /** The worker's last `tutor.elapsed_s`. Null means no clock, and no pill. */
  elapsedSeconds: number | null
  /** The worker's last `tutor.remaining_s`. Null hides the last-30s state. */
  remainingSeconds: number | null
  /** Whether the session is held — the local hold set or the worker's mirror. */
  held: boolean
}) {
  if (elapsedSeconds === null) return null

  // A new reading from the worker — or the hold flipping — IS a new clock, so
  // it is keyed as one. The interpolation below then only ever counts forward
  // from a fact, and never has to unwind itself back to one.
  return (
    <ClockFace
      key={`${elapsedSeconds}:${held}`}
      elapsedSeconds={elapsedSeconds}
      remainingSeconds={remainingSeconds}
      held={held}
    />
  )
}

function ClockFace({
  elapsedSeconds,
  remainingSeconds,
  held,
}: {
  elapsedSeconds: number
  remainingSeconds: number | null
  held: boolean
}) {
  /** Seconds since this reading landed, at 1 Hz. */
  const [drift, setDrift] = useState(0)
  useEffect(() => {
    // A held session does not tick. That is the whole point of the freeze — an
    // interpolated clock that kept moving would be charging in the UI for time
    // the ledger is not charging for.
    if (held) return
    const from = Date.now()
    const timer = setInterval(
      () => setDrift(Math.floor((Date.now() - from) / 1000)),
      1000
    )
    return () => clearInterval(timer)
  }, [held])

  const elapsed = elapsedSeconds + drift
  const remaining =
    remainingSeconds === null ? null : Math.max(0, remainingSeconds - drift)
  // Never while held: a countdown that is not counting is a worse lie than no
  // countdown, and a held session is exactly where the freeze has to read.
  const ending =
    !held && remaining !== null && remaining <= REMAINING_THRESHOLD_S

  return (
    <div className="pointer-events-none absolute bottom-[4.75rem] left-1/2 z-10 -translate-x-1/2">
      {/* Politely announced: the learner is mid-sentence in a second language,
          and an assertive live region would cut across a screen reader's
          transcript. */}
      <span
        aria-live="polite"
        className={cn(
          "flex items-baseline gap-2 text-[11px] tracking-[0.1em] whitespace-nowrap uppercase transition-colors duration-500",
          ending ? "text-primary" : "text-muted-foreground"
        )}
      >
        <span className="tabular-nums">
          {ending && remaining !== null
            ? `${formatClock(remaining)} left`
            : formatClock(elapsed)}
        </span>
        {held && <span>paused · free</span>}
      </span>
    </div>
  )
}
