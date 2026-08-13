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
import { STAGE_AURA_CLASS } from "@/components/session/tutor-aura"
import { CONVERSATION } from "@/lib/design/mock-conversation"
import type { TranslateFn } from "@/lib/session/contract"
import {
  MOCK_INTERIM_SEGMENT_ID,
  useMockSession,
} from "@/lib/session/mock-producer"

/** Roughly the round trip the worker's `tutor.translate` budgets for. */
const MOCK_TRANSLATE_MS = 400

/**
 * Replay's answer to a selected span. The script already carries each turn's
 * English, so selecting a whole turn returns the real thing; anything narrower
 * gets an obviously-canned line rather than a plausible-looking lie, because
 * the point of this page is the interaction, not the translation.
 */
const mockTranslate: TranslateFn = (text, _speaker, turnId) =>
  new Promise((resolve) =>
    setTimeout(() => {
      const scripted = CONVERSATION.find((turn) => turn.id === turnId)
      const whole = scripted && scripted.es.includes(text) && text.length > 24
      resolve(whole ? scripted.en : `“${text}” — replay has no translator.`)
    }, MOCK_TRANSLATE_MS)
  )

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
      translate={mockTranslate}
      // Replay has no connection to hang up; the control stays for layout
      // fidelity with the live surface.
      onEnd={() => {}}
      renderAura={(auraState) => (
        <MockAura state={auraState} size="lg" className={STAGE_AURA_CLASS} />
      )}
    />
  )
}
