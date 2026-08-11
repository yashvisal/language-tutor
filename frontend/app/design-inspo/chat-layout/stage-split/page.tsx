"use client"

/**
 * STAGE SPLIT — chat-layout variant.
 *
 * The hybrid bet: aura-stage's stage presence and utterance lifecycle, plus
 * split-columns' collapsible English column — governed by two ideas the other
 * variants don't have.
 *
 * 1. RELEVANCE, NOT RECENCY. Exactly two lines live on the stage: the current
 *    utterance (the hero) and the one turn it is answering (pinned above,
 *    readable but secondary). No receding stack, no ambient transcript. A
 *    learner cannot read while speaking, so the screen carries the minimum
 *    text the current moment needs. Everything older is an escape hatch, not
 *    a surface.
 *
 * 2. PAUSE IS FIRST-CLASS. The conversation must never run away from a learner
 *    who has stopped to study. Three entry points hold the session — the
 *    control bar, opening a correction, and peeking at history — and the Aura
 *    settles, the surface dims, and the word ticker freezes mid-utterance
 *    (the caret becomes a hold glyph). No text label says "paused"; the
 *    surface says it. Resuming continues exactly where it stopped.
 *
 * Alignment tension (centered subtitle vs. side-by-side columns) is resolved
 * in favour of a LEFT-ALIGNED stage on one honest grid: a fixed-width Spanish
 * column plus a collapsible English column, with every text row on the page —
 * pinned context, hero, and history peek — sharing that same left edge and
 * column structure. The Aura is not part of the grid: it stays viewport-
 * centered in both states, and the text block re-centers beneath it when
 * translation toggles.
 *
 * This file is UI only. Everything it renders comes from the session reducer
 * (`lib/session/reducer.ts`) folding contract events, here produced by the
 * scripted mock — the live LiveKit adapter is a drop-in replacement producer.
 */

import {
  useCallback,
  useEffect,
  useMemo,
  useReducer,
  type ReactNode,
} from "react"
import type { AgentState } from "@livekit/components-react"
import {
  History,
  Languages,
  Mic,
  MicOff,
  MoveRight,
  Pause,
  PhoneOff,
  Play,
  X,
} from "lucide-react"
import { AnimatePresence, motion } from "motion/react"

import { MockAura } from "@/components/design/mock-aura"
import { Button } from "@/components/ui/button"
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover"
import { Separator } from "@/components/ui/separator"
import { Switch } from "@/components/ui/switch"
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip"
import {
  CATEGORY_LABELS,
  type Correction,
  type CorrectionCategory,
  type PauseReason,
  type Turn,
} from "@/lib/session/contract"
import {
  MOCK_INTERIM_SEGMENT_ID,
  useMockSession,
} from "@/lib/session/mock-producer"
import { historyTurns, pinnedTurn, wordsOf } from "@/lib/session/reducer"
import { cn } from "@/lib/utils"

/* -------------------------------------------------------------------------- */
/*  Layout constants                                                          */
/* -------------------------------------------------------------------------- */

/**
 * ONE GRID. Every text row on the page — pinned context, hero, and the
 * history peek — is a row of the same two-column grid: a fixed-width Spanish
 * column and a collapsible English column. The grid re-centers as a unit when
 * English toggles; the Aura is *not* part of it and stays viewport-centered
 * in both states.
 */
const ES_COL_W = 460
/** English column width incl. its gutter, so the gap collapses with it. */
const EN_COL_W = 264
const EN_COL_GUTTER = 36

/** Line box shared by Spanish and English on the body rows. */
const ROW_LEADING = "leading-7"
/** Line box shared by Spanish and English on the hero row. */
const HERO_LEADING = "leading-[2.15rem]"

/** Shared tween so the column collapse and the grid re-center in sync. */
const COL_TRANSITION = { duration: 0.5, ease: [0.32, 0.72, 0, 1] as const }

/* -------------------------------------------------------------------------- */
/*  Correction category treatment                                             */
/* -------------------------------------------------------------------------- */

/**
 * Calm, category-differentiated tints. Corrections are invitations, so no
 * destructive red anywhere — hue distinguishes *kind*, not severity.
 */
const CATEGORY_STYLES: Record<
  CorrectionCategory,
  { mark: string; accent: string }
