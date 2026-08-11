"use client"

/**
 * SPLIT COLUMNS — chat-layout variant.
 *
 * Tests always-available side-by-side translation: Spanish left (primary),
 * English right (secondary, muted). The whole English column is governed by
 * one switch; hiding it collapses the transcript into a single centered
 * column. The design question: does the parallel English column support the
 * learner, or does it dominate and pull the eye away from Spanish?
 */

import * as React from "react"
import { AnimatePresence, motion } from "motion/react"
import { Languages, Mic, MicOff, PhoneOff } from "lucide-react"
import type { AgentState } from "@livekit/components-react"

import { MockAura, DEMO_STATES } from "@/components/design/mock-aura"
import {
  CONVERSATION,
  INTERIM,
  CATEGORY_LABELS,
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
import { Separator } from "@/components/ui/separator"
import { Switch } from "@/components/ui/switch"
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip"
import { cn } from "@/lib/utils"

/* ----------------------------------------------------------------------------
 * Constants
 * ------------------------------------------------------------------------- */

/** Total width of the English column incl. its left gutter, in px. */
const EN_COL_W = 288
/** Left gutter inside the English column, so the gap collapses with it. */
const EN_COL_GUTTER = 40

/** Shared tween so the column collapse and the container re-center in sync. */
const COL_TRANSITION = { duration: 0.5, ease: [0.32, 0.72, 0, 1] as const }

const STATE_WORDS: Partial<Record<AgentState, string>> = {
  idle: "idle",
  connecting: "connecting…",
  initializing: "warming up…",
  listening: "listening",
  thinking: "thinking…",
  speaking: "speaking",
}

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

/* ----------------------------------------------------------------------------
 * Interim (live transcription) simulation
 * ------------------------------------------------------------------------- */

const ES_TICK_MS = 380
/** Ticks of stillness after the utterance completes, before it loops. */
const PAUSE_TICKS = 8
/** Translation trails transcription by this many ticks — the lag is the point. */
const EN_LAG_TICKS = 3

function useInterimSim() {
  const totalEs = INTERIM.esWords.length
  const enWords = React.useMemo(() => INTERIM.enPartial.split(" "), [])
  const [tick, setTick] = React.useState(0)

  React.useEffect(() => {
    const id = setInterval(
      () => setTick((t) => (t + 1) % (totalEs + PAUSE_TICKS)),
      ES_TICK_MS
    )
    return () => clearInterval(id)
  }, [totalEs])

  const esCount = Math.min(tick, totalEs)
  // English catches up gradually and only finishes a beat after speech stops.
  const enProgress = Math.min(1, Math.max(0, (tick - EN_LAG_TICKS) / totalEs))
  const enCount = Math.round(enProgress * enWords.length)
  const speaking = tick > 0 && tick < totalEs

  return { tick, esCount, enWords, enCount, speaking }
}

/* ----------------------------------------------------------------------------
 * Page
 * ------------------------------------------------------------------------- */

export default function SplitColumnsPage() {
  const [showEn, setShowEn] = React.useState(true)
  const [muted, setMuted] = React.useState(false)
  const [stateIdx, setStateIdx] = React.useState(
    DEMO_STATES.indexOf("listening")
  )
  const auraState = DEMO_STATES[stateIdx] ?? "listening"

  const interim = useInterimSim()
  const scrollRef = React.useRef<HTMLDivElement>(null)

  // Pin to the newest turn — but only when the reader is already near the
  // bottom, so scrolling back through history isn't hijacked by the loop.
  React.useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    if (el.scrollHeight - el.scrollTop - el.clientHeight < 160) {
      el.scrollTop = el.scrollHeight
    }
  }, [interim.tick])

  React.useEffect(() => {
    const el = scrollRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [])

  return (
    <div className="relative flex h-full flex-col overflow-hidden">
      {/* Dev control: cycle the Aura through its demo states. */}
      <button
        type="button"
        onClick={() => setStateIdx((i) => (i + 1) % DEMO_STATES.length)}
        className="text-muted-foreground/50 hover:bg-muted/50 hover:text-muted-foreground absolute top-3 right-4 z-10 rounded-md px-2 py-1 font-mono text-[10px] transition-colors"
      >
        aura · {auraState}
      </button>

      {/* Aura anchor */}
      <div className="flex shrink-0 flex-col items-center pt-7 pb-3">
        <MockAura state={auraState} size="md" />
        <div className="mt-2 h-4">
          <AnimatePresence mode="wait" initial={false}>
            <motion.span
              key={auraState}
              initial={{ opacity: 0, y: 3 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -3 }}
              transition={{ duration: 0.25 }}
              className="text-muted-foreground/70 block text-[11px] tracking-[0.14em] lowercase"
            >
              {STATE_WORDS[auraState] ?? auraState}
            </motion.span>
          </AnimatePresence>
        </div>
      </div>

      {/* Transcript */}
      <div className="relative min-h-0 flex-1">
        <div ref={scrollRef} className="h-full overflow-y-auto px-6">
          <div
            className={cn(
              "mx-auto w-full pt-8 pb-12 transition-[max-width] duration-500 ease-in-out",
              showEn ? "max-w-[56rem]" : "max-w-[36rem]"
            )}
          >
            <div className="space-y-8">
              {CONVERSATION.map((turn) => (
                <TurnRow key={turn.id} turn={turn} showEn={showEn} />
              ))}
              <InterimRow showEn={showEn} {...interim} />
            </div>
          </div>
        </div>
        {/* Soft edges so history feels like it recedes, not clips. */}
        <div className="from-background pointer-events-none absolute inset-x-0 top-0 h-8 bg-linear-to-b to-transparent" />
        <div className="from-background pointer-events-none absolute inset-x-0 bottom-0 h-8 bg-linear-to-t to-transparent" />
      </div>

      {/* Controls */}
      <div className="flex shrink-0 items-center justify-center gap-3 pt-2 pb-5">
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                variant="ghost"
                size="icon-lg"
                onClick={() => setMuted((m) => !m)}
                className={cn(
                  "text-muted-foreground hover:text-foreground rounded-full",
                  muted && "text-foreground bg-muted"
                )}
              >
                {muted ? <MicOff /> : <Mic />}
              </Button>
            }
          />
          <TooltipContent>{muted ? "Unmute" : "Mute"}</TooltipContent>
        </Tooltip>

        <Separator orientation="vertical" className="h-4" />

        <label className="flex cursor-pointer items-center gap-2 px-1 select-none">
          <Languages className="text-muted-foreground size-3.5" />
          <span className="text-muted-foreground text-xs">English</span>
          <Switch size="sm" checked={showEn} onCheckedChange={setShowEn} />
        </label>

        <Separator orientation="vertical" className="h-4" />

        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                variant="ghost"
                size="icon-lg"
                className="text-muted-foreground hover:text-destructive rounded-full"
              >
                <PhoneOff />
              </Button>
            }
          />
          <TooltipContent>End session</TooltipContent>
        </Tooltip>
      </div>
    </div>
  )
}

