"use client"

/**
 * AURA STAGE — design exploration variant.
 *
 * The Aura is the hero: large, centered, the visual anchor. The current
 * utterance renders as a large subtitle line beneath it, words arriving
 * progressively. History recedes upward — only the last few turns survive,
 * each smaller and dimmer, fading to nothing. This variant bets on
 * ephemerality: the conversation is a moment, not a document.
 *
 * A scripted replay loops through the shared mock conversation so the
 * settle → correction transition can be reviewed on repeat.
 */

import { useEffect, useMemo, useState, type ReactNode } from "react"
import type { AgentState } from "@livekit/components-react"
import { Languages, Mic, MicOff, MoveRight, PhoneOff } from "lucide-react"
import { AnimatePresence, motion } from "motion/react"

import { DEMO_STATES, MockAura } from "@/components/design/mock-aura"
import { Button } from "@/components/ui/button"
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover"
import { Separator } from "@/components/ui/separator"
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip"
import {
  CATEGORY_LABELS,
  CONVERSATION,
  INTERIM,
  type Correction,
  type CorrectionCategory,
  type Turn,
} from "@/lib/design/mock-conversation"
import { cn } from "@/lib/utils"

/* -------------------------------------------------------------------------- */
/*  Script                                                                    */
/* -------------------------------------------------------------------------- */

const INTERIM_TURN: Turn = {
  id: "interim",
  speaker: INTERIM.speaker,
  es: INTERIM.esWords.join(" "),
  en: INTERIM.enPartial,
}

const SCRIPT: Turn[] = [...CONVERSATION, INTERIM_TURN]

const HISTORY_DEPTH = 3

function wordsOf(es: string): string[] {
  return es.split(/\s+/).filter(Boolean)
}

/* -------------------------------------------------------------------------- */
/*  Correction category treatment                                             */
/* -------------------------------------------------------------------------- */

/**
 * Calm, differentiated hues per category. Corrections are invitations, not
 * failures — no destructive red anywhere.
 */
const CATEGORY_STYLES: Record<
  CorrectionCategory,
  { underline: string; accent: string }
