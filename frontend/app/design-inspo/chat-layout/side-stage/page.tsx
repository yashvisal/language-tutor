"use client"

/**
 * SIDE STAGE — design exploration variant.
 *
 * The pragmatic product layout: the conversation owns a centered main column;
 * voice presence (Aura), session facts, the tutor's running notes, and the
 * controls all live in a right rail. The rail collapses entirely so the
 * transcript can breathe full-width, with the Aura shrinking into a tiny
 * inline indicator in a floating control pill.
 *
 * Question under test: does concentrating coaching in a rail declutter the
 * conversation, or split attention?
 */

import * as React from "react"
import { AnimatePresence, motion } from "motion/react"
import {
  Languages,
  Mic,
  MicOff,
  PanelRightClose,
  PanelRightOpen,
  PhoneOff,
} from "lucide-react"
import type { AgentState } from "@livekit/components-react"

import { MockAura, DEMO_STATES } from "@/components/design/mock-aura"
import {
  CONVERSATION,
  INTERIM,
  CATEGORY_LABELS,
  type Correction,
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

/* ------------------------------------------------------------------ */
/* Correction category treatment — calm tints, never error-red.        */
/* ------------------------------------------------------------------ */

const CATEGORY_STYLES: Record<
  Correction["category"],
  { mark: string; dot: string; accent: string }
> = {
  tense: {
    mark: "decoration-amber-500/50 hover:decoration-amber-500 hover:bg-amber-500/10 data-[popup-open]:decoration-amber-500 data-[popup-open]:bg-amber-500/10",
    dot: "bg-amber-500",
    accent: "text-amber-600 dark:text-amber-400",
  },
  agreement: {
    mark: "decoration-violet-500/50 hover:decoration-violet-500 hover:bg-violet-500/10 data-[popup-open]:decoration-violet-500 data-[popup-open]:bg-violet-500/10",
    dot: "bg-violet-500",
    accent: "text-violet-600 dark:text-violet-400",
  },
  "word-order": {
    mark: "decoration-sky-500/50 hover:decoration-sky-500 hover:bg-sky-500/10 data-[popup-open]:decoration-sky-500 data-[popup-open]:bg-sky-500/10",
    dot: "bg-sky-500",
    accent: "text-sky-600 dark:text-sky-400",
  },
  vocabulary: {
    mark: "decoration-teal-500/50 hover:decoration-teal-500 hover:bg-teal-500/10 data-[popup-open]:decoration-teal-500 data-[popup-open]:bg-teal-500/10",
    dot: "bg-teal-500",
    accent: "text-teal-600 dark:text-teal-400",
  },
  naturalness: {
    mark: "decoration-fuchsia-500/50 hover:decoration-fuchsia-500 hover:bg-fuchsia-500/10 data-[popup-open]:decoration-fuchsia-500 data-[popup-open]:bg-fuchsia-500/10",
    dot: "bg-fuchsia-500",
    accent: "text-fuchsia-600 dark:text-fuchsia-400",
  },
}

/* ------------------------------------------------------------------ */
/* Inline correction mark: underline → popover → explanation on demand */
/* ------------------------------------------------------------------ */

function CorrectionMark({ correction }: { correction: Correction }) {
  const [showWhy, setShowWhy] = React.useState(false)
  const style = CATEGORY_STYLES[correction.category]

  return (
    <Popover
      onOpenChange={(open) => {
        if (!open) setShowWhy(false)
      }}
    >
      <PopoverTrigger
        nativeButton={false}
        render={
          <span
            className={cn(
              "cursor-pointer rounded-[3px] underline decoration-[1.5px] underline-offset-[5px] transition-colors duration-200",
              correction.severity === "error"
                ? "decoration-solid"
                : "decoration-dotted",
              style.mark
            )}
          />
        }
      >
        {correction.original}
      </PopoverTrigger>
      <PopoverContent className="w-auto min-w-52 max-w-72 gap-2 p-3.5">
        <div className="flex items-center gap-1.5 text-[10px] font-medium tracking-[0.12em] text-muted-foreground/70 uppercase">
          <span className={cn("size-1.5 rounded-full", style.dot)} />
          {CATEGORY_LABELS[correction.category]}
        </div>
        <div className="text-sm leading-relaxed">
          <span className="text-muted-foreground/70 line-through decoration-muted-foreground/40">
            {correction.original}
          </span>
          <span className="mx-2 text-muted-foreground/50">→</span>
          <span className={cn("font-medium", style.accent)}>
            {correction.replacement}
          </span>
        </div>
        {showWhy ? (
          <motion.p
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: "auto" }}
            className="overflow-hidden text-xs leading-relaxed text-muted-foreground"
          >
            {correction.explanation}
          </motion.p>
        ) : (
          <button
            type="button"
            onClick={() => setShowWhy(true)}
            className="w-fit text-xs text-muted-foreground/60 transition-colors hover:text-foreground"
          >
            Why?
          </button>
        )}
      </PopoverContent>
    </Popover>
  )
}

