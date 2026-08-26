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
 *
 * `/home` is the same pre-flight inside the app shell, so it hands off with
 * `?start=1`: the plan is already persisted, and this page connects straight
 * away instead of asking the same questions a second time. Without the flag
 * (a direct visit, a bookmark) the page still opens on its own pre-flight.
 */

import {
  Suspense,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react"
import Link from "next/link"
import { useRouter, useSearchParams } from "next/navigation"
import { ArrowLeft } from "lucide-react"
import { RoomAudioRenderer } from "@livekit/components-react"

import { ConversationStage } from "@/components/session/conversation-stage"
import { OutOfMinutesScreen } from "@/components/session/out-of-minutes"
import { SessionPreflight } from "@/components/session/session-preflight"
import { SessionSummary } from "@/components/session/session-summary"
import { TutorUnavailableScreen } from "@/components/session/tutor-unavailable"
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
  // `useSearchParams` needs a boundary to fall back to during prerender.
  return (
    <Suspense fallback={null}>
      <Session />
    </Suspense>
  )
}

function Session() {
  const live = useLiveSession()
  const { connect } = live
  const router = useRouter()
  const autostart = useSearchParams().get("start") === "1"

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

  /**
   * The hand-off from `/home`, fired once and then erased. The ref makes it
   * once within this mount — after a session ends the learner is back on this
   * page, and "start another" must mean the button, not the address bar — and
   * dropping the flag from the URL makes it once across mounts too, so a
   * reload cannot reconnect and bill a second session.
   */
  const handedOff = useRef(false)
  useEffect(() => {
    if (!autostart || handedOff.current) return
    handedOff.current = true
    connect(planSnapshot())
    // And the flag is spent: it survives in the address bar otherwise, so a
    // reload — or a shared link — would silently open a second billed session.
    // The ref only guards this mount.
    router.replace("/session")
  }, [autostart, connect, router])

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

  // The room came up without a tutor in it (audit B6). Above the pre-flight
  // and above the connecting screen, because a failed start that fell back to
  // either would look exactly like the session never being attempted. Try
  // again dials the same plan — `connect` clears the failure itself.
  if (live.tutorFailed) {
    return (
      <TutorUnavailableScreen
        reason={live.tutorFailed}
        onRetry={() => live.connect(live.plan ?? plan)}
      />
    )
  }

  // The token route refused: no room was ever opened, so there is nothing to
  // pre-flight. The card is the whole screen, and it is the same card a session
  // held at zero shows over the conversation.
  if (live.outOfMinutes && live.connection !== "live") {
    return <OutOfMinutesScreen />
  }

  // Handed off from the dashboard, or already dialling: the learner chose to
  // start, so the only honest screen is the stage warming up — not the form
  // they just filled in flashing past on its way to the conversation.
  if (autostart || live.connection === "connecting") {
    return (
      <div className="flex h-svh flex-col items-center justify-center gap-6 bg-background">
        <TutorAura state="connecting" className={STAGE_AURA_CLASS} />
        <p className="text-sm text-muted-foreground">Connecting…</p>
      </div>
    )
  }

  if (live.connection !== "live") {
    return (
      <SessionPreflight
        above={
          // Reached without the hand-off — a bookmark, a reload — so this is
          // the only screen the learner can see. It needs a way back.
          <Link
            href="/home"
            className="mb-8 inline-flex items-center gap-1.5 text-sm text-muted-foreground transition-colors duration-200 hover:text-foreground"
          >
            <ArrowLeft className="size-3.5" />
            Back to home
          </Link>
        }
        plan={plan}
        onChange={setEdited}
        // Never true here — a connecting session rendered the stage above.
        connecting={false}
        error={live.error}
        onStart={(finalPlan) => {
          // Persisted at the moment of use, so a repeat session opens on the
          // plan that was actually spoken — not on an abandoned edit.
          savePlan(finalPlan)
          live.connect(finalPlan)
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
        elapsedSeconds={live.elapsedSeconds}
        remainingSeconds={live.remainingSeconds}
        outOfMinutes={live.outOfMinutes}
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
