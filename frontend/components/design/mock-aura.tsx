"use client"

import { useEffect, useRef, useState, type ComponentProps } from "react"
import { useTheme } from "next-themes"
import type { AgentState } from "@livekit/components-react"

import { AgentAudioVisualizerAura } from "@/components/agent-audio-visualizer-aura"

/**
 * Theme-aware Aura for design exploration, drivable without any LiveKit
 * session. Pass a `state`; when `state` is "speaking" a fake volume signal is
 * synthesized so the aura moves like it's talking.
 *
 * Color defaults to the theme's blue (Tailwind blue-500). The theme primary
 * (blue-700, #1d4ed8) reads darker/moodier — try both.
 */
export function MockAura({
  state = "listening",
  ...props
}: { state?: AgentState } & Omit<
  ComponentProps<typeof AgentAudioVisualizerAura>,
  "audioTrack" | "volume" | "themeMode" | "state"
>) {
  const { resolvedTheme } = useTheme()
  const volume = useFakeVolume(state === "speaking")

  return (
    <AgentAudioVisualizerAura
      color="#3b82f6"
      state={state}
      volume={volume}
      themeMode={resolvedTheme === "light" ? "light" : "dark"}
      {...props}
    />
  )
}

/**
 * Synthesizes a plausible speech-volume envelope (syllable-ish pulses with
 * pauses) while `active`; returns undefined otherwise so the aura falls back
 * to its state animation.
 */
function useFakeVolume(active: boolean): number | undefined {
  const [volume, setVolume] = useState<number | undefined>(undefined)
  const frame = useRef<number>(0)

  useEffect(() => {
    if (!active) {
      setVolume(undefined)
      return
    }
    let raf: number
    const start = performance.now()
    const tick = (now: number) => {
      const t = (now - start) / 1000
      // Syllable pulses (~5 Hz) inside phrase envelopes (~0.4 Hz) with pauses.
      const phrase = Math.max(0, Math.sin(t * 0.8) * 0.6 + 0.55)
      const syllable = 0.5 + 0.5 * Math.sin(t * 9 + Math.sin(t * 3.7) * 2)
      const jitter = 0.9 + 0.1 * Math.sin(t * 27.3)
      frame.current = Math.min(1, phrase * (0.35 + 0.65 * syllable) * jitter)
      setVolume(frame.current)
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [active])

  return volume
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
