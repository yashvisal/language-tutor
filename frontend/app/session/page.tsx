"use client"

/**
 * The real conversation surface.
 *
 * Identical to the design playground's stage-split page in every respect but
 * two: the reducer is fed by the live LiveKit adapter instead of the scripted
 * mock, and the Aura is driven by the tutor's actual audio track.
 *
 * The page owns only what wraps that surface — the pre-flight where the learner
 * declares a plan, the connection lifecycle, and the summary the session ends
 * into. Three states, in the order a learner meets them: plan, talk, look back.
 */

import { useState, useSyncExternalStore } from "react"
import { RoomAudioRenderer } from "@livekit/components-react"

import { ConversationStage } from "@/components/session/conversation-stage"
import { SessionPreflight } from "@/components/session/session-preflight"
import { SessionSummary } from "@/components/session/session-summary"
import { STAGE_AURA_CLASS, TutorAura } from "@/components/session/tutor-aura"
import type { SessionPlan } from "@/lib/session/contract"
import { useLiveSession } from "@/lib/session/live-producer"
import {
  planSnapshot,
  savePlan,
  serverPlanSnapshot,
  subscribeToPlan,
} from "@/lib/session/plan"

export default function SessionPage() {
  const live = useLiveSession()

  /**
   * The plan. The last session's is the starting point (an external store, so
   * that a client-only value never contradicts the prerendered markup — see
   * `plan.ts`); edits layer on top and win from the first keystroke.
   */
  const stored = useSyncExternalStore(
    subscribeToPlan,
    planSnapshot,
    serverPlanSnapshot
  )
  const [edited, setEdited] = useState<SessionPlan | null>(null)
  const plan = edited ?? stored

  // The summary outlives the room, so it wins over the connection state: a
  // session ended by the clock disconnects us, and dropping straight back to
  // the pre-flight would throw away the corrections the learner just earned.
  if (live.outcome) {
    return (
      <SessionSummary
        outcome={live.outcome}
        onStartAnother={live.clearOutcome}
      />
    )
  }

  if (live.connection !== "live") {
    return (
      <SessionPreflight
        plan={plan}
        onChange={setEdited}
        connecting={live.connection === "connecting"}
        error={live.error}
        onStart={() => {
          // Persisted at the moment of use, so a repeat session opens on the
          // plan that was actually spoken — not on an abandoned edit.
          savePlan(plan)
          live.connect(plan)
        }}
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
        minutesLeft={live.minutesLeft}
        translate={live.translate}
        study={live.study}
        focusTenses={live.plan?.tenses}
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
