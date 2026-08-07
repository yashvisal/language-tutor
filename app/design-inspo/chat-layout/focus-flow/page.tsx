"use client"

/**
 * FOCUS FLOW — design exploration variant.
 *
 * The conversation as a single flowing document: no bubbles, no cards, no
 * chrome. Speaker is carried purely by typography (tutor muted, learner full
 * foreground). The signature move is a recency gradient — the newest speech
 * renders largest and fully opaque, each older turn steps down in size and
 * opacity, so attention naturally pools at the bottom where language is
 * happening right now. Hovering an older turn re-focuses it.
 */

import { useEffect, useMemo, useRef, useState } from "react"
import { AnimatePresence, motion } from "motion/react"
import { Languages, Mic, MicOff, PhoneOff } from "lucide-react"
import type { AgentState } from "@livekit/components-react"

import { DEMO_STATES, MockAura } from "@/components/design/mock-aura"
import {
  CATEGORY_LABELS,
  CONVERSATION,
  INTERIM,
  type Correction,
  type CorrectionCategory,
  type Turn,
} from "@/lib/design/mock-conversation"
import { Button } from "@/components/ui/button"
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover"
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip"
import { cn } from "@/lib/utils"

/* -------------------------------------------------------------------------- */
/* Recency gradient                                                           */
/* -------------------------------------------------------------------------- */

/** Step 0 = the interim utterance (largest); older turns step down. */
const SIZE_STEPS = [
  "text-2xl/[1.55]",
  "text-xl/[1.6]",
  "text-lg/[1.65]",
  "text-base/[1.7]",
  "text-[0.9375rem]/[1.7]",
  "text-sm/[1.75]",
]

const OPACITY_STEPS = [
  "opacity-100",
  "opacity-95",
  "opacity-80",
  "opacity-65",
  "opacity-55",
  "opacity-45",
]

function stepFor(indexFromEnd: number) {
  const step = Math.min(indexFromEnd, SIZE_STEPS.length - 1)
  return { size: SIZE_STEPS[step], opacity: OPACITY_STEPS[step] }
}

/* -------------------------------------------------------------------------- */
/* Correction category tints — calm, never error-red                          */
/* -------------------------------------------------------------------------- */

interface CategoryTint {
  decoration: string
  text: string
  dot: string
  hoverBg: string
}

const CATEGORY_TINTS: Record<CorrectionCategory, CategoryTint> = {
  tense: {
    decoration: "decoration-indigo-500/45 dark:decoration-indigo-400/50",
    text: "text-indigo-600 dark:text-indigo-300",
    dot: "bg-indigo-500/80",
    hoverBg: "hover:bg-indigo-500/[0.07]",
  },
  agreement: {
    decoration: "decoration-violet-500/45 dark:decoration-violet-400/50",
    text: "text-violet-600 dark:text-violet-300",
    dot: "bg-violet-500/80",
    hoverBg: "hover:bg-violet-500/[0.07]",
  },
  "word-order": {
    decoration: "decoration-amber-500/55 dark:decoration-amber-400/50",
    text: "text-amber-700 dark:text-amber-300",
    dot: "bg-amber-500/80",
    hoverBg: "hover:bg-amber-500/[0.08]",
  },
  vocabulary: {
    decoration: "decoration-teal-500/50 dark:decoration-teal-400/50",
    text: "text-teal-700 dark:text-teal-300",
    dot: "bg-teal-500/80",
    hoverBg: "hover:bg-teal-500/[0.07]",
  },
  naturalness: {
    decoration: "decoration-sky-500/45 dark:decoration-sky-400/50",
    text: "text-sky-700 dark:text-sky-300",
    dot: "bg-sky-500/80",
    hoverBg: "hover:bg-sky-500/[0.07]",
  },
}

/* -------------------------------------------------------------------------- */
/* Aura state labels                                                          */
/* -------------------------------------------------------------------------- */

const STATE_LABELS: Partial<Record<AgentState, string>> = {
  idle: "idle",
  connecting: "connecting…",
  initializing: "initializing…",
  listening: "listening…",
  thinking: "thinking…",
  speaking: "speaking",
}

/* -------------------------------------------------------------------------- */
/* Text segmentation for inline corrections                                   */
/* -------------------------------------------------------------------------- */

