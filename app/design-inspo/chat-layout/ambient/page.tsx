"use client"

/**
 * Chat layout — AMBIENT IMMERSION
 *
 * How little text can the surface carry while still teaching? The Aura is the
 * room: oversized, softened, drifting. The only text on the surface is the
 * current utterance, rendered as film captions bottom-center. Everything else
 * (history, translations, corrections) lives behind a temporary transcript
 * peek. After a learner turn settles, a whispered "1 note" invites the peek —
 * full corrections never render over the immersive view.
 *
 * A scripted demo loop replays the tail of the shared mock conversation
 * (tutor → learner turn that settles with a note → tutor → live interim) so
 * the surface can be felt, not just imagined.
 */

import { useEffect, useState } from "react"
import type { AgentState } from "@livekit/components-react"
import { AlignLeft, Mic, MicOff, PhoneOff, X } from "lucide-react"
import { AnimatePresence, motion } from "motion/react"

import { DEMO_STATES, MockAura } from "@/components/design/mock-aura"
import { Button } from "@/components/ui/button"
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover"
import { ScrollArea } from "@/components/ui/scroll-area"
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

/* ------------------------------------------------------------------ */
/* Correction category tints — quiet hues, never error-red.           */
/* ------------------------------------------------------------------ */

const CATEGORY_STYLES: Record<
  CorrectionCategory,
  { decoration: string; text: string; dot: string; hover: string }
> = {
  tense: {
    decoration: "decoration-amber-500/60",
    text: "text-amber-600 dark:text-amber-400",
    dot: "bg-amber-500",
    hover: "hover:bg-amber-500/10",
  },
  agreement: {
    decoration: "decoration-violet-500/60",
    text: "text-violet-600 dark:text-violet-400",
    dot: "bg-violet-500",
    hover: "hover:bg-violet-500/10",
  },
  "word-order": {
    decoration: "decoration-sky-500/60",
    text: "text-sky-600 dark:text-sky-400",
    dot: "bg-sky-500",
    hover: "hover:bg-sky-500/10",
  },
  vocabulary: {
    decoration: "decoration-teal-500/60",
    text: "text-teal-600 dark:text-teal-400",
    dot: "bg-teal-500",
    hover: "hover:bg-teal-500/10",
  },
  naturalness: {
    decoration: "decoration-fuchsia-500/50",
    text: "text-fuchsia-600 dark:text-fuchsia-400",
    dot: "bg-fuchsia-500",
    hover: "hover:bg-fuchsia-500/10",
  },
}

/* ------------------------------------------------------------------ */
/* Demo timeline — replays the tail of the shared conversation.       */
/* ------------------------------------------------------------------ */

interface Beat {
  id: string
  speaker: "learner" | "tutor"
  words: string[]
  en: string
  /** Present only on learner turns that settle with feedback. */
  corrections?: Correction[]
  /** How long the caption lingers after the last word. */
  holdMs: number
}

function beatFromTurn(id: string, holdMs: number): Beat {
  const turn = CONVERSATION.find((t) => t.id === id) ?? CONVERSATION[0]
  return {
    id: turn.id,
    speaker: turn.speaker,
    words: turn.es.split(" "),
    en: turn.en,
    corrections: turn.corrections,
    holdMs,
  }
}

const BEATS: Beat[] = [
  beatFromTurn("t7", 2400),
  beatFromTurn("t8", 4200),
  beatFromTurn("t9", 2600),
  {
    id: "interim",
    speaker: INTERIM.speaker,
    words: [...INTERIM.esWords],
    en: INTERIM.enPartial,
    holdMs: 4600,
  },
]

/* ------------------------------------------------------------------ */
/* Page                                                               */
/* ------------------------------------------------------------------ */