/** Splits a turn's Spanish text around its correction spans. */
function renderCorrectedText(turn: Turn): React.ReactNode {
  const { es, corrections } = turn
  if (!corrections?.length) return es

  const spans = corrections
    .map((c) => ({ c, start: es.indexOf(c.original) }))
    .filter((s) => s.start >= 0)
    .sort((a, b) => a.start - b.start)

  const nodes: React.ReactNode[] = []
  let cursor = 0
  for (const { c, start } of spans) {
    if (start > cursor) nodes.push(es.slice(cursor, start))
    nodes.push(<CorrectionMark key={c.id} correction={c} />)
    cursor = start + c.original.length
  }
  if (cursor < es.length) nodes.push(es.slice(cursor))
  return nodes
}

/* ------------------------------------------------------------------ */
/* Transcript turns                                                    */
/* ------------------------------------------------------------------ */

function TurnBlock({
  turn,
  showTranslation,
  highlighted,
  innerRef,
}: {
  turn: Turn
  showTranslation: boolean
  highlighted: boolean
  innerRef: (el: HTMLDivElement | null) => void
}) {
  const isLearner = turn.speaker === "learner"
  return (
    <div
      ref={innerRef}
      className={cn(
        "group -mx-4 rounded-lg px-4 py-3 transition-colors duration-700",
        highlighted && "bg-primary/[0.06] duration-200"
      )}
    >
      <div
        className={cn(
          "mb-1.5 text-[10px] font-medium tracking-[0.16em] uppercase",
          isLearner ? "text-muted-foreground/70" : "text-primary/60"
        )}
      >
        {isLearner ? "You" : "Tutor"}
      </div>
      <p
        className={cn(
          "text-[17px] leading-[1.7]",
          isLearner ? "text-foreground" : "text-foreground/75"
        )}
      >
        {renderCorrectedText(turn)}
      </p>
      <div
        className={cn(
          "grid grid-rows-[0fr] opacity-0 transition-all duration-300 group-hover:grid-rows-[1fr] group-hover:opacity-100",
          showTranslation && "grid-rows-[1fr] opacity-100"
        )}
      >
        <div className="overflow-hidden">
          <p className="pt-1.5 text-sm leading-relaxed text-muted-foreground">
            {turn.en}
          </p>
        </div>
      </div>
    </div>
  )
}

function InterimBlock({
  visibleWords,
  showTranslation,
}: {
  visibleWords: number
  showTranslation: boolean
}) {
  return (
    <div className="group -mx-4 rounded-lg px-4 py-3">
      <div className="mb-1.5 flex items-center gap-1.5 text-[10px] font-medium tracking-[0.16em] text-muted-foreground/70 uppercase">
        You
        <span className="size-1 animate-pulse rounded-full bg-primary/70" />
      </div>
      <p className="min-h-[1.7em] text-[17px] leading-[1.7] text-foreground">
        {INTERIM.esWords.slice(0, visibleWords).map((word, i) => (
          <motion.span
            key={i}
            initial={{ opacity: 0, y: 3 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.25, ease: "easeOut" }}
          >
            {i > 0 ? " " : ""}
            {word}
          </motion.span>
        ))}
        <span className="ml-1 inline-block h-[1.05em] w-px translate-y-[0.18em] animate-pulse bg-foreground/60" />
      </p>
      <div
        className={cn(
          "grid grid-rows-[0fr] opacity-0 transition-all duration-300 group-hover:grid-rows-[1fr] group-hover:opacity-100",
          showTranslation && visibleWords > 2 && "grid-rows-[1fr] opacity-100"
        )}
      >
        <div className="overflow-hidden">
          <p className="pt-1.5 text-sm leading-relaxed text-muted-foreground/70 italic">
            {INTERIM.enPartial}
          </p>
        </div>
      </div>
    </div>
  )
}

/* ------------------------------------------------------------------ */
/* Rail pieces                                                         */
/* ------------------------------------------------------------------ */

interface NoteEntry {
  turnId: string
  correction: Correction
}