interface Segment {
  text: string
  correction?: Correction
}

function segmentEs(turn: Turn): Segment[] {
  const placed = (turn.corrections ?? [])
    .map((c) => ({ c, idx: turn.es.indexOf(c.original) }))
    .filter((x) => x.idx !== -1)
    .sort((a, b) => a.idx - b.idx)

  const out: Segment[] = []
  let cursor = 0
  for (const { c, idx } of placed) {
    if (idx > cursor) out.push({ text: turn.es.slice(cursor, idx) })
    out.push({ text: c.original, correction: c })
    cursor = idx + c.original.length
  }
  if (cursor < turn.es.length) out.push({ text: turn.es.slice(cursor) })
  return out
}

/* -------------------------------------------------------------------------- */
/* Inline correction: subtle mark → popover → inline strike/morph             */
/* -------------------------------------------------------------------------- */

function CorrectionSpan({
  correction,
  revealed,
  onReveal,
}: {
  correction: Correction
  revealed: boolean
  onReveal: () => void
}) {
  const tint = CATEGORY_TINTS[correction.category]
  return (
    <Popover
      onOpenChange={(open) => {
        if (open) onReveal()
      }}
    >
      <PopoverTrigger
        nativeButton={false}
        render={
          <span
            className={cn(
              "cursor-pointer rounded-sm px-px transition-colors duration-200 outline-none focus-visible:ring-2 focus-visible:ring-ring/30",
              tint.hoverBg,
              !revealed &&
                cn(
                  "underline decoration-[0.075em] underline-offset-[0.3em]",
                  tint.decoration
                )
            )}
          />
        }
      >
        {revealed ? (
          <>
            <span className="text-muted-foreground/60 line-through decoration-muted-foreground/35 decoration-[0.06em]">
              {correction.original}
            </span>{" "}
            <motion.span
              initial={{ opacity: 0, y: 3 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.25, ease: "easeOut" }}
              className={cn("inline-block font-medium", tint.text)}
            >
              {correction.replacement}
            </motion.span>
          </>
        ) : (
          correction.original
        )}
      </PopoverTrigger>
      <PopoverContent className="w-auto max-w-72 gap-2 p-3">
        <div className="text-muted-foreground flex items-center gap-1.5 text-[0.625rem] font-medium tracking-[0.14em] uppercase">
          <span className={cn("size-1.5 rounded-full", tint.dot)} />
          {CATEGORY_LABELS[correction.category]}
        </div>
        <div className="text-sm">
          <span className="text-muted-foreground line-through decoration-muted-foreground/40">
            {correction.original}
          </span>
          <span className="text-muted-foreground/60 mx-1.5">→</span>
          <span className={cn("font-medium", tint.text)}>
            {correction.replacement}
          </span>
        </div>
        <p className="text-muted-foreground text-xs leading-relaxed">
          {correction.explanation}
        </p>
      </PopoverContent>
    </Popover>
  )
}

/* -------------------------------------------------------------------------- */
/* A settled turn — a paragraph in the document                               */
/* -------------------------------------------------------------------------- */