> = {
  tense: {
    mark: "decoration-violet-500/60 hover:bg-violet-500/10 data-popup-open:bg-violet-500/10",
    accent: "text-violet-700 dark:text-violet-300",
  },
  agreement: {
    mark: "decoration-sky-500/60 hover:bg-sky-500/10 data-popup-open:bg-sky-500/10",
    accent: "text-sky-700 dark:text-sky-300",
  },
  "word-order": {
    mark: "decoration-amber-500/70 hover:bg-amber-500/10 data-popup-open:bg-amber-500/10",
    accent: "text-amber-700 dark:text-amber-300",
  },
  vocabulary: {
    mark: "decoration-emerald-500/60 hover:bg-emerald-500/10 data-popup-open:bg-emerald-500/10",
    accent: "text-emerald-700 dark:text-emerald-300",
  },
  naturalness: {
    mark: "decoration-cyan-500/60 hover:bg-cyan-500/10 data-popup-open:bg-cyan-500/10",
    accent: "text-cyan-700 dark:text-cyan-300",
  },
}

/* -------------------------------------------------------------------------- */
/*  Text segmentation                                                         */
/* -------------------------------------------------------------------------- */

interface Segment {
  key: string
  text: string
  correction?: Correction
}

/** Split a turn's target-language text into plain / marked segments. */
function segmentTurn(turn: Turn): Segment[] {
  const es = turn.target
  const found = (turn.corrections ?? [])
    .map((c) => ({ c, at: es.indexOf(c.original) }))
    .filter((x) => x.at >= 0)
    .sort((a, b) => a.at - b.at)

  const segments: Segment[] = []
  let cursor = 0
  for (const { c, at } of found) {
    if (at > cursor) {
      segments.push({ key: `plain-${cursor}`, text: es.slice(cursor, at) })
    }
    segments.push({ key: c.id, text: c.original, correction: c })
    cursor = at + c.original.length
  }
  if (cursor < es.length) {
    segments.push({ key: `plain-${cursor}`, text: es.slice(cursor) })
  }
  return segments
}

/* -------------------------------------------------------------------------- */
/*  Correction mark + popover (opening one holds the session)                 */
/* -------------------------------------------------------------------------- */

function CorrectionMark({
  correction,
  active,
  onOpenChange,
  children,
}: {
  correction: Correction
  /** Marks only surface once the turn has settled. */
  active: boolean
  onOpenChange: (open: boolean) => void
  children: ReactNode
}) {
  const style = CATEGORY_STYLES[correction.category]
  return (
    <Popover onOpenChange={onOpenChange}>
      <PopoverTrigger
        nativeButton={false}
        render={
          <span
            className={cn(
              "rounded-[3px] px-px align-baseline underline decoration-[0.06em] underline-offset-[0.22em] transition-all duration-700",
              correction.severity !== "error" && "decoration-dotted",
              active
                ? cn("cursor-pointer", style.mark)
                : "pointer-events-none decoration-transparent"
            )}
          />
        }
      >
        {children}
      </PopoverTrigger>
      <PopoverContent
        side="bottom"
        align="start"
        sideOffset={10}
        className="w-auto max-w-72 min-w-52 gap-0 p-3.5"
      >
        <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-sm">
          <span className="text-muted-foreground line-through decoration-muted-foreground/40">
            {correction.original}
          </span>
          <MoveRight className="size-3.5 shrink-0 text-muted-foreground/50" />
          <span className={cn("font-medium", style.accent)}>
            {correction.replacement}
          </span>
        </div>
        <div className="mt-1.5 text-[10px] tracking-[0.14em] text-muted-foreground/60 uppercase">
          {CATEGORY_LABELS[correction.category]}
        </div>
        <ExplanationDisclosure text={correction.explanation} />
      </PopoverContent>
    </Popover>
  )
}

function ExplanationDisclosure({ text }: { text: string }) {
  const [open, toggle] = useReducer(() => true, false)
  return open ? (
    <motion.p
      initial={{ opacity: 0, height: 0 }}
      animate={{ opacity: 1, height: "auto" }}
      transition={{ duration: 0.25 }}
      className="mt-2 overflow-hidden text-xs leading-relaxed text-muted-foreground"
    >
      {text}
    </motion.p>
  ) : (
    <button
      type="button"
      onClick={toggle}
      className="mt-2 self-start text-xs text-muted-foreground/70 transition-colors hover:text-foreground"
    >
      Why?
    </button>
  )
}

