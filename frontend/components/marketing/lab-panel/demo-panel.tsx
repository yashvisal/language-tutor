"use client"

/**
 * The demo as a product screen rather than a card.
 *
 * A framed panel with the session's own chrome in its top corners — the
 * state on the left, the clock on the right — and the real stage inside it.
 * The chrome is the product's, not an invention: the session shows an agent
 * state and a clock in a small tracked label, so this shows the
 * same two things in the same type, and nothing else.
 *
 * Measurements are the Paper "H4 panel stage" hero (2026-09-13): 896 wide,
 * 16px radius, 48px of padding at the top and sides and 40px below, the
 * chrome 18px down and 20px in, a 6px dot, a 176px orb. The chrome floats in
 * the corners rather than sitting in its own ruled row: a divider under it
 * turned the screen back into a card with a title bar.
 */

import { useCallback, useEffect, useState } from "react"
import type { AgentState } from "@livekit/components-react"
import { useReducedMotion } from "motion/react"

import { LabDemoConversation } from "@/components/marketing/lab-panel/demo-conversation"
import { PANEL_SURFACE } from "@/components/marketing/lab-panel/surface"
import { formatClock, SIGNUP_GRANT_MINUTES } from "@/lib/billing"
import { cn } from "@/lib/utils"

/** Paper's chrome labels are a step smaller and wider-spaced than the
 * product's overline: 10px at 0.22em, the same scale as the demo's own
 * "YOU" speaker label, so the three labels inside the screen agree. */
const CHROME_CLASS =
  "text-[10px] font-medium tracking-[0.22em] text-muted-foreground/70 uppercase"

/** Where the demo's clock starts — the grant, a little way in, so the number
 * reads as a session in progress rather than a session about to begin. */
const DEMO_START_SECONDS = SIGNUP_GRANT_MINUTES * 60 - 48

export function DemoPanel({ className }: { className?: string }) {
  const [state, setState] = useState<AgentState>("listening")
  // Identity-stable so the demo's reporting effect does not re-run each tick.
  const onStateChange = useCallback((next: AgentState) => setState(next), [])

  return (
    <div
      className={cn(
        PANEL_SURFACE,
        "relative overflow-hidden px-6 pt-12 pb-10 sm:px-12",
        className
      )}
    >
      <div className="absolute top-[18px] left-5">
        <StateIndicator state={state} />
      </div>
      <span
        className={cn(CHROME_CLASS, "absolute top-[18px] right-5 tabular-nums")}
      >
        <DemoClock /> left
      </span>

      <LabDemoConversation
        auraClassName="h-[176px]"
        onStateChange={onStateChange}
      />
    </div>
  )
}

/**
 * The dot is one of the four places blue is allowed on this page, and it is
 * the product's own meaning of it: the tutor's light. "Thinking" is folded
 * into LISTENING — the learner's turn has not ended yet, and a third label
 * flickering past for a second reads as a glitch.
 */
function StateIndicator({ state }: { state: AgentState }) {
  const speaking = state === "speaking"
  return (
    <span className={cn(CHROME_CLASS, "flex items-center gap-2")}>
      <span
        aria-hidden
        className={cn(
          "size-1.5 rounded-full transition-colors duration-300",
          speaking ? "bg-primary" : "bg-primary/45"
        )}
      />
      {speaking ? "Speaking" : "Listening"}
    </span>
  )
}

/** A plausible meter: one second a second, from a fixed start. Frozen under
 * reduced motion — a number that only ticks is not worth the repaint. */
function DemoClock() {
  const reducedMotion = useReducedMotion()
  const [seconds, setSeconds] = useState(DEMO_START_SECONDS)
  useEffect(() => {
    if (reducedMotion) return
    const timer = setInterval(
      () => setSeconds((s) => (s <= 1 ? DEMO_START_SECONDS : s - 1)),
      1000
    )
    return () => clearInterval(timer)
  }, [reducedMotion])
  return <>{formatClock(seconds)}</>
}