function TurnBlock({
  turn,
  indexFromEnd,
  showEn,
  onToggleEn,
  revealedCorrections,
  onRevealCorrection,
}: {
  turn: Turn
  indexFromEnd: number
  showEn: boolean
  onToggleEn: () => void
  revealedCorrections: Set<string>
  onRevealCorrection: (id: string) => void
}) {
  const { size, opacity } = stepFor(indexFromEnd)
  const segments = useMemo(() => segmentEs(turn), [turn])
  const isTutor = turn.speaker === "tutor"

  return (
    <article
      className={cn(
        "group transition-opacity duration-300 hover:opacity-100 focus-within:opacity-100",
        opacity
      )}
    >
      <div className="mb-1 flex items-center gap-2">
        <span
          className={cn(
            "text-[0.625rem] font-medium tracking-[0.2em] uppercase select-none",
            isTutor ? "text-muted-foreground/60" : "text-primary/60"
          )}
        >
          {isTutor ? "Tutor" : "You"}
        </span>
        <button
          type="button"
          aria-label="Toggle translation"
          aria-pressed={showEn}
          onClick={onToggleEn}
          className={cn(
            "text-muted-foreground/50 hover:text-muted-foreground rounded-sm p-0.5 opacity-0 transition-opacity outline-none group-hover:opacity-100 focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-ring/30",
            showEn && "text-primary/70 hover:text-primary opacity-100"
          )}
        >
          <Languages className="size-3" />
        </button>
      </div>

      <p
        className={cn(
          "tracking-[-0.01em]",
          size,
          isTutor ? "text-muted-foreground" : "text-foreground"
        )}
      >
        {segments.map((seg, i) =>
          seg.correction ? (
            <CorrectionSpan
              key={seg.correction.id}
              correction={seg.correction}
              revealed={revealedCorrections.has(seg.correction.id)}
              onReveal={() => onRevealCorrection(seg.correction!.id)}
            />
          ) : (
            <span key={i}>{seg.text}</span>
          )
        )}
      </p>

      <AnimatePresence initial={false}>
        {showEn && (
          <motion.div
            key="en"
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.22, ease: "easeOut" }}
            className="overflow-hidden"
          >
            <p className={cn("text-muted-foreground/75 pt-1.5 text-[0.72em] italic", size)}>
              {turn.en}
            </p>
          </motion.div>
        )}
      </AnimatePresence>
    </article>
  )
}

/* -------------------------------------------------------------------------- */
/* The interim utterance — largest, words arriving live                       */
/* -------------------------------------------------------------------------- */

function InterimBlock({
  translationOn,
  onWordsChange,
}: {
  translationOn: boolean
  onWordsChange: () => void
}) {
  const [wordCount, setWordCount] = useState(1)
  const [cycle, setCycle] = useState(0)

  useEffect(() => {
    if (wordCount < INTERIM.esWords.length) {
      const t = setTimeout(
        () => setWordCount((c) => c + 1),
        300 + Math.random() * 280
      )
      return () => clearTimeout(t)
    }
    // Hold the finished utterance, then replay — keeps the live feeling on loop.
    const t = setTimeout(() => {
      setWordCount(1)
      setCycle((c) => c + 1)
    }, 3400)
    return () => clearTimeout(t)
  }, [wordCount])

  useEffect(() => {
    onWordsChange()
  }, [wordCount, onWordsChange])

  const ratio = wordCount / INTERIM.esWords.length
  const enSoFar = INTERIM.enPartial.slice(
    0,
    Math.round(ratio * INTERIM.enPartial.length)
  )

  return (
    <div>
      <div className="mb-1 flex items-center gap-2">
        <span className="text-primary/60 text-[0.625rem] font-medium tracking-[0.2em] uppercase select-none">
          You
        </span>
        <span className="bg-primary/70 size-1.5 animate-pulse rounded-full" />
      </div>

      <p className="text-foreground text-2xl/[1.55] tracking-[-0.01em]">
        {INTERIM.esWords.slice(0, wordCount).map((word, i) => (
          <motion.span
            key={`${cycle}-${i}`}
            initial={{ opacity: 0, y: 4, filter: "blur(4px)" }}
            animate={{ opacity: 1, y: 0, filter: "blur(0px)" }}
            transition={{ duration: 0.28, ease: "easeOut" }}
            className="inline-block"
          >
            {word}
            {" "}
          </motion.span>
        ))}
        <span
          aria-hidden
          className="bg-primary/70 animate-caret-blink ml-0.5 inline-block h-[1.1em] w-0.5 translate-y-[0.18em] rounded-full"
        />
      </p>

      {translationOn && (
        <p className="text-muted-foreground/75 min-h-[1.5em] pt-1.5 text-base italic">
          {enSoFar}
        </p>
      )}
    </div>
  )
}

/* -------------------------------------------------------------------------- */
/* Page                                                                       */
/* -------------------------------------------------------------------------- */