export default function AmbientImmersionPage() {
  const [beatIndex, setBeatIndex] = useState(0)
  const [wordCount, setWordCount] = useState(0)
  const [settled, setSettled] = useState(false)
  const [autoState, setAutoState] = useState<AgentState>("connecting")
  const [override, setOverride] = useState<AgentState | null>(null)
  const [muted, setMuted] = useState(false)
  const [revealEn, setRevealEn] = useState(false)
  const [transcriptOpen, setTranscriptOpen] = useState(false)

  /* Scripted loop: stream words, settle learner turns, hand back and forth. */
  useEffect(() => {
    let cancelled = false
    const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))
    const run = async () => {
      await sleep(1400)
      while (!cancelled) {
        for (let i = 0; i < BEATS.length && !cancelled; i++) {
          const beat = BEATS[i]
          setBeatIndex(i)
          setWordCount(0)
          setSettled(false)
          if (beat.speaker === "tutor") {
            setAutoState("thinking")
            await sleep(750)
            if (cancelled) return
            setAutoState("speaking")
          } else {
            setAutoState("listening")
            await sleep(500)
          }
          for (let w = 1; w <= beat.words.length; w++) {
            if (cancelled) return
            setWordCount(w)
            await sleep(190 + beat.words[w - 1].length * 24)
          }
          if (beat.speaker === "learner" && beat.corrections?.length) {
            setAutoState("thinking")
            await sleep(900)
            if (cancelled) return
            setSettled(true)
            setAutoState("listening")
          }
          if (beat.speaker === "tutor") setAutoState("listening")
          await sleep(beat.holdMs)
        }
      }
    }
    void run()
    return () => {
      cancelled = true
    }
  }, [])

  /* Keyboard: T peeks the transcript, Escape closes it. */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setTranscriptOpen(false)
      else if (
        e.key.toLowerCase() === "t" &&
        !e.metaKey &&
        !e.ctrlKey &&
        !e.altKey
      )
        setTranscriptOpen((o) => !o)
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [])

  const beat = BEATS[beatIndex]
  const prevBeat = beatIndex > 0 ? BEATS[beatIndex - 1] : null
  const lingering =
    prevBeat && prevBeat.speaker === "tutor" && beat.speaker === "learner"
      ? prevBeat
      : null
  const shownWords = beat.words.slice(0, wordCount)
  const noteCount = beat.corrections?.length ?? 0
  const noteCategory = beat.corrections?.[0]?.category ?? "naturalness"

  const auraState =
    override ?? (muted && autoState === "listening" ? "idle" : autoState)

  const cycleDevState = () =>
    setOverride((cur) => {
      if (cur === null) return DEMO_STATES[0]
      const i = DEMO_STATES.indexOf(cur)
      return i >= DEMO_STATES.length - 1 ? null : DEMO_STATES[i + 1]
    })

  return (
    <div className="group/stage relative h-full overflow-hidden">
      {/* Atmospheric radial tint behind the aura — reads in both themes. */}
      <div
        aria-hidden
        className="absolute inset-0 [background:radial-gradient(55%_48%_at_50%_42%,color-mix(in_oklch,var(--primary)_9%,transparent),transparent_78%)]"
      />

      {/* The aura is the room: oversized, softened, drifting. */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 flex items-center justify-center"
      >
        <motion.div
          animate={{ y: [0, -14, 0], scale: [1.65, 1.72, 1.65] }}
          transition={{ duration: 16, repeat: Infinity, ease: "easeInOut" }}
          className="-translate-y-[6%] opacity-70 blur-[2px] dark:opacity-60"
        >
          <MockAura state={auraState} size="xl" />
        </motion.div>
      </div>

      {/* Legibility scrim for the caption zone. */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-x-0 bottom-0 h-56 bg-gradient-to-t from-background/90 via-background/35 to-transparent"
      />

      {/* Caption layer — the only text on the immersive surface. */}
      <div className="absolute inset-x-0 bottom-0 z-10 flex flex-col items-center px-8 pb-20">
        {/* The preceding tutor line lingers briefly, dimmer, then fades. */}
        <div className="flex min-h-7 items-end">
          <AnimatePresence mode="wait">
            {lingering && (
              <motion.p
                key={`linger-${beatIndex}`}
                initial={{ opacity: 0.5, y: 0 }}
                animate={{ opacity: 0, y: -8 }}
                transition={{ delay: 2.8, duration: 1.8, ease: "easeOut" }}
                className="max-w-xl text-center text-sm leading-relaxed text-muted-foreground"
              >
                {lingering.words.join(" ")}
              </motion.p>
            )}
          </AnimatePresence>
        </div>

        {/* Speaker whisper-label. */}
        <AnimatePresence mode="wait">
          <motion.span
            key={`speaker-${beatIndex}`}
            initial={{ opacity: 0 }}
            animate={{ opacity: wordCount > 0 ? 1 : 0 }}
            exit={{ opacity: 0 }}
            className="mt-3 text-[10px] uppercase tracking-[0.3em] text-muted-foreground/50"
          >
            {beat.speaker === "tutor" ? "Tutor" : "You"}
          </motion.span>
        </AnimatePresence>

        {/* Current utterance, film-caption style. Hover / hold for English. */}
        <div
          className="flex min-h-24 cursor-default items-start justify-center pt-2"
          onMouseEnter={() => setRevealEn(true)}
          onMouseLeave={() => setRevealEn(false)}
          onPointerDown={() => setRevealEn(true)}
          onPointerUp={() => setRevealEn(false)}
          onPointerCancel={() => setRevealEn(false)}
        >
          <AnimatePresence mode="wait">
            <motion.p
              key={`caption-${beatIndex}`}
              exit={{ opacity: 0, y: -10, filter: "blur(4px)" }}
              transition={{ duration: 0.35, ease: "easeOut" }}
              className={cn(
                "max-w-2xl text-center leading-snug text-balance [text-shadow:0_0_24px_var(--background)]",
                beat.speaker === "tutor"
                  ? "text-xl font-light text-muted-foreground md:text-2xl"
                  : "text-2xl font-light tracking-tight text-foreground md:text-3xl"
              )}
            >
              {shownWords.map((word, i) => (
                <motion.span
                  key={`${beatIndex}-${i}`}
                  initial={{ opacity: 0, y: 6, filter: "blur(6px)" }}
                  animate={{ opacity: 1, y: 0, filter: "blur(0px)" }}
                  transition={{ duration: 0.45, ease: "easeOut" }}
                  className="inline-block [&:not(:last-child)]:mr-[0.32em]"
                >
                  {word}
                </motion.span>
              ))}
            </motion.p>
          </AnimatePresence>
        </div>

        {/* Translation reveal + post-settle whisper share one quiet slot. */}
        <div className="flex min-h-9 items-start justify-center">
          <AnimatePresence mode="wait">
            {revealEn && wordCount > 0 ? (
              <motion.p
                key="en"
                initial={{ opacity: 0, y: 5 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: 3 }}
                transition={{ duration: 0.3 }}
                className="max-w-xl text-center text-sm leading-relaxed text-muted-foreground"
              >
                {beat.en}
              </motion.p>
            ) : settled && noteCount > 0 ? (
              <motion.button
                key="whisper"
                type="button"
                initial={{ opacity: 0, y: 5 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0 }}
                transition={{ duration: 0.5, ease: "easeOut" }}
                onClick={() => setTranscriptOpen(true)}
                className="inline-flex items-center gap-1.5 rounded-full border border-border/60 bg-background/50 px-2.5 py-1 text-[11px] text-muted-foreground backdrop-blur-sm transition-colors hover:border-border hover:text-foreground"
              >
                <span
                  className={cn(
                    "size-1.5 rounded-full opacity-80",
                    CATEGORY_STYLES[noteCategory].dot
                  )}
                />
                {noteCount} note{noteCount === 1 ? "" : "s"}
              </motion.button>
            ) : null}
          </AnimatePresence>
        </div>
      </div>

      {/* Corner controls — nearly invisible until the stage is hovered. */}
      <div className="pointer-events-none absolute inset-x-0 bottom-0 z-20 flex items-end justify-between px-4 pb-4 opacity-25 transition-opacity duration-500 group-hover/stage:opacity-100 has-focus-visible:opacity-100">
        <div className="pointer-events-auto flex items-center gap-1">
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  variant="ghost"
                  size="icon"
                  className="text-muted-foreground hover:text-foreground"
                  onClick={() => setMuted((m) => !m)}
                >
                  {muted ? <MicOff /> : <Mic />}
                </Button>
              }
            />
            <TooltipContent>{muted ? "Unmute" : "Mute"}</TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  variant="ghost"
                  size="icon"
                  className="text-muted-foreground hover:text-foreground"
                >
                  <PhoneOff />
                </Button>
              }
            />
            <TooltipContent>End conversation</TooltipContent>
          </Tooltip>
        </div>

        <p className="pb-1.5 text-[10px] tracking-wide text-muted-foreground/60 max-md:hidden">
          hover caption for English&ensp;·&ensp;
          <kbd className="font-sans">T</kbd> for transcript
        </p>

        <div className="pointer-events-auto">
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  variant="ghost"
                  size="icon"
                  className="text-muted-foreground hover:text-foreground"
                  onClick={() => setTranscriptOpen((o) => !o)}
                >
                  <AlignLeft />
                </Button>
              }
            />
            <TooltipContent>Transcript · T</TooltipContent>
          </Tooltip>
        </div>
      </div>

      {/* Dev-only: cycle the aura through DEMO_STATES. */}
      <button
        type="button"
        onClick={cycleDevState}
        className="absolute top-3 right-4 z-20 font-mono text-[10px] text-muted-foreground/40 transition-colors hover:text-muted-foreground"
      >
        aura·{override ?? `auto(${autoState})`}
      </button>

      <TranscriptPeek
        open={transcriptOpen}
        onClose={() => setTranscriptOpen(false)}
      />
    </div>
  )
}