/* -------------------------------------------------------------------------- */
/*  Stage grid: fixed Spanish column + collapsible English column             */
/* -------------------------------------------------------------------------- */

/**
 * The grid container: exactly as wide as its columns and centered, so the
 * Spanish column never floats inside a wider box. Rows inside it all start at
 * the same left edge, in both toggle states and throughout the transition.
 */
function StageGrid({
  showEn,
  children,
  className,
}: {
  showEn: boolean
  children: ReactNode
  className?: string
}) {
  return (
    <motion.div
      initial={false}
      animate={{ width: showEn ? ES_COL_W + EN_COL_W : ES_COL_W }}
      transition={COL_TRANSITION}
      className={cn("mx-auto", className)}
    >
      {children}
    </motion.div>
  )
}

/**
 * One row of the grid: speaker label, then Spanish and English side by side.
 * The label is mirrored (invisibly) into the English cell so both columns open
 * with the same line box — otherwise `items-baseline` would pair English's
 * first line with the *label*, not with the Spanish it translates.
 */
function StageRow({
  showEn,
  speaker,
  labelClassName,
  en,
  enClassName,
  children,
  className,
}: {
  showEn: boolean
  speaker?: Turn["speaker"]
  labelClassName?: string
  en?: ReactNode
  enClassName?: string
  children: ReactNode
  className?: string
}) {
  const label = speaker ? (
    <SpeakerLabel speaker={speaker} className={labelClassName} />
  ) : null

  return (
    <div className={cn("flex items-baseline", className)}>
      <div style={{ width: ES_COL_W }} className="shrink-0">
        {label}
        {children}
      </div>
      <EnCell showEn={showEn} className={enClassName}>
        {label && (
          <div aria-hidden className="invisible">
            {label}
          </div>
        )}
        {en}
      </EnCell>
    </div>
  )
}

/**
 * The collapsible English cell. Inner content keeps a fixed width so text
 * never reflows mid-animation — the column simply slides shut while the stage
 * re-centers around the Spanish.
 */
function EnCell({
  showEn,
  children,
  className,
}: {
  showEn: boolean
  children?: ReactNode
  className?: string
}) {
  return (
    <motion.div
      initial={false}
      animate={{ width: showEn ? EN_COL_W : 0, opacity: showEn ? 1 : 0 }}
      transition={COL_TRANSITION}
      aria-hidden={!showEn}
      className="shrink-0 overflow-hidden"
    >
      <div
        style={{ width: EN_COL_W, paddingLeft: EN_COL_GUTTER }}
        className={cn("text-sm text-muted-foreground", ROW_LEADING, className)}
      >
        {children}
      </div>
    </motion.div>
  )
}

/* -------------------------------------------------------------------------- */
/*  Hero utterance                                                            */
/* -------------------------------------------------------------------------- */

/**
 * The hero utterance. Its text is whatever the last cumulative transcript
 * delta said, so "word by word" is a diff: a word that wasn't in the previous
 * snapshot animates in, and everything already on screen stays put.
 */
function HeroWords({
  turn,
  live,
  marksActive,
  onCorrectionOpenChange,
}: {
  turn: Turn
  /** Still being transcribed — only then is the trailing word "new". */
  live: boolean
  marksActive: boolean
  onCorrectionOpenChange: (open: boolean) => void
}) {
  const segments = useMemo(() => segmentTurn(turn), [turn])
  const wordCount = wordsOf(turn.target).length
  // Only the word the latest delta added animates in. Everything else is
  // already on screen — and must stay put when corrections land and re-split
  // the line into new segments, which remounts the words inside them.
  const arriving = live ? wordCount - 1 : -1

  let index = 0
  const nodes: ReactNode[] = []

  for (const seg of segments) {
    const words = wordsOf(seg.text)
    const start = index
    index += words.length
    if (words.length === 0) continue

    const wordNodes = words.map((word, i) => (
      <motion.span
        key={`${turn.id}-${start + i}`}
        // Once marks are active the words sit inline so the parent's underline
        // can run through them (it doesn't reach inline-blocks).
        className={cn(
          seg.correction && marksActive ? "inline" : "inline-block"
        )}
        initial={
          start + i === arriving
            ? { opacity: 0, y: 6, filter: "blur(5px)" }
            : false
        }
        animate={{ opacity: 1, y: 0, filter: "blur(0px)" }}
        transition={{ duration: 0.35, ease: "easeOut" }}
      >
        {word}
      </motion.span>
    ))

    const interleaved: ReactNode[] = []
    wordNodes.forEach((node, i) => {
      interleaved.push(node)
      if (i < wordNodes.length - 1) interleaved.push(" ")
    })

    nodes.push(
      seg.correction ? (
        <CorrectionMark
          key={seg.key}
          correction={seg.correction}
          active={marksActive}
          onOpenChange={onCorrectionOpenChange}
        >
          {interleaved}
        </CorrectionMark>
      ) : (
        <span key={seg.key}>{interleaved}</span>
      )
    )
    nodes.push(" ")
  }

  return <>{nodes}</>
}

