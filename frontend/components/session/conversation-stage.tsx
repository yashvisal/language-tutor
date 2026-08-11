"use client"

/**
 * STAGE SPLIT — the conversation surface.
 *
 * The hybrid settled in phase 1: aura-stage's stage presence and utterance
 * lifecycle, plus split-columns' collapsible anchor-language column — governed
 * by two ideas the other variants don't have.
 *
 * 1. RELEVANCE, NOT RECENCY. Exactly two lines live on the stage: the current
 *    utterance (the hero) and the one turn it is answering (pinned above,
 *    readable but secondary). No receding stack, no ambient transcript. A
 *    learner cannot read while speaking, so the screen carries the minimum
 *    text the current moment needs. Everything older is an escape hatch.
 *
 * 2. PAUSE IS FIRST-CLASS. The conversation must never run away from a learner
 *    who has stopped to study. Three entry points hold the session — the
 *    control bar, opening a correction, and peeking at history — and the Aura
 *    settles, the surface dims, and the word ticker freezes mid-utterance (the
 *    caret becomes a hold glyph). No text label says "paused"; the surface says
 *    it. Resuming continues exactly where it stopped.
 *
 * This component is UI only. Everything it renders comes from the session
 * reducer folding contract events — produced by the scripted mock in the design
 * playground and by the live LiveKit adapter in a real session. The Aura is a
 * render prop for the same reason: mock volume in replay, the agent's real
 * audio track live.
 */

import { useCallback, useEffect, useReducer, type ReactNode } from "react"
import { AnimatePresence, motion } from "motion/react"

import { HistoryPeek } from "@/components/session/history-peek"
import { Caret, HeroWords } from "@/components/session/hero-utterance"
import { SettledText } from "@/components/session/correction-mark"
import { SessionControls } from "@/components/session/session-controls"
import {
  HERO_LEADING,
  ROW_LEADING,
  StageGrid,
  StageRow,
} from "@/components/session/stage-grid"
import type {
  AgentState,
  PauseReason,
  SessionEvent,
} from "@/lib/session/contract"
import {
  historyTurns,
  pinnedTurn,
  wordsOf,
  type SessionState,
} from "@/lib/session/reducer"
import { cn } from "@/lib/utils"

export interface ConversationStageProps {
  state: SessionState
  /** Client-originated events — holds, mainly. */
  dispatch: (event: SessionEvent) => void
  /** The Aura, given the state it should render (holds override agent state). */
  renderAura: (state: AgentState) => ReactNode
  muted: boolean
  onToggleMute: () => void
  /** Hangs up. Omitted in replay, where there is nothing to disconnect. */
  onEnd?: () => void
  /**
   * A segment the producer knows will never finalize (the mock's trailing
   * interim). It renders with an ellipsis instead of a caret once frozen.
   */
  interimSegmentId?: string
}