/* ------------------------------------------------------------------ */
/* Transcript peek — a temporary look behind the surface.             */
/* ------------------------------------------------------------------ */

function TranscriptPeek({
  open,
  onClose,
}: {
  open: boolean
  onClose: () => void
}) {
  return (
    <AnimatePresence>
      {open && (
        <>
          <motion.div
            key="scrim"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.25 }}
            onClick={onClose}
            className="absolute inset-0 z-30 bg-background/40 backdrop-blur-[2px]"
          />
          <motion.aside
            key="panel"
            initial={{ x: "100%" }}
            animate={{ x: 0 }}
            exit={{ x: "100%" }}
            transition={{ type: "spring", stiffness: 360, damping: 38 }}
            className="absolute inset-y-0 right-0 z-40 flex w-full max-w-md flex-col border-l border-border/60 bg-background/95 shadow-xl backdrop-blur-md"
          >
            <header className="flex h-12 shrink-0 items-center justify-between border-b border-border/60 pr-2 pl-6">
              <span className="text-sm font-medium">Transcript</span>
              <div className="flex items-center gap-2">
                <span className="text-[10px] text-muted-foreground/60">
                  esc
                </span>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  className="text-muted-foreground hover:text-foreground"
                  onClick={onClose}
                >
                  <X />
                </Button>
              </div>
            </header>
            <ScrollArea className="min-h-0 flex-1">
              <div className="space-y-7 px-6 py-6">
                {CONVERSATION.map((turn) => (
                  <TranscriptTurn key={turn.id} turn={turn} />
                ))}
              </div>
            </ScrollArea>
          </motion.aside>
        </>
      )}
    </AnimatePresence>
  )
}