/* ----------------------------------------------------------------------------
 * Transcript rows
 * ------------------------------------------------------------------------- */

/**
 * One settled turn: Spanish left (primary), English right (secondary).
 * `items-baseline` pairs the first lines; both columns share a 2rem line
 * height so wrapped lines stay on the same baseline grid.
 */
function TurnRow({ turn, showEn }: { turn: Turn; showEn: boolean }) {
  const isTutor = turn.speaker === "tutor"
  return (
    <div>
      {isTutor && (
        <div className="text-muted-foreground/60 mb-0.5 text-[10px] font-medium tracking-[0.16em] uppercase">
          Tutor
        </div>
      )}
      <div className="flex items-baseline">
        <p
          className={cn(
            "min-w-0 flex-1 text-lg leading-8 tracking-[-0.011em]",
            isTutor ? "text-foreground/60" : "text-foreground"
          )}
        >
          {isTutor ? turn.es : <EsWithCorrections turn={turn} />}
        </p>
        <EnCell showEn={showEn}>{turn.en}</EnCell>
      </div>
    </div>
  )
}

/**
 * The collapsible English cell. The inner content keeps a fixed width so the
 * text never reflows mid-animation — the column simply slides shut while the
 * container re-centers around the Spanish.
 */
function EnCell({
  showEn,
  children,
}: {
  showEn: boolean
  children: React.ReactNode
}) {
  return (
    <motion.div
      initial={false}
      animate={{ width: showEn ? EN_COL_W : 0, opacity: showEn ? 1 : 0 }}
      transition={COL_TRANSITION}
      aria-hidden={!showEn}
      className="overflow-hidden"
    >
      <div
        style={{ width: EN_COL_W, paddingLeft: EN_COL_GUTTER }}
        className="text-muted-foreground text-sm leading-8"
      >
        {children}
      </div>
    </motion.div>
  )
}

