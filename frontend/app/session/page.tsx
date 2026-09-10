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
 * The pre-flight is `/home`'s Start dialog, which hands off through
 * `lib/session/handoff` with the plan it was given, and this page connects
 * straight away. Without a hand-off — a direct visit, a bookmark, a reload —
 * there is nothing to start, and the page goes back to `/home` rather than
 * showing a second copy of the form (Yash, 2026-09-09).
 */

import { useEffect, useRef, useState } from "react"
import { useRouter } from "next/navigation"
import { RoomAudioRenderer } from "@livekit/components-react"

import { SessionLanguageProvider } from "@/components/session/session-language"
import { ConversationStage } from "@/components/session/conversation-stage"
import { OutOfMinutesScreen } from "@/components/session/out-of-minutes"
import { SessionSummary } from "@/components/session/session-summary"
import { StartFailedScreen } from "@/components/session/start-failed"
import { TutorUnavailableScreen } from "@/components/session/tutor-unavailable"
import { STAGE_AURA_CLASS, TutorAura } from "@/components/session/tutor-aura"
import { startRequested, takeStartRequest } from "@/lib/session/handoff"
import { useLiveSession } from "@/lib/session/live-producer"

export default function SessionPage() {
  const live = useLiveSession()
  const { connect } = live
  const router = useRouter()
  /**
   * The hand-off from `/home`, as a render-time fact: true from the first
   * paint so the learner sees the stage warming up rather than the form they
   * just filled in, and false again the moment the start has settled into a
   * connection state, an error, or a refusal. Read without spending — the
   * effect below spends it, once.
   */
  const [handoff, setHandoff] = useState(startRequested)

  /**
   * The hand-off from `/home`, fired once and then erased. The ref makes it
   * once within this mount — after a session ends the learner is back on this
   * page, and "start another" must mean the button, not the address bar — and
   * dropping the flag from the URL makes it once across mounts too, so a
   * reload cannot reconnect and bill a second session.
   */
  const handedOff = useRef(false)
  useEffect(() => {
    if (handedOff.current) return
    const requested = takeStartRequest()
    if (requested === null) return
    handedOff.current = true
    connect(requested)
  }, [connect])

  // The hand-off screen ends when the start has an answer of any kind. Set
  // during render rather than in an effect: it is derived from `live`, and
  // React re-renders immediately without painting the stale frame.
  const settled =
    live.connection !== "idle" ||
    live.error !== null ||
    live.outOfMinutes ||
    live.tutorFailed !== null ||
    live.outcome !== null
  if (handoff && settled) setHandoff(false)

  // Nothing to start and nothing to show: back to the one pre-flight. In an
  // effect because it navigates; the condition is every branch below being
  // false, spelled out so a new branch cannot fall through to a redirect.
  const idle =
    !handoff &&
    live.connection === "idle" &&
    live.error === null &&
    !live.outOfMinutes &&
    live.tutorFailed === null &&
    live.outcome === null
  useEffect(() => {
    if (idle) router.replace("/home")
  }, [idle, router])

  // The summary outlives the room, so it wins over the connection state: a
  // session ended by the clock disconnects us, and dropping straight back to
  // the pre-flight would throw away the corrections the learner just earned.
  if (live.outcome) {
    return (
      <SessionSummary
        outcome={live.outcome}
        // The pre-flight is on `/home`; "another" means going there.
        onStartAnother={() => {
          live.clearOutcome()
          router.push("/home")
        }}
      />
    )
  }

  // The room came up without a tutor in it (audit B6). Above the pre-flight
  // and above the connecting stage, because a failed start that fell back to
  // either would look exactly like the session never being attempted. Try
  // again dials the same plan — `connect` clears the failure itself.
  if (live.tutorFailed) {
    return (
      <TutorUnavailableScreen
        reason={live.tutorFailed}
        onRetry={() => {
          if (live.plan) live.connect(live.plan)
          else router.push("/home")
        }}
      />
    )
  }

  // The token route refused: no room was ever opened, so there is nothing to
  // pre-flight. The card is the whole screen, and it is the same card a session
  // held at zero shows over the conversation.
  if (live.outOfMinutes && live.connection !== "live") {
    return <OutOfMinutesScreen />
  }

  // The token route refused or the connect died before there was a room:
  // the sentence with the fix in it, and the same plan to redial.
  if (live.error !== null) {
    const plan = live.plan
    return (
      <StartFailedScreen
        error={live.error}
        onRetry={plan ? () => live.connect(plan) : null}
      />
    )
  }

  // Idle with nothing to show: the effect above is on its way to `/home`.
  if (!handoff && live.connection === "idle") return null

  // Handed off from the dashboard, or dialling, or in the room waiting for
  // the tutor: the learner chose to start, so the only honest screen is the
  // stage itself, warming up in place. One stage from the first paint to the
  // first word, with a quiet status line in the corner, so nothing jumps
  // when the conversation arrives (Yash, 2026-09-10). The tutor counts as
  // joined once it has a track for the Aura or has reported a state — both
  // arrive only once it is in the room.
  const tutorJoined =
    live.agentAudioTrack !== undefined || live.state.agentState !== "idle"
  const status =
    handoff || live.connection !== "live"
      ? "connecting"
      : tutorJoined
        ? "live"
        : "joining"

  return (
    <SessionLanguageProvider language={live.plan?.targetLanguage}>
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
          status={status}
          // Until the tutor is live the Aura renders its connecting state,
          // whatever the reducer says: the reducer has nothing to say yet.
          renderAura={(auraState) => (
            <TutorAura
              state={status === "live" ? auraState : "connecting"}
              audioTrack={live.agentAudioTrack}
              size="lg"
              className={STAGE_AURA_CLASS}
            />
          )}
        />
      </div>
    </SessionLanguageProvider>
  )
}