function TranscriptTurn({ turn }: { turn: Turn }) {
  return (
    <div>
      <div className="text-[10px] uppercase tracking-[0.22em] text-muted-foreground/50">
        {turn.speaker === "tutor" ? "Tutor" : "You"}
      </div>
      <p
        className={cn(
          "mt-1.5 text-[15px] leading-relaxed",
          turn.speaker === "learner"
            ? "text-foreground"
            : "text-muted-foreground"
        )}
      >
        <MarkedText turn={turn} />
      </p>
      <p className="mt-1 text-xs leading-relaxed text-muted-foreground/70">
        {turn.en}
      </p>
    </div>
  )
}

/** Renders a turn's Spanish with category-tinted correction marks inline. */
function MarkedText({ turn }: { turn: Turn }) {
  const { es, corrections = [] } = turn
  const marks = corrections
    .map((c) => ({ c, start: es.indexOf(c.original) }))
    .filter((m) => m.start >= 0)
    .sort((a, b) => a.start - b.start)

  const nodes: React.ReactNode[] = []
  let pos = 0
  for (const { c, start } of marks) {
    if (start > pos) nodes.push(es.slice(pos, start))
    nodes.push(<CorrectionMark key={c.id} correction={c} />)
    pos = start + c.original.length
  }
  nodes.push(es.slice(pos))
  return <>{nodes}</>
}

function CorrectionMark({ correction }: { correction: Correction }) {
  const style = CATEGORY_STYLES[correction.category]
  return (
    <Popover>
      <PopoverTrigger
        nativeButton={false}
        render={<span />}
        tabIndex={0}
        className={cn(
          "cursor-pointer rounded-[3px] underline decoration-[1.5px] underline-offset-[3px] transition-colors",
          style.decoration,
          style.hover
        )}
      >
        {correction.original}
      </PopoverTrigger>
      <PopoverContent side="top" className="w-auto max-w-72 gap-2 p-3">
        <div className="flex flex-wrap items-baseline gap-x-2 text-sm">
          <span className="text-muted-foreground line-through decoration-muted-foreground/40">
            {correction.original}
          </span>
          <span aria-hidden className="text-muted-foreground/50">
            →
          </span>
          <span className={cn("font-medium", style.text)}>
            {correction.replacement}
          </span>
        </div>
        <div className="flex items-center gap-1.5 text-[10px] uppercase tracking-[0.16em] text-muted-foreground/60">
          <span className={cn("size-1.5 rounded-full opacity-70", style.dot)} />
          {CATEGORY_LABELS[correction.category]}
        </div>
        <p className="text-xs leading-relaxed text-muted-foreground">
          {correction.explanation}
        </p>
      </PopoverContent>
    </Popover>
  )
}
