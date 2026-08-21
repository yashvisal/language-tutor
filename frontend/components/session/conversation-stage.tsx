"use client"

/**
 * STAGE SPLIT — the conversation surface.
 *
 * The hybrid settled in phase 1 (aura-stage's stage presence and utterance
 * lifecycle) reduced in phase 3 to a single full-width text column — live
 * translation is gone, so the anchor column went with it. Two ideas the other
 * variants don't have still govern it.
 *
 * 1. RELEVANCE, NOT RECENCY. Exactly two lines live on the stage: the current
 *    utterance (the hero) and the one turn it is answering (pinned above,
 *    readable but secondary). No receding stack, no ambient transcript. A
 *    learner cannot read while speaking, so the screen carries the minimum
 *    text the current moment needs. Everything older is an escape hatch.
 *
 * 2. PAUSE IS FIRST-CLASS, AND PAUSE IS THE STUDY SURFACE. The conversation
 *    must never run away from a learner who has stopped to study. The Aura
 *    settles, the surface dims, and the word ticker freezes mid-utterance (the
 *    caret becomes a hold glyph). No text label says "paused"; the surface says
 *    it. Resuming continues exactly where it stopped.
 *
 *    Deliberately stopping — the Hold button, Space, the transcript button, or
 *    scrolling up — lands on the study surface, because that is what a pause is
 *    for; all four take the same `"history"` hold, so a learner who never
 *    switches tabs reports the same pause whichever one they reached for.
 *    Opening a correction or a translation is not a deliberate stop: those hold
 *    the session too, but only blur the stage.
 *
 * This component is UI only. Everything it renders comes from the session
 * reducer folding contract events — produced by the scripted mock in the design
 * playground and by the live LiveKit adapter in a real session. The Aura is a
 * render prop for the same reason: mock volume in replay, the agent's real
 * audio track live.
 */

import { useCallback, useEffect, useRef, type ReactNode } from "react"
import { AnimatePresence, motion } from "motion/react"

import { StudyOverlay } from "@/components/session/study-overlay"
import { MinutesPill } from "@/components/session/minutes-pill"
import { Caret, HeroWords } from "@/components/session/hero-utterance"
import { SettledText } from "@/components/session/correction-mark"
import { SessionControls } from "@/components/session/session-controls"
import {
  HERO_LEADING,
  ROW_LEADING,
  StageGrid,
  StageRow,
} from "@/components/session/stage-grid"
import {
  OVERLAY_ATTR,
  OVERLAY_OPEN,
  SelectionTranslator,
  translatableProps,
} from "@/components/session/translate-overlay"
import type {
  AgentState,
  AskExchange,
  Correction,
  PauseReason,
  SessionEvent,
  StudySession,
  TranslateFn,
} from "@/lib/session/contract"
import {
  heroTurn,
  isHeld,
  marksActive,
  pinnedTurn,
  transcriptTurns,
  type SessionState,
} from "@/lib/session/reducer"
import { cn } from "@/lib/utils"

/** Elements whose own Space handling outranks the surface's hold shortcut. */
const FOCUSED_TAKES_SPACE = [
  "input",
  "textarea",
  "button",
  "[contenteditable='true']",
  "[role='button']",
  "[role='switch']",
  "[role='checkbox']",
  "[data-slot='popover-content']",
].join(",")

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
  /**
   * Minutes the worker says remain. Absent (replay, or a worker with no clock)
   * means no pill at all — see `MinutesPill`.
   */
  minutesLeft?: number | null
  /**
   * Translates a selected span. Omitted where nothing can answer — the overlay
   * simply never opens then, rather than opening onto an error.
   */
  translate?: TranslateFn
  /**
   * The pause overlay's back end — the Ask thread, the review material, and the
   * tab the learner last had open, all owned by the producer for the length of
   * the session. Omitted where nothing can answer: the overlay then opens on
   * the transcript alone, which is exactly what it was before phase 5.
   */
  study?: StudySession
  /** The plan's focus forms, so Review leads with what is being practiced. */
  focusTenses?: readonly string[]
}

