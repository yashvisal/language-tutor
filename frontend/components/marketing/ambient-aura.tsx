"use client"

import { useEffect, useRef, useState } from "react"
import type { AgentState } from "@livekit/components-react"

import { TutorAura } from "@/components/session/tutor-aura"

/**
 * The session Aura on a public page.
 *
 * This is the real `TutorAura` — same shader, same blue, same theme wiring —
 * driven by a synthesized envelope instead of a LiveKit track, so it stands
 * alone with no room, no token and no microphone. Nothing about the visualizer
 * is reimplemented here: what a visitor sees on the landing page is exactly
 * what they will see in a session.
 */
export function AmbientAura({
  state = "listening",
  className,
}: {
  state?: AgentState
  className?: string
}) {
  const volume = useAmbientVolume(state === "speaking")

  return (
    <TutorAura
      state={state}
      volume={volume}
      className={className}
      aria-hidden
    />
  )
}

/**
 * A plausible speech envelope — syllable pulses inside phrase-length swells —
 * so the "speaking" beat of the landing demo moves like speech rather than
 * pulsing on a timer. Returns undefined when inactive so the aura falls back
 * to its own state animation.
 */
function useAmbientVolume(active: boolean): number | undefined {
  // Kept in a single snapshot, adjusted during render, so re-activating starts
  // from silence on the first painted frame instead of replaying the last one.
  const [snapshot, setSnapshot] = useState({ active, volume: 0 })
  if (snapshot.active !== active) setSnapshot({ active, volume: 0 })

  const frame = useRef(0)

  useEffect(() => {
    if (!active) return
    let raf = 0
    const start = performance.now()
    const tick = (now: number) => {
      const t = (now - start) / 1000
      const phrase = Math.max(0, Math.sin(t * 0.8) * 0.6 + 0.55)
      const syllable = 0.5 + 0.5 * Math.sin(t * 9 + Math.sin(t * 3.7) * 2)
      const jitter = 0.9 + 0.1 * Math.sin(t * 27.3)
      frame.current = Math.min(1, phrase * (0.35 + 0.65 * syllable) * jitter)
      setSnapshot({ active: true, volume: frame.current })
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [active])

  return active ? snapshot.volume : undefined
}
