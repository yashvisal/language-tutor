"use client"

/**
 * STAGE SPLIT — chat-layout variant, replay mode.
 *
 * The surface itself lives in `components/session/conversation-stage.tsx` and
 * is shared verbatim with the real session at `/session`. The only difference
 * is the producer: here the scripted mock drives the reducer, and the Aura is
 * synthesized rather than fed by a real agent track. Deterministic states stay
 * far faster to iterate UI against than real voice, so this page is permanent.
 */

import { useReducer } from "react"

import { ConversationStage } from "@/components/session/conversation-stage"
import { MockAura } from "@/components/design/mock-aura"
import {
  MOCK_INTERIM_SEGMENT_ID,
  useMockSession,
} from "@/lib/session/mock-producer"

export default function StageSplitPage() {
  const { state, dispatch } = useMockSession()
  const [muted, toggleMute] = useReducer((v: boolean) => !v, false)

  return (
    <ConversationStage
      state={state}
      dispatch={dispatch}
      muted={muted}
      onToggleMute={toggleMute}
      interimSegmentId={MOCK_INTERIM_SEGMENT_ID}
      // Replay has no connection to hang up; the control stays for layout
      // fidelity with the live surface.
      onEnd={() => {}}
      renderAura={(auraState) => (
        <MockAura
          state={auraState}
          size="lg"
          className="h-[clamp(7rem,22vh,12rem)]"
        />
      )}
    />
  )
}