/**
 * The caret. Live: a soft pulsing bar. Held: it becomes a hold glyph in place
 * — the one place the freeze is legible at word resolution, without a label.
 */
function Caret({ paused }: { paused: boolean }) {
  return (
    <span className="ml-1.5 inline-flex h-[1.05em] translate-y-[0.16em] items-stretch gap-[0.1em] align-baseline">
      <motion.span
        animate={{ opacity: paused ? 0.55 : [0.15, 0.7, 0.15] }}
        transition={
          paused
            ? { duration: 0.4 }
            : { duration: 1.4, repeat: Infinity, ease: "easeInOut" }
        }
        className="block w-[3px] rounded-full bg-primary"
      />
      <motion.span
        initial={false}
        animate={{ opacity: paused ? 0.55 : 0, width: paused ? 3 : 0 }}
        transition={{ duration: 0.3, ease: "easeOut" }}
        className="block rounded-full bg-primary"
      />
    </span>
  )
}

/* -------------------------------------------------------------------------- */
/*  History peek — the escape hatch (holds the session while open)            */
/* -------------------------------------------------------------------------- */

function HistoryPeek({
  turns,
  showEn,
  onClose,
}: {
  turns: Turn[]
  showEn: boolean
  onClose: () => void
}) {
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose()
    }
    window.addEventListener("keydown", onKeyDown)
    return () => window.removeEventListener("keydown", onKeyDown)
  }, [onClose])

  return (
    <motion.div
      initial={{ opacity: 0, y: -12 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: -12 }}
      transition={{ duration: 0.3, ease: [0.32, 0.72, 0, 1] }}
      className="absolute inset-0 z-20 bg-background/92 backdrop-blur-xl"
    >
      <div className="flex h-full flex-col">
        <div className="flex shrink-0 items-center justify-end px-4 pt-3">
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  variant="ghost"
                  size="icon-sm"
                  onClick={onClose}
                  className="rounded-full text-muted-foreground/60 hover:text-foreground"
                >
                  <X />
                </Button>
              }
            />
            <TooltipContent side="left">Close and resume</TooltipContent>
          </Tooltip>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto px-6 pb-16">
          {/* Same grid as the stage, so history reads as the same document. */}
          <StageGrid showEn={showEn} className="space-y-7 pt-2">
            {turns.length === 0 && (
              <p className="pt-16 text-sm text-muted-foreground/60">
                Nothing to review yet.
              </p>
            )}
            {turns.map((turn) => (
              <StageRow
                key={turn.id}
                showEn={showEn}
                speaker={turn.speaker}
                en={turn.anchor}
              >
                <p
                  className={cn(
                    "text-base tracking-[-0.011em]",
                    ROW_LEADING,
                    turn.speaker === "tutor"
                      ? "text-foreground/55"
                      : "text-foreground/90"
                  )}
                >
                  <SettledText turn={turn} />
                </p>
              </StageRow>
            ))}
          </StageGrid>
        </div>
      </div>
    </motion.div>
  )
}

/** Settled Spanish with its correction marks live (no reveal animation). */
function SettledText({ turn }: { turn: Turn }) {
  const segments = useMemo(() => segmentTurn(turn), [turn])
  return (
    <>
      {segments.map((seg) =>
        seg.correction ? (
          <CorrectionMark
            key={seg.key}
            correction={seg.correction}
            active
            onOpenChange={() => {}}
          >
            {seg.text}
          </CorrectionMark>
        ) : (
          <span key={seg.key}>{seg.text}</span>
        )
      )}
    </>
  )
}

