"use client"

/**
 * The real conversation surface.
 *
 * Identical to the design playground's stage-split page in every respect but
 * two: the reducer is fed by the live LiveKit adapter instead of the scripted
 * mock, and the Aura is driven by the tutor's actual audio track.
 *
 * The page owns only the connection lifecycle around that surface — an idle
 * screen, a connecting state, and the hang-up path.
 */

import { RoomAudioRenderer } from "@livekit/components-react"

import { ConversationStage } from "@/components/session/conversation-stage"
import { STAGE_AURA_CLASS, TutorAura } from "@/components/session/tutor-aura"
import { Button } from "@/components/ui/button"
import { useLiveSession } from "@/lib/session/live-producer"

export default function SessionPage() {
  const live = useLiveSession()

  if (live.connection !== "live") {
    return (
      <Idle
        connecting={live.connection === "connecting"}
        error={live.error}
        onConnect={live.connect}
      />
    )
  }

  return (
    <div className="h-svh">
      {/* Without this the tutor is inaudible: nothing else attaches remote
          audio tracks to the page. */}
      <RoomAudioRenderer room={live.room} />
      <ConversationStage
        state={live.state}
        dispatch={live.dispatch}
        muted={live.muted}
        onToggleMute={live.toggleMute}
        onEnd={live.disconnect}
        renderAura={(auraState) => (
          <TutorAura
            state={auraState}
            audioTrack={live.agentAudioTrack}
            size="lg"
            className={STAGE_AURA_CLASS}
          />
        )}
      />
    </div>
  )
}

/**
 * The room before it exists. Deliberately bare: one sentence of orientation
 * and one control, so the first thing the learner does is speak.
 */
function Idle({
  connecting,
  error,
  onConnect,
}: {
  connecting: boolean
  error: string | null
  onConnect: () => void
}) {
  return (
    <div className="flex h-svh flex-col items-center justify-center gap-6 bg-background px-8">
      <p className="max-w-sm text-center text-sm leading-relaxed text-muted-foreground">
        A Spanish conversation, with the English underneath and corrections when
        you finish a thought.
      </p>
      <Button size="lg" onClick={onConnect} disabled={connecting}>
        {connecting ? "Connecting…" : "Start talking"}
      </Button>
      {error && (
        <p className="max-w-sm text-center text-xs text-destructive">{error}</p>
      )}
      <p className="text-[10px] tracking-[0.14em] text-muted-foreground/50 uppercase">
        Microphone required
      </p>
    </div>
  )
}