/** Stable no-study fallbacks, so the overlay's props never change identity. */
const EMPTY_THREAD: AskExchange[] = []
const NO_TAB = () => {}
const NO_ASK = () => {}
const NO_REVIEW = () => Promise.resolve(null)

export function ConversationStage({
  state,
  dispatch,
  renderAura,
  muted,
  onToggleMute,
  onEnd,
  interimSegmentId,
  minutesLeft,
  translate,
  study,
  focusTenses,
}: ConversationStageProps) {
  const { phase, holds } = state

  const paused = isHeld(state)
  const studyOpen = holds.includes("history")

  // `correction` rides along on the hold so the producer can tell the tutor
  // what the learner stopped to study. Nothing on this side reads it.
  const hold = useCallback(
    (reason: PauseReason, correction?: Correction) =>
      dispatch({ type: "session.paused", reason, correction }),
    [dispatch]
  )
  const release = useCallback(
    (reason: PauseReason) => dispatch({ type: "session.resumed", reason }),
    [dispatch]
  )

  // Bound once so the overlay's hold effect keys on open/closed and nothing else.
  const holdTranslation = useCallback(() => hold("translation"), [hold])
  const releaseTranslation = useCallback(
    () => release("translation"),
    [release]
  )
  const correctionOpenChange = useCallback(
    (open: boolean, correction: Correction) =>
      open ? hold("correction", correction) : release("correction"),
    [hold, release]
  )

  /**
   * What to hand focus back to when the peek closes. Captured HERE, at the
   * moment of the gesture, because the peek makes the stage `inert` in the same
   * commit it mounts in — by the time its effects run, focus has already been
   * blurred to `<body>` and the trigger is unrecoverable.
   */
  const studyTrigger = useRef<HTMLElement | null>(null)
  /** Every deliberate stop, whatever gesture asked for it. */
  const openStudy = useCallback(() => {
    const active = document.activeElement
    studyTrigger.current =
      active instanceof HTMLElement && active !== document.body ? active : null
    hold("history")
  }, [hold])

  // Space toggles the stop — a quiet keyboard affordance for the same pair of
  // gestures the control bar offers: study on the way in, resume on the way out
  // (and out means every hold, whatever put it there).
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== " " || e.metaKey || e.ctrlKey || e.altKey) return
      // Space is the activation key for whatever has focus. Stealing it would
      // make Mute and End unusable from the keyboard, and the shortcut is a
      // convenience — the focused control always wins.
      const target = e.target as HTMLElement | null
      if (target?.closest?.(FOCUSED_TAKES_SPACE)) return
      e.preventDefault()
      if (holds.length > 0) holds.forEach(release)
      else openStudy()
    }
    window.addEventListener("keydown", onKeyDown)
    return () => window.removeEventListener("keydown", onKeyDown)
  }, [holds, openStudy, release])

  // --- Derived view -------------------------------------------------------
  const turn = heroTurn(state)
  const context = pinnedTurn(state)
  const isInterim =
    interimSegmentId !== undefined && turn?.id === interimSegmentId
  const showMarks = marksActive(state)

  // Holding overrides whatever the agent is doing: the surface settles.
  const auraState: AgentState = paused ? "idle" : state.agentState

  return (
    <div
      className="relative h-full overflow-hidden bg-background"
      onWheel={(e) => {
        // Scrolling up means "I'm reading, not talking" — hold and peek. Unless
        // the wheel is over the translation card, which is its own surface.
        if (
          e.target instanceof Element &&
          e.target.closest(`[${OVERLAY_ATTR}="${OVERLAY_OPEN}"]`)
        )
          return
        if (e.deltaY < -6 && !studyOpen) openStudy()
      }}
    >
      {/* The peek is a modal overlay: while it is up, the stage beneath it is
          not reachable by keyboard or pointer — and fully invisible. The peek's
          backdrop is translucent, and exited turns can linger in the DOM (a
          known AnimatePresence popLayout quirk), so a merely-dimmed stage
          bleeds ghost text through the review surface. */}
      <div
        inert={studyOpen}
        className={cn(
          "flex h-full flex-col items-center justify-center px-8 pb-24 transition-opacity duration-200",
          studyOpen && "opacity-0"
        )}
      >
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
          <StageGrid>
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
                    <StageRow speaker={context.speaker}>
                      <p
                        className={cn(
                          "text-base tracking-[-0.011em] text-foreground/55",
                          ROW_LEADING
                        )}
                      >
                        {/* The pinned row's marks hold the session exactly as
                            the hero's do — nothing else is covering it. */}
                        <SettledText
                          turn={context}
                          onCorrectionOpenChange={correctionOpenChange}
                        />
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
                      speaker={turn.speaker}
                      labelClassName="text-muted-foreground/70"
                    >
                      <p
                        // The learner's own utterance is selectable only once
                        // settled — translating your own half-arrived sentence
                        // is the wrong question. TUTOR speech is the opposite:
                        // in-the-moment comprehension is exactly when the
                        // learner reaches for it (found live 2026-08-12), and
                        // selecting already holds the session, so the text
                        // freezes the instant they start reading.
                        {...(turn.speaker === "tutor" || phase === "settled"
                          ? translatableProps(turn)
                          : {})}
                        className={cn(
                          // Two hero lines reserved, on the hero line box.
                          "min-h-[4.3rem] text-[1.6rem] tracking-[-0.018em] text-balance",
                          HERO_LEADING
                        )}
                      >
                        <HeroWords
                          turn={turn}
                          live={phase === "live"}
                          marksActive={showMarks}
                          onCorrectionOpenChange={correctionOpenChange}
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

      {/* The study surface — auto-holds while open. One hold covers all three
          tabs: switching tabs is not a new kind of pause. */}
      <AnimatePresence>
        {studyOpen && (
          <StudyOverlay
            turns={transcriptTurns(state)}
            thread={study?.thread ?? EMPTY_THREAD}
            tab={study?.tab ?? "transcript"}
            onTabChange={study?.setTab ?? NO_TAB}
            onAsk={study?.ask ?? NO_ASK}
            fetchReview={study?.fetchReview ?? NO_REVIEW}
            focusTenses={focusTenses}
            // A question is stamped to the turn that was on stage when it was
            // asked — the moment the learner stopped at, not the tab they typed
            // it in.
            heroTurnId={turn?.id ?? null}
            // Closing is resuming ("close and resume"), so it drops every hold,
            // not just this one — the surface must never close onto a session
            // that is still held by something the learner can no longer see.
            onClose={() => holds.forEach(release)}
            restoreFocusTo={studyTrigger}
          />
        )}
      </AnimatePresence>

      {/* Select-to-translate. Lives at the stage root so it can float over the
          history peek as readily as over the hero. */}
      {translate && (
        <SelectionTranslator
          translate={translate}
          // The hold set, not the card, decides whether a translation is up:
          // Space and the pause button release it without knowing the card
          // exists, and the card follows.
          held={holds.includes("translation")}
          onHold={holdTranslation}
          onRelease={releaseTranslation}
        />
      )}

      <div inert={studyOpen}>
        <MinutesPill minutesLeft={minutesLeft ?? null} />
        <SessionControls
          paused={paused}
          studyOpen={studyOpen}
          muted={muted}
          onReview={openStudy}
          onToggleMute={onToggleMute}
          // Holding IS studying: the button opens the same surface the
          // transcript button does, under the same hold, so the worker hears
          // the same thing about either pause. Resuming drops every hold —
          // including a `control` hold the producer adopted from an agent that
          // reconnected paused, which has no surface of its own.
          onTogglePause={() => (paused ? holds.forEach(release) : openStudy())}
          onEnd={onEnd}
        />
      </div>

      {/* Dev readout: what the engine thinks is happening. */}
      <div className="absolute right-4 bottom-4 z-10 font-mono text-[10px] text-muted-foreground/50">
        {paused ? `held · ${holds.join("+")}` : `${phase} · ${auraState}`}
      </div>
    </div>
  )
}
