"use client"

import type { ComponentProps } from "react"
import { useTheme } from "next-themes"
import type { AgentState } from "@livekit/components-react"

import { AgentAudioVisualizerAura } from "@/components/agent-audio-visualizer-aura"

/**
 * The Aura as this product uses it: one color, following the theme.
 *
 * The only difference between a real session and the design playground is where
 * the motion comes from — the tutor's audio track live, a synthesized envelope
 * in replay (`MockAura`) — so both drive this rather than repeating the theme
 * and color wiring.
 */
export function TutorAura({
  state,
  audioTrack,
  volume,
  className,
  ...props
}: {
  state: AgentState
  audioTrack?: ComponentProps<typeof AgentAudioVisualizerAura>["audioTrack"]
  volume?: number
} & Omit<
  ComponentProps<typeof AgentAudioVisualizerAura>,
  "state" | "audioTrack" | "volume" | "themeMode" | "color"
>) {
  const { resolvedTheme } = useTheme()

  return (
    <AgentAudioVisualizerAura
      // The theme's blue (Tailwind blue-500); the theme primary (blue-700)
      // reads darker and moodier against the stage.
      color="#3b82f6"
      themeMode={resolvedTheme === "light" ? "light" : "dark"}
      state={state}
      audioTrack={audioTrack}
      volume={volume}
      {...props}
      className={className}
    />
  )
}

/**
 * Aura sizing on the conversation stage: it is the fixed anchor the text
 * columns re-center beneath, so it scales with viewport height within bounds.
 */
export const STAGE_AURA_CLASS = "h-[clamp(7rem,22vh,12rem)]"