/** Spanish text with correction marks spliced in at their exact spans. */
function EsWithCorrections({ turn }: { turn: Turn }) {
  const corrections = turn.corrections ?? []
  if (corrections.length === 0) return <>{turn.es}</>

  const nodes: React.ReactNode[] = []
  let cursor = 0
  for (const c of corrections) {
    const idx = turn.es.indexOf(c.original, cursor)
    if (idx === -1) continue
    if (idx > cursor) {
      nodes.push(
        <React.Fragment key={`${c.id}-pre`}>
          {turn.es.slice(cursor, idx)}
        </React.Fragment>
      )
    }
    nodes.push(<CorrectionMark key={c.id} correction={c} />)
    cursor = idx + c.original.length
  }
  nodes.push(
    <React.Fragment key="tail">{turn.es.slice(cursor)}</React.Fragment>
  )
  return <>{nodes}</>
}

/**
 * A marked span: quiet category-tinted underline, click for the correction,
 * explanation only on request (conversation → correction → explanation).
 * Severity shapes the line — errors solid, softer findings dotted.
 */
function CorrectionMark({ correction }: { correction: Correction }) {
  const style = CATEGORY_STYLES[correction.category]
  return (
    <Popover>
      <PopoverTrigger
        className={cn(
          "cursor-pointer rounded-[3px] px-px align-baseline underline decoration-[1.5px] underline-offset-[5px] transition-colors",
          correction.severity !== "error" && "decoration-dotted",
          style.mark
        )}
      >
        {correction.original}
      </PopoverTrigger>
      <PopoverContent
        side="bottom"
        align="start"
        sideOffset={8}
        className="w-auto max-w-72 min-w-52 gap-0 p-3.5"
      >
        <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 text-sm">
          <span className="text-muted-foreground decoration-muted-foreground/40 line-through">
            {correction.original}
          </span>
          <span className="text-muted-foreground/50" aria-hidden>
            →
          </span>
          <span className={cn("font-medium", style.accent)}>
            {correction.replacement}
          </span>
        </div>
        <div className="text-muted-foreground/60 mt-1.5 text-[10px] tracking-[0.14em] uppercase">
          {CATEGORY_LABELS[correction.category]}
        </div>
        <ExplanationDisclosure text={correction.explanation} />
      </PopoverContent>
    </Popover>
  )
}

function ExplanationDisclosure({ text }: { text: string }) {
  const [open, setOpen] = React.useState(false)
  return open ? (
    <motion.p
      initial={{ opacity: 0, height: 0 }}
      animate={{ opacity: 1, height: "auto" }}
      transition={{ duration: 0.25 }}
      className="text-muted-foreground mt-2 overflow-hidden text-xs leading-relaxed"
    >
      {text}
    </motion.p>
  ) : (
    <button
      type="button"
      onClick={() => setOpen(true)}
      className="text-muted-foreground/70 hover:text-foreground mt-2 self-start text-xs transition-colors"
    >
      Why?
    </button>
  )
}

/* ----------------------------------------------------------------------------
 * Interim row — live transcription with lagging translation
 * ------------------------------------------------------------------------- */

function InterimRow({
  showEn,
  esCount,
  enWords,
  enCount,
  speaking,
}: {
  showEn: boolean
  esCount: number
  enWords: string[]
  enCount: number
  speaking: boolean
}) {
  return (
    <div className="flex items-baseline">
      <p className="text-foreground min-w-0 flex-1 text-lg leading-8 tracking-[-0.011em]">
        {INTERIM.esWords.slice(0, esCount).map((word, i) => (
          <motion.span
            key={i}
            initial={{ opacity: 0, y: 2, filter: "blur(3px)" }}
            animate={{ opacity: 1, y: 0, filter: "blur(0px)" }}
            transition={{ duration: 0.3 }}
            className="inline-block whitespace-pre"
          >
            {word}{" "}
          </motion.span>
        ))}
        {speaking && (
          <span
            aria-hidden
            className="bg-foreground/40 ml-0.5 inline-block h-[1.1em] w-px translate-y-[0.2em] animate-pulse"
          />
        )}
      </p>
      <EnCell showEn={showEn}>
        {enCount === 0 ? (
          esCount > 0 ? (
            <span className="text-muted-foreground/40 animate-pulse tracking-widest">
              ···
            </span>
          ) : null
        ) : (
          enWords.slice(0, enCount).map((word, i) => (
            <motion.span
              key={i}
              initial={{ opacity: 0, filter: "blur(3px)" }}
              animate={{ opacity: 1, filter: "blur(0px)" }}
              transition={{ duration: 0.55, ease: "easeOut" }}
              className="inline-block whitespace-pre"
            >
              {word}{" "}
            </motion.span>
          ))
        )}
      </EnCell>
    </div>
  )
}
