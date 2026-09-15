"use client"

/**
 * STAGE STATUS — a preview of the way-in line under the orb.
 *
 * The real stage, empty, frozen in one of its pre-tutor states so the line
 * can be looked at without a LiveKit connection: `?status=connecting`,
 * `?status=joining` or `?status=waking` (default). Nothing here connects to
 * anything; the controls are inert, exactly as they are on the real way in.
 *
 * Why a page and not a session: local dev and production share one LiveKit
 * project, so a localhost session is served by the production worker and the
 * waking state can never be reached by hand (2026-09-15).
 */

import { Suspense } from "react"
import { useSearchParams } from "next/navigation"

import { ConversationStage } from "@/components/session/conversation-stage"
import { SessionLanguageProvider } from "@/components/session/session-language"
import { STAGE_AURA_CLASS, TutorAura } from "@/components/session/tutor-aura"
import { INITIAL_SESSION_STATE } from "@/lib/session/reducer"

const STATUSES = ["connecting", "joining", "waking"] as const
type Status = (typeof STATUSES)[number]

function isStatus(value: string | null): value is Status {
  return STATUSES.includes(value as Status)
}

function Preview() {
  const params = useSearchParams()
  const raw = params.get("status")
  const status: Status = isStatus(raw) ? raw : "waking"

  return (
    <SessionLanguageProvider language="es">
      <div className="h-svh">
        <ConversationStage
          state={INITIAL_SESSION_STATE}
          dispatch={() => {}}
          muted
          onToggleMute={() => {}}
          status={status}
          renderAura={() => (
            <TutorAura
              state="connecting"
              size="lg"
              className={STAGE_AURA_CLASS}
            />
          )}
        />
      </div>
    </SessionLanguageProvider>
  )
}

export default function StageStatusPreviewPage() {
  return (
    <Suspense fallback={null}>
      <Preview />
    </Suspense>
  )
}
