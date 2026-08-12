"use client"

import { useEffect, useRef, useState, type ComponentProps } from "react"
import type { AgentState } from "@livekit/components-react"

import { TutorAura } from "@/components/session/tutor-aura"

/**
 * The session Aura, drivable without any LiveKit session: when `state` is
 * "speaking" a fake volume signal is synthesized so the aura moves like it's
 * talking. Everything else (color, theme) is `TutorAura`'s — this is the real
 * component with a synthetic signal, not a lookalike.
 */
export function MockAura({
  state = "listening",
  ...props
}: { state?: AgentState } & Omit<
  ComponentProps<typeof TutorAura>,
  "audioTrack" | "volume" | "state"
>) {
  const volume = useFakeVolume(state === "speaking")

  return <TutorAura state={state} volume={volume} {...props} />
}

/**
 * Synthesizes a plausible speech-volume envelope (syllable-ish pulses with
 * pauses) while `active`; returns undefined otherwise so the aura falls back
 * to its state animation.
 */
function useFakeVolume(active: boolean): number | undefined {
  // Adjusted during render rather than reset in an effect: reactivating must
  // start from silence on the very first painted frame, not replay the last
  // frame of the previous phrase.
  const [snapshot, setSnapshot] = useState({ active, volume: 0 })
  if (snapshot.active !== active) setSnapshot({ active, volume: 0 })

  const frame = useRef<number>(0)

  useEffect(() => {
    if (!active) return
    let raf: number
    const start = performance.now()
    const tick = (now: number) => {
      const t = (now - start) / 1000
      // Syllable pulses (~5 Hz) inside phrase envelopes (~0.4 Hz) with pauses.
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

/** All agent states worth exercising in design exploration, in cycle order. */
export const DEMO_STATES: AgentState[] = [
  "idle",
  "connecting",
  "initializing",
  "listening",
  "thinking",
  "speaking",
]