function NotesList({
  notes,
  expandedId,
  onSelect,
}: {
  notes: NoteEntry[]
  expandedId: string | null
  onSelect: (note: NoteEntry) => void
}) {
  return (
    <ul className="flex flex-col">
      {notes.map((note, i) => {
        const { correction: c } = note
        const style = CATEGORY_STYLES[c.category]
        const expanded = expandedId === c.id
        return (
          <motion.li
            key={c.id}
            initial={{ opacity: 0, y: 4 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.3, delay: i * 0.05 }}
          >
            <button
              type="button"
              onClick={() => onSelect(note)}
              className="-mx-2 w-[calc(100%+1rem)] rounded-md px-2 py-2.5 text-left transition-colors hover:bg-muted/50"
            >
              <div className="text-[13px] leading-relaxed">
                <span className="text-muted-foreground/70 line-through decoration-muted-foreground/40">
                  {c.original}
                </span>
                <span className="mx-1.5 text-muted-foreground/50">→</span>
                <span className={cn("font-medium", style.accent)}>
                  {c.replacement}
                </span>
              </div>
              <div className="mt-1 flex items-center gap-1.5 text-[10px] font-medium tracking-[0.12em] text-muted-foreground/60 uppercase">
                <span className={cn("size-1 rounded-full", style.dot)} />
                {CATEGORY_LABELS[c.category]}
              </div>
              <AnimatePresence initial={false}>
                {expanded && (
                  <motion.p
                    initial={{ opacity: 0, height: 0 }}
                    animate={{ opacity: 1, height: "auto" }}
                    exit={{ opacity: 0, height: 0 }}
                    transition={{ duration: 0.2 }}
                    className="overflow-hidden text-xs leading-relaxed text-muted-foreground"
                  >
                    <span className="block pt-1.5">{c.explanation}</span>
                  </motion.p>
                )}
              </AnimatePresence>
            </button>
          </motion.li>
        )
      })}
    </ul>
  )
}

function ControlButton({
  label,
  onClick,
  active,
  className,
  children,
}: {
  label: string
  onClick?: () => void
  active?: boolean
  className?: string
  children: React.ReactNode
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={onClick}
            className={cn(
              "text-muted-foreground hover:text-foreground",
              active && "bg-primary/10 text-primary hover:bg-primary/15 hover:text-primary",
              className
            )}
          />
        }
      >
        {children}
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  )
}

/* ------------------------------------------------------------------ */
/* Page                                                                */
/* ------------------------------------------------------------------ */

const RAIL_WIDTH = 336