export default function FocusFlowPage() {
  const [auraState, setAuraState] = useState<AgentState>("listening")
  const [translationOn, setTranslationOn] = useState(false)
  const [micMuted, setMicMuted] = useState(false)
  const [revealedEn, setRevealedEn] = useState<Set<string>>(new Set())
  const [revealedCorrections, setRevealedCorrections] = useState<Set<string>>(
    new Set()
  )

  const scrollRef = useRef<HTMLDivElement>(null)
  const pinnedRef = useRef(true)

  // Start reading at the bottom — that's where the conversation is alive.
  useEffect(() => {
    const el = scrollRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [])

  const scrollToBottomIfPinned = () => {
    const el = scrollRef.current
    if (el && pinnedRef.current) el.scrollTop = el.scrollHeight
  }

  const toggleEn = (id: string) =>
    setRevealedEn((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })

  const revealCorrection = (id: string) =>
    setRevealedCorrections((prev) => {
      if (prev.has(id)) return prev
      const next = new Set(prev)
      next.add(id)
      return next
    })

  const cycleAura = () =>
    setAuraState(
      (prev) => DEMO_STATES[(DEMO_STATES.indexOf(prev) + 1) % DEMO_STATES.length]
    )

  return (
    <div className="relative h-full overflow-hidden">
      <div
        ref={scrollRef}
        onScroll={(e) => {
          const el = e.currentTarget
          pinnedRef.current =
            el.scrollHeight - el.scrollTop - el.clientHeight < 100
        }}
        className="h-full overflow-y-auto"
      >
        <div className="mx-auto max-w-2xl px-6 pb-44">
          {/* Aura docked quietly at the top of the column */}
          <div className="bg-linear-to-b from-background via-background/85 to-transparent pointer-events-none sticky top-0 z-10 -mx-6 px-6 pt-5 pb-8">
            <div className="pointer-events-auto flex items-center gap-3">
              <MockAura state={auraState} size="sm" />
              <span className="text-muted-foreground text-sm select-none">
                {STATE_LABELS[auraState] ?? auraState}
              </span>
            </div>
          </div>

          <div className="space-y-9 pt-2">
            {CONVERSATION.map((turn, i) => (
              <TurnBlock
                key={turn.id}
                turn={turn}
                indexFromEnd={CONVERSATION.length - i}
                showEn={translationOn || revealedEn.has(turn.id)}
                onToggleEn={() => toggleEn(turn.id)}
                revealedCorrections={revealedCorrections}
                onRevealCorrection={revealCorrection}
              />
            ))}

            <InterimBlock
              translationOn={translationOn}
              onWordsChange={scrollToBottomIfPinned}
            />
          </div>
        </div>
      </div>

      {/* Soft fade so the document dissolves behind the control bar */}
      <div className="bg-linear-to-t from-background to-transparent pointer-events-none absolute inset-x-0 bottom-0 h-16" />

      {/* Quiet conversation controls */}
      <div className="pointer-events-none absolute inset-x-0 bottom-0 z-10 flex justify-center pb-5">
        <div className="bg-background/85 pointer-events-auto flex items-center gap-1 rounded-full border p-1 shadow-xs backdrop-blur-md">
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label={micMuted ? "Unmute microphone" : "Mute microphone"}
                  aria-pressed={micMuted}
                  onClick={() => setMicMuted((m) => !m)}
                  className={cn(
                    "rounded-full",
                    micMuted && "bg-muted text-foreground"
                  )}
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
                  size="icon-sm"
                  aria-label="Toggle translation"
                  aria-pressed={translationOn}
                  onClick={() => setTranslationOn((t) => !t)}
                  className={cn(
                    "rounded-full",
                    translationOn && "bg-primary/10 text-primary hover:bg-primary/15 hover:text-primary"
                  )}
                >
                  <Languages />
                </Button>
              }
            />
            <TooltipContent>
              {translationOn ? "Hide translation" : "Show translation"}
            </TooltipContent>
          </Tooltip>

          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label="End conversation"
                  className="text-muted-foreground hover:text-foreground rounded-full"
                >
                  <PhoneOff />
                </Button>
              }
            />
            <TooltipContent>End conversation</TooltipContent>
          </Tooltip>
        </div>
      </div>

      {/* Dev-only: cycle the Aura through its states */}
      <button
        type="button"
        onClick={cycleAura}
        className="text-muted-foreground/50 hover:text-muted-foreground hover:bg-muted/50 absolute top-3 right-4 z-20 rounded-md px-2 py-1 font-mono text-[0.625rem] transition-colors"
      >
        aura: {auraState}
      </button>
    </div>
  )
}