export function ConversationStage({
  state,
  dispatch,
  renderAura,
  muted,
  onToggleMute,
  onEnd,
  interimSegmentId,
}: ConversationStageProps) {
  const { phase, holds } = state

  const [showEn, toggleEn] = useReducer((v: boolean) => !v, true)

  const paused = holds.length > 0
  const historyOpen = holds.includes("history")

  const hold = useCallback(
    (reason: PauseReason) => dispatch({ type: "session.paused", reason }),
    [dispatch]
  )
  const release = useCallback(
    (reason: PauseReason) => dispatch({ type: "session.resumed", reason }),
    [dispatch]
  )
  const setHold = (reason: PauseReason, on: boolean) =>
    on ? hold(reason) : release(reason)

  // Space toggles the hold — a quiet keyboard affordance for resuming.
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== " " || e.metaKey || e.ctrlKey || e.altKey) return
      const target = e.target as HTMLElement | null
      if (
        target &&
        (target.tagName === "INPUT" ||
          target.tagName === "TEXTAREA" ||
          target.isContentEditable)
      )
        return
      e.preventDefault()
      if (holds.length > 0) holds.forEach(release)
      else hold("control")
    }
    window.addEventListener("keydown", onKeyDown)
    return () => window.removeEventListener("keydown", onKeyDown)
  }, [holds, hold, release])

  // --- Derived view -------------------------------------------------------
  const turn = state.current
  const context = pinnedTurn(state)
  const isInterim =
    interimSegmentId !== undefined && turn?.id === interimSegmentId
  const marksActive = phase === "settled" && turn?.speaker === "learner"

  // The anchor language arrives on its own stream, already trailing — the lag
  // is the producer's, not a render trick.
  const enWords = turn ? wordsOf(turn.anchor) : []

  // Holding overrides whatever the agent is doing: the surface settles.
  const auraState: AgentState = paused ? "idle" : state.agentState

  return (
    <div
      className="relative h-full overflow-hidden bg-background"
      onWheel={(e) => {
        // Scrolling up means "I'm reading, not talking" — hold and peek.
        if (e.deltaY < -6 && !historyOpen) hold("history")
      }}
    >
      <div className="flex h-full flex-col items-center justify-center px-8 pb-24">
        {/* Aura — viewport-centered, and deliberately outside the text grid:
            it is the fixed anchor the columns re-center beneath. */}
        <div className="flex w-full shrink-0 justify-center">
          <div className="relative flex items-center justify-center">
            <motion.div
              animate={{ opacity: paused ? 0.4 : 1, scale: paused ? 0.94 : 1 }}
              transition={{ duration: 0.55, ease: [0.32, 0.72, 0, 1] }}
            >
              {renderAura(auraState)}
            </motion.div>
            {/* A slow breathing ring while held: the session is alive but
                waiting. No label needed. */}
            <AnimatePresence>
              {paused && (
                <motion.span
                  aria-hidden
                  initial={{ opacity: 0, scale: 0.9 }}
                  animate={{ opacity: [0.35, 0.12, 0.35], scale: [1, 1.06, 1] }}
                  exit={{
                    opacity: 0,
                    scale: 1.1,
                    transition: { duration: 0.4 },
                  }}
                  transition={{
                    opacity: { duration: 3.4, repeat: Infinity },
                    scale: { duration: 3.4, repeat: Infinity },
                  }}
                  className="pointer-events-none absolute size-[clamp(6rem,18vh,10rem)] rounded-full border border-primary/50"
                />
              )}
            </AnimatePresence>
          </div>
        </div>

        {/* The stage: one pinned context turn + the hero. Nothing else. */}
        <motion.div
          animate={{ opacity: paused ? 0.55 : 1 }}
          transition={{ duration: 0.5, ease: "easeOut" }}
          className="mt-[clamp(1.5rem,5vh,3rem)] w-full"
        >
          <StageGrid showEn={showEn}>
            {/* Pinned context — the turn the hero is answering. Readable,
                deliberately secondary. */}
            <div className="min-h-[4.5rem]">
              <AnimatePresence mode="popLayout" initial={false}>
                {context && (
                  <motion.div
                    key={context.id}
                    initial={{ opacity: 0, y: 10 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={{ opacity: 0, y: -8 }}
                    transition={{ duration: 0.4, ease: "easeOut" }}
                  >
                    <StageRow
                      showEn={showEn}
                      speaker={context.speaker}
                      en={
                        <span className="text-muted-foreground/70">
                          {context.anchor}
                        </span>
                      }
                    >
                      <p
                        className={cn(
                          "text-base tracking-[-0.011em] text-foreground/55",
                          ROW_LEADING
                        )}
                      >
                        <SettledText turn={context} />
                      </p>
                    </StageRow>
                  </motion.div>
                )}
              </AnimatePresence>
            </div>

            {/* Hero — the current utterance. */}
            <div className="mt-6">
              <AnimatePresence mode="popLayout" initial={false}>
                {turn && (
                  <motion.div
                    key={turn.id}
                    initial={{ opacity: 0, y: 14 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={{ opacity: 0, y: -10, filter: "blur(4px)" }}
                    transition={{ duration: 0.4, ease: "easeOut" }}
                  >
                    <StageRow
                      showEn={showEn}
                      speaker={turn.speaker}
                      labelClassName="text-muted-foreground/70"
                      enClassName={HERO_LEADING}
                      en={enWords.map((word, i) => (
                        <motion.span
                          key={i}
                          initial={{ opacity: 0, filter: "blur(3px)" }}
                          animate={{ opacity: 1, filter: "blur(0px)" }}
                          transition={{ duration: 0.55, ease: "easeOut" }}
                          className="inline-block whitespace-pre"
                        >
                          {word}{" "}
                        </motion.span>
                      ))}
                    >
                      <p
                        className={cn(
                          // Two hero lines reserved, on the hero line box.
                          "min-h-[4.3rem] text-[1.6rem] tracking-[-0.018em] text-balance",
                          HERO_LEADING
                        )}
                      >
                        <HeroWords
                          turn={turn}
                          live={phase === "live"}
                          marksActive={marksActive}
                          onCorrectionOpenChange={(open) =>
                            setHold("correction", open)
                          }
                        />
                        {phase === "live" && turn.target.length > 0 && (
                          <Caret paused={paused} />
                        )}
                        {isInterim && phase !== "live" && (
                          <span className="text-muted-foreground/50">…</span>
                        )}
                      </p>
                    </StageRow>
                  </motion.div>
                )}
              </AnimatePresence>
            </div>
          </StageGrid>
        </motion.div>
      </div>

      {/* History peek — auto-holds while open. */}
      <AnimatePresence>
        {historyOpen && (
          <HistoryPeek
            turns={historyTurns(state)}
            showEn={showEn}
            onClose={() => release("history")}
          />
        )}
      </AnimatePresence>

      <SessionControls
        paused={paused}
        muted={muted}
        showEn={showEn}
        onReview={() => hold("history")}
        onToggleMute={onToggleMute}
        onToggleEn={toggleEn}
        onTogglePause={() =>
          paused ? holds.forEach(release) : hold("control")
        }
        onEnd={onEnd}
      />

      {/* Dev readout: what the engine thinks is happening. */}
      <div className="absolute right-4 bottom-4 z-10 font-mono text-[10px] text-muted-foreground/50">
        {paused ? `held · ${holds.join("+")}` : `${phase} · ${auraState}`}
      </div>
    </div>
  )
}