function SpeakerLabel({
  speaker,
  className,
}: {
  speaker: Turn["speaker"]
  className?: string
}) {
  return (
    <div
      className={cn(
        // Explicit leading: the mirrored copy lives inside the English cell,
        // which sets its own line-height, and the two must match exactly.
        "mb-1 text-[10px] leading-4 font-medium tracking-[0.2em] text-muted-foreground/55 uppercase",
        className
      )}
    >
      {speaker === "learner" ? "You" : "Tutor"}
    </div>
  )
}

/* -------------------------------------------------------------------------- */
/*  Page                                                                      */
/* -------------------------------------------------------------------------- */

export default function StageSplitPage() {
  // The mock producer drives the session; a live LiveKit adapter would take
  // its place here and nothing below would change.
  const { state, dispatch } = useMockSession()
  const { phase, holds } = state

  const [showEn, toggleEn] = useReducer((v: boolean) => !v, true)
  const [muted, toggleMute] = useReducer((v: boolean) => !v, false)

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
  const isInterim = turn?.id === MOCK_INTERIM_SEGMENT_ID
  const marksActive = phase === "settled" && turn?.speaker === "learner"

  // English arrives on its own stream, already trailing the Spanish — the lag
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
              animate={{
                opacity: paused ? 0.4 : 1,
                scale: paused ? 0.94 : 1,
              }}
              transition={{ duration: 0.55, ease: [0.32, 0.72, 0, 1] }}
            >
              <MockAura
                state={auraState}
                size="lg"
                className="h-[clamp(7rem,22vh,12rem)]"
              />
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

        {/* The stage: one pinned context turn + the hero. Nothing else.
            Both are rows of one grid, so they share a left edge and a
            column structure in both toggle states. */}
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

      {/* Session controls. */}
      <div className="absolute bottom-6 left-1/2 z-10 -translate-x-1/2">
        <div className="flex items-center gap-1 rounded-full border border-border/60 bg-background/70 p-1.5 shadow-sm backdrop-blur-md">
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  variant="ghost"
                  size="icon-lg"
                  onClick={() => hold("history")}
                  className="rounded-full text-muted-foreground/70 hover:text-foreground"
                >
                  <History />
                </Button>
              }
            />
            <TooltipContent>Review — holds the session</TooltipContent>
          </Tooltip>

          <Separator orientation="vertical" className="mx-0.5 h-4" />

          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  variant="ghost"
                  size="icon-lg"
                  onClick={toggleMute}
                  className={cn(
                    "rounded-full text-muted-foreground hover:text-foreground",
                    muted && "bg-muted text-foreground"
                  )}
                >
                  {muted ? <MicOff /> : <Mic />}
                </Button>
              }
            />
            <TooltipContent>{muted ? "Unmute" : "Mute"}</TooltipContent>
          </Tooltip>

          <label className="flex cursor-pointer items-center gap-2 px-2 select-none">
            <Languages className="size-3.5 text-muted-foreground" />
            <Switch size="sm" checked={showEn} onCheckedChange={toggleEn} />
          </label>

          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  variant="ghost"
                  size="icon-lg"
                  onClick={() =>
                    paused ? holds.forEach(release) : hold("control")
                  }
                  className={cn(
                    "rounded-full text-muted-foreground hover:text-foreground",
                    paused && "bg-primary/10 text-primary hover:text-primary"
                  )}
                >
                  {paused ? <Play /> : <Pause />}
                </Button>
              }
            />
            <TooltipContent>
              {paused ? "Resume" : "Hold"} · space
            </TooltipContent>
          </Tooltip>

          <Separator orientation="vertical" className="mx-0.5 h-4" />

          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  variant="ghost"
                  size="icon-lg"
                  className="rounded-full text-muted-foreground hover:text-destructive"
                >
                  <PhoneOff />
                </Button>
              }
            />
            <TooltipContent>End session</TooltipContent>
          </Tooltip>
        </div>
      </div>

      {/* Dev readout: what the engine thinks is happening. */}
      <div className="absolute right-4 bottom-4 z-10 font-mono text-[10px] text-muted-foreground/50">
        {paused ? `held · ${holds.join("+")}` : `${phase} · ${auraState}`}
      </div>
    </div>
  )
}