> = {
  tense: {
    underline:
      "decoration-amber-500/60 hover:bg-amber-500/10 aria-expanded:bg-amber-500/10 dark:decoration-amber-400/50",
    accent: "text-amber-600 dark:text-amber-400",
  },
  agreement: {
    underline:
      "decoration-emerald-500/60 hover:bg-emerald-500/10 aria-expanded:bg-emerald-500/10 dark:decoration-emerald-400/50",
    accent: "text-emerald-600 dark:text-emerald-400",
  },
  "word-order": {
    underline:
      "decoration-violet-500/60 hover:bg-violet-500/10 aria-expanded:bg-violet-500/10 dark:decoration-violet-400/50",
    accent: "text-violet-600 dark:text-violet-400",
  },
  vocabulary: {
    underline:
      "decoration-teal-500/60 hover:bg-teal-500/10 aria-expanded:bg-teal-500/10 dark:decoration-teal-400/50",
    accent: "text-teal-600 dark:text-teal-400",
  },
  naturalness: {
    underline:
      "decoration-sky-500/60 hover:bg-sky-500/10 aria-expanded:bg-sky-500/10 dark:decoration-sky-400/50",
    accent: "text-sky-600 dark:text-sky-400",
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

/** Split a turn's Spanish text into plain / correction-marked segments. */
function segmentTurn(turn: Turn): Segment[] {
  const { es } = turn
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
/*  Correction mark + popover                                                 */
/* -------------------------------------------------------------------------- */

function CorrectionMark({
  correction,
  active,
  children,
}: {
  correction: Correction
  /** Marks only surface once the turn has settled. */
  active: boolean
  children: ReactNode
}) {
  const style = CATEGORY_STYLES[correction.category]
  return (
    <Popover>
      <PopoverTrigger
        nativeButton={false}
        render={
          <span
            className={cn(
              "rounded-xs underline decoration-[0.07em] underline-offset-[0.24em] transition-all duration-700",
              active
                ? cn("cursor-pointer", style.underline)
                : "pointer-events-none decoration-transparent"
            )}
          />
        }
      >
        {children}
      </PopoverTrigger>
      <PopoverContent className="w-auto max-w-72 min-w-56 gap-2.5 p-4" sideOffset={10}>
        <div className="flex items-center justify-center gap-2.5 text-base">
          <span className="text-muted-foreground line-through decoration-muted-foreground/40">
            {correction.original}
          </span>
          <MoveRight className="size-3.5 shrink-0 text-muted-foreground/60" />
          <span className={cn("font-medium", style.accent)}>
            {correction.replacement}
          </span>
        </div>
        <div className="text-center text-[10px] font-medium tracking-[0.18em] text-muted-foreground/70 uppercase">
          {CATEGORY_LABELS[correction.category]}
        </div>
        <Separator />
        <p className="text-xs leading-relaxed text-muted-foreground">
          {correction.explanation}
        </p>
      </PopoverContent>
    </Popover>
  )
}

/* -------------------------------------------------------------------------- */
/*  Translation reveal (hover, or pinned via the global toggle)               */
/* -------------------------------------------------------------------------- */

function TranslationReveal({ text, pinned }: { text: string; pinned: boolean }) {
  return (
    <div
      className={cn(
        "grid transition-all duration-300 ease-out",
        pinned
          ? "mt-2 grid-rows-[1fr] opacity-100"
          : "mt-0 grid-rows-[0fr] opacity-0 group-hover:mt-2 group-hover:grid-rows-[1fr] group-hover:opacity-100"
      )}
    >
      <div className="overflow-hidden">
        <p className="text-center text-sm leading-relaxed text-pretty text-muted-foreground">
          {text}
        </p>
      </div>
    </div>
  )
}

/* -------------------------------------------------------------------------- */
/*  Settled (history) line                                                    */
/* -------------------------------------------------------------------------- */

/** Opacity / scale steps by recency: 0 = most recent history line. */
const RECEDE = [
  { opacity: 0.72, scale: 1 },
  { opacity: 0.42, scale: 0.88 },
  { opacity: 0.2, scale: 0.78 },
] as const

function HistoryLine({
  turn,
  pos,
  translationsPinned,
}: {
  turn: Turn
  pos: number
  translationsPinned: boolean
}) {
  const step = RECEDE[Math.min(pos, RECEDE.length - 1)]!
  const segments = useMemo(() => segmentTurn(turn), [turn])
  return (
    <motion.div
      layout
      initial={{ opacity: 0, y: 20, scale: 1.05 }}
      animate={{ opacity: step.opacity, y: 0, scale: step.scale }}
      exit={{ opacity: 0, y: -14, transition: { duration: 0.35 } }}
      whileHover={{ opacity: 1 }}
      transition={{ duration: 0.45, ease: "easeOut" }}
      style={{ transformOrigin: "50% 100%" }}
      className="group w-full"
    >
      <p className="text-center text-lg leading-snug tracking-tight text-balance">
        {segments.map((seg) =>
          seg.correction ? (
            <CorrectionMark key={seg.key} correction={seg.correction} active>
              {seg.text}
            </CorrectionMark>
          ) : (
            <span key={seg.key}>{seg.text}</span>
          )
        )}
      </p>
      <TranslationReveal text={turn.en} pinned={translationsPinned} />
    </motion.div>
  )
}

/* -------------------------------------------------------------------------- */
/*  Current utterance — the big subtitle line                                 */
/* -------------------------------------------------------------------------- */

function CurrentWords({
  turn,
  wordCount,
  marksActive,
}: {
  turn: Turn
  wordCount: number
  marksActive: boolean
}) {
  const segments = useMemo(() => segmentTurn(turn), [turn])
  let index = 0
  const nodes: ReactNode[] = []

  for (const seg of segments) {
    const words = wordsOf(seg.text)
    const start = index
    index += words.length
    const visible = Math.max(0, Math.min(words.length, wordCount - start))
    if (visible === 0) continue

    const wordNodes = words.slice(0, visible).map((word, i) => (
      <motion.span
        key={`${turn.id}-${start + i}`}
        // Once marks are active the words sit inline so the parent's
        // underline can run through them (it doesn't reach inline-blocks).
        className={cn(
          seg.correction && marksActive ? "inline" : "inline-block"
        )}
        initial={{ opacity: 0, y: 8, filter: "blur(6px)" }}
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

    if (seg.correction) {
      nodes.push(
        <CorrectionMark
          key={seg.key}
          correction={seg.correction}
          active={marksActive}
        >
          {interleaved}
        </CorrectionMark>
      )
    } else {
      nodes.push(<span key={seg.key}>{interleaved}</span>)
    }
    nodes.push(" ")
  }

  return <>{nodes}</>
}

function CurrentLine({
  turn,
  wordCount,
  settled,
  translationsPinned,
}: {
  turn: Turn
  wordCount: number
  settled: boolean
  translationsPinned: boolean
}) {
  const isInterim = turn.id === INTERIM_TURN.id
  const total = wordsOf(turn.es).length
  const complete = wordCount >= total
  const marksActive = settled && !isInterim
  const showCaret = !settled || isInterim

  return (
    <>
      <div className="mb-3 text-center text-[10px] font-medium tracking-[0.22em] text-muted-foreground/60 uppercase">
        {turn.speaker === "learner" ? "You" : "Tutor"}
      </div>
      <p className="min-h-[2.6em] text-center text-2xl leading-snug tracking-tight text-balance md:text-3xl">
        <CurrentWords
          turn={turn}
          wordCount={wordCount}
          marksActive={marksActive}
        />
        {showCaret && wordCount > 0 && (
          <span className="ml-1 inline-block h-[1.05em] w-0.5 translate-y-[0.16em] rounded-full bg-primary/50 motion-safe:animate-pulse" />
        )}
      </p>
      <TranslationReveal
        text={turn.en}
        pinned={translationsPinned && (isInterim ? wordCount > 0 : complete)}
      />
    </>
  )
}

/* -------------------------------------------------------------------------- */
/*  Page                                                                      */
/* -------------------------------------------------------------------------- */

export default function AuraStagePage() {
  // Replay engine: word-by-word typing, then a hold while the turn settles
  // (corrections surface here), then the line recedes into history.
  const [turnIdx, setTurnIdx] = useState(SCRIPT.length - 1)
  const [wordCount, setWordCount] = useState(0)
  const [phase, setPhase] = useState<"typing" | "hold">("typing")

  // Controls (non-functional demo state).
  const [micMuted, setMicMuted] = useState(false)
  const [translationsPinned, setTranslationsPinned] = useState(false)

  // Dev-only aura state override: -1 = follow the replay.
  const [overrideIdx, setOverrideIdx] = useState(-1)
  const override = overrideIdx >= 0 ? DEMO_STATES[overrideIdx] : undefined

  const turn = SCRIPT[Math.min(turnIdx, SCRIPT.length - 1)]!
  const isLast = turnIdx === SCRIPT.length - 1

  useEffect(() => {
    const current = SCRIPT[turnIdx]!
    const total = wordsOf(current.es).length
    const last = turnIdx === SCRIPT.length - 1
    let timer: ReturnType<typeof setTimeout>

    if (phase === "typing") {
      if (wordCount < total) {
        timer = setTimeout(
          () => setWordCount((c) => c + 1),
          current.speaker === "learner" ? 250 : 200
        )
      } else {
        timer = setTimeout(() => setPhase("hold"), 200)
      }
    } else {
      const hold = last
        ? 4500
        : current.corrections?.length
          ? 3200
          : 1500
      timer = setTimeout(() => {
        setPhase("typing")
        setWordCount(0)
        setTurnIdx(last ? 0 : turnIdx + 1)
      }, hold)
    }
    return () => clearTimeout(timer)
  }, [turnIdx, wordCount, phase])

  const history = SCRIPT.slice(Math.max(0, turnIdx - HISTORY_DEPTH), turnIdx)

  const autoState: AgentState =
    phase === "typing"
      ? turn.speaker === "tutor"
        ? "speaking"
        : "listening"
      : isLast || turn.speaker === "tutor"
        ? "listening"
        : "thinking"

  const auraState = override ?? autoState

  return (
    <div className="relative h-full overflow-hidden bg-background">
      <div className="flex h-full flex-col items-center px-6">
        {/* The Aura — visual anchor of the stage. */}
        <div className="flex shrink-0 items-center justify-center pt-[clamp(1rem,6vh,4rem)]">
          <MockAura
            state={auraState}
            size="xl"
            className="h-[clamp(9rem,30vh,17rem)]"
          />
        </div>

        {/* History recedes upward, fading to nothing. */}
        <div className="flex min-h-0 w-full max-w-2xl flex-1 flex-col items-center justify-end gap-2.5 overflow-hidden pt-4 [mask-image:linear-gradient(to_bottom,transparent_0%,black_60%)]">
          <AnimatePresence initial={false}>
            {history.map((t, i) => (
              <HistoryLine
                key={t.id}
                turn={t}
                pos={history.length - 1 - i}
                translationsPinned={translationsPinned}
              />
            ))}
          </AnimatePresence>
        </div>

        {/* The current utterance — large subtitle beneath the Aura. */}
        <div className="w-full max-w-3xl shrink-0 pt-6 pb-32">
          <AnimatePresence mode="popLayout" initial={false}>
            <motion.div
              key={turn.id}
              initial={{ opacity: 0, y: 12 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -30, scale: 0.9 }}
              transition={{ duration: 0.35, ease: "easeOut" }}
              className="group w-full"
            >
              <CurrentLine
                turn={turn}
                wordCount={wordCount}
                settled={phase === "hold"}
                translationsPinned={translationsPinned}
              />
            </motion.div>
          </AnimatePresence>
        </div>
      </div>

      {/* Floating session controls. */}
      <div className="absolute bottom-7 left-1/2 z-10 -translate-x-1/2">
        <div className="flex items-center gap-1 rounded-full border border-border/60 bg-background/70 p-1.5 shadow-sm backdrop-blur-md">
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  variant="ghost"
                  size="icon-lg"
                  className={cn(
                    "rounded-full",
                    micMuted && "bg-muted text-foreground"
                  )}
                  onClick={() => setMicMuted((m) => !m)}
                >
                  {micMuted ? <MicOff /> : <Mic />}
                </Button>
              }
            />
            <TooltipContent>{micMuted ? "Unmute" : "Mute"}</TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  variant="ghost"
                  size="icon-lg"
                  className={cn(
                    "rounded-full",
                    translationsPinned && "bg-muted text-foreground"
                  )}
                  onClick={() => setTranslationsPinned((t) => !t)}
                >
                  <Languages />
                </Button>
              }
            />
            <TooltipContent>
              {translationsPinned ? "Hide translations" : "Show translations"}
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

      {/* Dev control: cycle the Aura through its demo states. */}
      <button
        type="button"
        onClick={() =>
          setOverrideIdx((i) => ((i + 2) % (DEMO_STATES.length + 1)) - 1)
        }
        className="absolute right-4 bottom-4 z-10 flex items-center gap-1.5 rounded-full border border-border/50 bg-background/60 px-2.5 py-1 font-mono text-[10px] text-muted-foreground/70 backdrop-blur transition-colors hover:text-foreground"
      >
        <span
          className={cn(
            "size-1.5 rounded-full",
            override ? "bg-primary" : "bg-muted-foreground/40"
          )}
        />
        aura: {override ?? "auto"}
      </button>
    </div>
  )
}