export default function SideStagePage() {
  const [auraState, setAuraState] = React.useState<AgentState>("listening")
  const [railOpen, setRailOpen] = React.useState(true)
  const [translationsOn, setTranslationsOn] = React.useState(false)
  const [micMuted, setMicMuted] = React.useState(false)
  const [expandedNoteId, setExpandedNoteId] = React.useState<string | null>(null)
  const [highlightedTurnId, setHighlightedTurnId] = React.useState<string | null>(null)

  // Interim utterance: words arrive progressively, hold, then replay.
  const [tick, setTick] = React.useState(1)
  const totalWords = INTERIM.esWords.length
  const visibleWords = Math.min(tick, totalWords)
  React.useEffect(() => {
    const id = setInterval(() => {
      setTick((n) => (n >= totalWords + 6 ? 1 : n + 1))
    }, 420)
    return () => clearInterval(id)
  }, [totalWords])

  // Session clock.
  const [elapsed, setElapsed] = React.useState(0)
  React.useEffect(() => {
    const id = setInterval(() => setElapsed((s) => s + 1), 1000)
    return () => clearInterval(id)
  }, [])
  const clock = `${Math.floor(elapsed / 60)}:${String(elapsed % 60).padStart(2, "0")}`

  // Transcript scrolling.
  const scrollRef = React.useRef<HTMLDivElement | null>(null)
  const turnRefs = React.useRef<Record<string, HTMLDivElement | null>>({})
  const highlightTimer = React.useRef<ReturnType<typeof setTimeout> | null>(null)

  React.useEffect(() => {
    const el = scrollRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [])

  React.useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 160
    if (nearBottom) el.scrollTop = el.scrollHeight
  }, [visibleWords])

  const notes = React.useMemo<NoteEntry[]>(
    () =>
      CONVERSATION.filter((t) => t.speaker === "learner").flatMap((t) =>
        (t.corrections ?? []).map((correction) => ({ turnId: t.id, correction }))
      ),
    []
  )

  const selectNote = (note: NoteEntry) => {
    setExpandedNoteId((id) => (id === note.correction.id ? null : note.correction.id))
    turnRefs.current[note.turnId]?.scrollIntoView({
      behavior: "smooth",
      block: "center",
    })
    setHighlightedTurnId(note.turnId)
    if (highlightTimer.current) clearTimeout(highlightTimer.current)
    highlightTimer.current = setTimeout(() => setHighlightedTurnId(null), 1600)
  }

  const cycleAuraState = () => {
    setAuraState(
      (s) => DEMO_STATES[(DEMO_STATES.indexOf(s) + 1) % DEMO_STATES.length]
    )
  }

  const controls = (
    <>
      <ControlButton
        label={micMuted ? "Unmute" : "Mute"}
        onClick={() => setMicMuted((m) => !m)}
        active={micMuted}
      >
        {micMuted ? <MicOff /> : <Mic />}
      </ControlButton>
      <ControlButton
        label={translationsOn ? "Hide translations" : "Show translations"}
        onClick={() => setTranslationsOn((t) => !t)}
        active={translationsOn}
      >
        <Languages />
      </ControlButton>
      <ControlButton
        label="End session"
        className="hover:bg-destructive/10 hover:text-destructive"
      >
        <PhoneOff />
      </ControlButton>
    </>
  )

  return (
    <div className="flex h-full overflow-hidden">
      {/* ------------------------------------------------ main column */}
      <div className="relative flex min-w-0 flex-1 flex-col">
        <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto">
          <div className="mx-auto w-full max-w-2xl px-8 pt-12 pb-28">
            <div className="flex flex-col gap-3">
              {CONVERSATION.map((turn) => (
                <TurnBlock
                  key={turn.id}
                  turn={turn}
                  showTranslation={translationsOn}
                  highlighted={highlightedTurnId === turn.id}
                  innerRef={(el) => {
                    turnRefs.current[turn.id] = el
                  }}
                />
              ))}
              <InterimBlock
                visibleWords={visibleWords}
                showTranslation={translationsOn}
              />
            </div>
          </div>
        </div>

        {/* dev-only aura state cycler */}
        <button
          type="button"
          onClick={cycleAuraState}
          className="absolute bottom-3 left-4 z-10 font-mono text-[10px] text-muted-foreground/40 transition-colors hover:text-muted-foreground"
        >
          state: {auraState}
        </button>

        {/* floating controls when the rail is collapsed */}
        <AnimatePresence initial={false}>
          {!railOpen && (
            <motion.div
              key="pill"
              initial={{ opacity: 0, y: 12 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: 12 }}
              transition={{ duration: 0.25, ease: "easeOut" }}
              className="absolute bottom-4 left-1/2 z-10 flex -translate-x-1/2 items-center gap-1 rounded-full border bg-background/85 py-1.5 pr-1.5 pl-2 shadow-sm backdrop-blur"
            >
              <div className="mr-0.5 flex size-6 items-center justify-center">
                <MockAura state={auraState} size="icon" />
              </div>
              {controls}
              <ControlButton label="Show session rail" onClick={() => setRailOpen(true)}>
                <PanelRightOpen />
              </ControlButton>
            </motion.div>
          )}
        </AnimatePresence>
      </div>

      {/* ------------------------------------------------- right rail */}
      <AnimatePresence initial={false}>
        {railOpen && (
          <motion.aside
            key="rail"
            initial={{ width: 0, opacity: 0 }}
            animate={{ width: RAIL_WIDTH, opacity: 1 }}
            exit={{ width: 0, opacity: 0 }}
            transition={{ type: "spring", bounce: 0, duration: 0.45 }}
            className="relative shrink-0 overflow-hidden border-l"
          >
            <div
              className="flex h-full flex-col"
              style={{ width: RAIL_WIDTH }}
            >
              {/* collapse toggle */}
              <div className="absolute top-2.5 right-2.5 z-10">
                <ControlButton
                  label="Hide session rail"
                  onClick={() => setRailOpen(false)}
                >
                  <PanelRightClose />
                </ControlButton>
              </div>

              {/* aura + state */}
              <div className="flex flex-col items-center pt-10 pb-2">
                <MockAura state={auraState} size="md" />
                <AnimatePresence mode="wait" initial={false}>
                  <motion.span
                    key={auraState}
                    initial={{ opacity: 0, y: 3 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={{ opacity: 0, y: -3 }}
                    transition={{ duration: 0.18 }}
                    className="mt-4 text-xs text-muted-foreground"
                  >
                    {auraState}
                  </motion.span>
                </AnimatePresence>
              </div>

              {/* session strip */}
              <div className="flex items-baseline justify-center gap-3 py-4 text-xs text-muted-foreground tabular-nums">
                <span>{clock} elapsed</span>
                <span className="text-muted-foreground/40">·</span>
                <span>{CONVERSATION.length} turns</span>
              </div>

              {/* notes */}
              <div className="min-h-0 flex-1 overflow-y-auto px-5 pt-4 pb-4">
                <div className="mb-2 text-[10px] font-medium tracking-[0.16em] text-muted-foreground/60 uppercase">
                  Notes
                </div>
                <NotesList
                  notes={notes}
                  expandedId={expandedNoteId}
                  onSelect={selectNote}
                />
              </div>

              {/* controls */}
              <div className="flex shrink-0 items-center justify-center gap-1.5 border-t px-4 py-3">
                {controls}
              </div>
            </div>
          </motion.aside>
        )}
      </AnimatePresence>
    </div>
  )
}
