"use client"

/**
 * TEXT FIRST — chat-layout variant.
 *
 * Hypothesis: the product needs no orb. Typography does all the work — the
 * transcript reads like a beautifully typeset live document. System state is a
 * tiny pulsing dot + lowercase word. Corrections live in the right margin as
 * editorial annotations tied to calm, category-tinted underlines in the text.
 *
 * Choreography on mount: turns t1–t7 settle in → the last learner turn streams
 * word-by-word (interim) → settles (interim → final color shift) → its marks
 * and margin notes fade in a beat later → the tutor replies → a new interim
 * utterance streams and stays live with a caret.
 */

import * as React from "react"
import { AnimatePresence, motion, type Transition } from "motion/react"
import { Languages, Mic, MicOff, PhoneOff, RotateCcw } from "lucide-react"

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
import {
  CATEGORY_LABELS,
  CONVERSATION,
  INTERIM,
  type Correction,
  type CorrectionCategory,
  type Turn,
} from "@/lib/design/mock-conversation"

/* ------------------------------------------------------------------ */
/* Category treatments — calm, distinct. Correction color is the one   */
/* place the surface gets expressive; never error-red.                 */
/* ------------------------------------------------------------------ */

const CATEGORY_STYLES: Record<
  CorrectionCategory,
  { text: string; underline: string; tint: string; borderStyle: string }
> = {
  tense: {
    text: "text-[oklch(0.53_0.11_65)] dark:text-[oklch(0.8_0.1_78)]",
    underline:
      "border-[oklch(0.53_0.11_65)]/60 dark:border-[oklch(0.8_0.1_78)]/60",
    tint: "bg-[oklch(0.53_0.11_65)]/10 dark:bg-[oklch(0.8_0.1_78)]/15",
    borderStyle: "border-solid",
  },
  agreement: {
    text: "text-[oklch(0.5_0.09_190)] dark:text-[oklch(0.78_0.09_190)]",
    underline:
      "border-[oklch(0.5_0.09_190)]/60 dark:border-[oklch(0.78_0.09_190)]/60",
    tint: "bg-[oklch(0.5_0.09_190)]/10 dark:bg-[oklch(0.78_0.09_190)]/15",
    borderStyle: "border-solid",
  },
  "word-order": {
    text: "text-[oklch(0.54_0.11_300)] dark:text-[oklch(0.78_0.1_300)]",
    underline:
      "border-[oklch(0.54_0.11_300)]/60 dark:border-[oklch(0.78_0.1_300)]/60",
    tint: "bg-[oklch(0.54_0.11_300)]/10 dark:bg-[oklch(0.78_0.1_300)]/15",
    borderStyle: "border-dashed",
  },
  vocabulary: {
    text: "text-[oklch(0.52_0.11_255)] dark:text-[oklch(0.76_0.09_250)]",
    underline:
      "border-[oklch(0.52_0.11_255)]/60 dark:border-[oklch(0.76_0.09_250)]/60",
    tint: "bg-[oklch(0.52_0.11_255)]/10 dark:bg-[oklch(0.76_0.09_250)]/15",
    borderStyle: "border-dotted",
  },
  naturalness: {
    text: "text-[oklch(0.55_0.1_155)] dark:text-[oklch(0.78_0.1_155)]",
    underline:
      "border-[oklch(0.55_0.1_155)]/60 dark:border-[oklch(0.78_0.1_155)]/60",
    tint: "bg-[oklch(0.55_0.1_155)]/10 dark:bg-[oklch(0.78_0.1_155)]/15",
    borderStyle: "border-dotted",
  },
}

/* ------------------------------------------------------------------ */
/* Conversation staging                                                */
/* ------------------------------------------------------------------ */

const SETTLED_TURNS = CONVERSATION.slice(0, CONVERSATION.length - 2)
const STAGED_TURN = CONVERSATION[CONVERSATION.length - 2]! // last learner turn
const REPLY_TURN = CONVERSATION[CONVERSATION.length - 1]! // tutor reply
const STAGED_WORDS = STAGED_TURN.es.split(" ")
const REPLY_WORDS = REPLY_TURN.es.split(" ")

type Stage =
  | "entering"
  | "stream-turn"
  | "settle"
  | "mark"
  | "reply"
  | "interim"
  | "live"

const STAGE_INDEX: Record<Stage, number> = {
  entering: 0,
  "stream-turn": 1,
  settle: 2,
  mark: 3,
  reply: 4,
  interim: 5,
  live: 6,
}

type ConvState = "idle" | "connecting" | "listening" | "thinking" | "speaking"

const STATE_WORDS: Record<ConvState, string> = {
  idle: "idle",
  connecting: "connecting…",
  listening: "listening…",
  thinking: "thinking…",
  speaking: "speaking",
}

const STATE_CYCLE: (ConvState | null)[] = [
  null,
  "idle",
  "connecting",
  "listening",
  "thinking",
  "speaking",
]

/* ------------------------------------------------------------------ */
/* The typographic state indicator — this tiny element carries         */
/* everything the orb would.                                           */
/* ------------------------------------------------------------------ */

const DOT_ANIM: Record<
  ConvState,
  { animate: Record<string, number | number[]>; transition: Transition }
> = {
  idle: {
    animate: { scale: 1, opacity: 0.35 },
    transition: { duration: 0.5 },
  },
  connecting: {
    animate: { scale: 1, opacity: [0.2, 0.85, 0.2] },
    transition: { duration: 1.7, repeat: Infinity, ease: "easeInOut" },
  },
  listening: {
    // slow breathing — attentive, unhurried
    animate: { scale: [1, 1.3, 1], opacity: [0.65, 1, 0.65] },
    transition: { duration: 2.4, repeat: Infinity, ease: "easeInOut" },
  },
  thinking: {
    // quicker, inward contraction
    animate: { scale: [1, 0.6, 1], opacity: [0.95, 0.4, 0.95] },
    transition: { duration: 0.95, repeat: Infinity, ease: "easeInOut" },
  },
  speaking: {
    // irregular amplitude, like a voice
    animate: { scale: [1, 1.55, 1.1, 1.7, 1, 1.4, 1], opacity: 1 },
    transition: { duration: 1.4, repeat: Infinity, ease: "easeInOut" },
  },
}

function StateIndicator({ state }: { state: ConvState }) {
  const dot = DOT_ANIM[state]
  return (
    <div className="flex items-center gap-2.5 rounded-full bg-background/70 py-1.5 pr-4 pl-3.5 backdrop-blur-sm">
      <span className="relative flex size-1.5 items-center justify-center">
        {state === "listening" && (
          <motion.span
            className="absolute size-full rounded-full bg-primary/50"
            animate={{ scale: [1, 3], opacity: [0.45, 0] }}
            transition={{ duration: 2.4, repeat: Infinity, ease: "easeOut" }}
          />
        )}
        <motion.span
          className={cn(
            "size-1.5 rounded-full",
            state === "idle" ? "bg-muted-foreground" : "bg-primary"
          )}
          animate={dot.animate}
          transition={dot.transition}
        />
      </span>
      <span className="relative h-4 w-20">
        <AnimatePresence mode="wait" initial={false}>
          <motion.span
            key={state}
            className="absolute left-0 text-xs lowercase tracking-wide whitespace-nowrap text-muted-foreground"
            initial={{ opacity: 0, y: 4, filter: "blur(2px)" }}
            animate={{ opacity: 1, y: 0, filter: "blur(0px)" }}
            exit={{ opacity: 0, y: -4, filter: "blur(2px)" }}
            transition={{ duration: 0.25, ease: "easeOut" }}
          >
            {STATE_WORDS[state]}
          </motion.span>
        </AnimatePresence>
      </span>
    </div>
  )
}

/* ------------------------------------------------------------------ */
/* Text primitives                                                     */
/* ------------------------------------------------------------------ */

function Caret() {
  return (
    <motion.span
      className="ml-0.5 inline-block h-[1.1em] w-px translate-y-[0.18em] bg-foreground/60"
      animate={{ opacity: [1, 1, 0, 0] }}
      transition={{ duration: 1.1, repeat: Infinity, times: [0, 0.5, 0.55, 1] }}
    />
  )
}

function StreamedWords({ words, count }: { words: string[]; count: number }) {
  return (
    <>
      {words.slice(0, count).map((word, i) => (
        <React.Fragment key={i}>
          <motion.span
            className="inline-block"
            initial={{ opacity: 0, y: 5, filter: "blur(4px)" }}
            animate={{ opacity: 1, y: 0, filter: "blur(0px)" }}
            transition={{ duration: 0.32, ease: "easeOut" }}
          >
            {word}
          </motion.span>{" "}
        </React.Fragment>
      ))}
    </>
  )
}

/* ------------------------------------------------------------------ */
/* Corrections: inline mark (underline + popover) + margin annotation  */
/* ------------------------------------------------------------------ */

type Segment =
  | { type: "text"; value: string }
  | { type: "mark"; correction: Correction }

function segmentTurn(turn: Turn): Segment[] {
  const located = (turn.corrections ?? [])
    .map((c) => ({ c, index: turn.es.indexOf(c.original) }))
    .filter((x) => x.index >= 0)
    .sort((a, b) => a.index - b.index)
  const segments: Segment[] = []
  let cursor = 0
  for (const { c, index } of located) {
    if (index > cursor)
      segments.push({ type: "text", value: turn.es.slice(cursor, index) })
    segments.push({ type: "mark", correction: c })
    cursor = index + c.original.length
  }
  if (cursor < turn.es.length)
    segments.push({ type: "text", value: turn.es.slice(cursor) })
  return segments
}

function CorrectionMark({
  correction,
  marked,
  linked,
  onLink,
}: {
  correction: Correction
  marked: boolean
  linked: boolean
  onLink: (id: string | null) => void
}) {
  const style = CATEGORY_STYLES[correction.category]
  return (
    <Popover>
      <PopoverTrigger
        render={<span tabIndex={0} />}
        nativeButton={false}
        openOnHover
        delay={280}
        className={cn(
          "cursor-pointer rounded-[2px] border-b-[1.5px] pb-px outline-none transition-colors duration-500 focus-visible:ring-2 focus-visible:ring-ring/40",
          style.borderStyle,
          marked ? style.underline : "border-transparent",
          linked && style.tint
        )}
        onMouseEnter={() => onLink(correction.id)}
        onMouseLeave={() => onLink(null)}
      >
        {correction.original}
      </PopoverTrigger>
      <PopoverContent side="top" sideOffset={10} className="w-64 gap-2 p-3.5">
        <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 text-sm">
          <span className="text-muted-foreground/70 line-through decoration-muted-foreground/40">
            {correction.original}
          </span>
          <span className="text-muted-foreground/40">→</span>
          <span className={cn("font-medium", style.text)}>
            {correction.replacement}
          </span>
        </div>
        <p className="text-xs leading-relaxed text-muted-foreground">
          {correction.explanation}
        </p>
        <div className="text-[10px] tracking-[0.16em] text-muted-foreground/60 uppercase">
          {CATEGORY_LABELS[correction.category]}
        </div>
      </PopoverContent>
    </Popover>
  )
}

function MarginNote({
  correction,
  visible,
  linked,
  onLink,
}: {
  correction: Correction
  visible: boolean
  linked: boolean
  onLink: (id: string | null) => void
}) {
  const [expanded, setExpanded] = React.useState(false)
  const style = CATEGORY_STYLES[correction.category]
  return (
    <motion.div
      initial={false}
      animate={{ opacity: visible ? 1 : 0, x: visible ? 0 : -8 }}
      transition={{ duration: 0.5, ease: "easeOut" }}
      className={cn(
        "cursor-pointer select-none",
        !visible && "pointer-events-none"
      )}
      onMouseEnter={() => {
        onLink(correction.id)
        setExpanded(true)
      }}
      onMouseLeave={() => {
        onLink(null)
        setExpanded(false)
      }}
      onClick={() => setExpanded((v) => !v)}
    >
      <div className="flex flex-wrap items-baseline gap-x-1.5 text-xs leading-relaxed">
        <span
          className={cn(
            "line-through decoration-muted-foreground/40 transition-colors duration-200",
            linked ? "text-muted-foreground" : "text-muted-foreground/60"
          )}
        >
          {correction.original}
        </span>
        <span className="text-muted-foreground/40">→</span>
        <span className={cn("font-medium", style.text)}>
          {correction.replacement}
        </span>
      </div>
      <div className="mt-0.5 text-[9px] tracking-[0.18em] text-muted-foreground/50 uppercase">
        {CATEGORY_LABELS[correction.category]}
      </div>
      <motion.div
        initial={false}
        animate={{
          height: expanded ? "auto" : 0,
          opacity: expanded ? 1 : 0,
        }}
        transition={{ duration: 0.25, ease: "easeOut" }}
        className="overflow-hidden"
      >
        <p className="pt-1.5 text-[11px] leading-relaxed text-muted-foreground">
          {correction.explanation}
        </p>
      </motion.div>
    </motion.div>
  )
}

/* ------------------------------------------------------------------ */
/* A turn: label, Spanish text, per-turn translation, margin notes.    */
/* Speakers are distinguished typographically only — no bubbles.       */
/* ------------------------------------------------------------------ */

type TurnPhase = "streaming" | "settled" | "marked"

function TurnBlock({
  turn,
  phase,
  visibleWords = Infinity,
  caret = false,
  showEnGlobal,
}: {
  turn: Turn
  phase: TurnPhase
  visibleWords?: number
  caret?: boolean
  showEnGlobal: boolean
}) {
  const [showEn, setShowEn] = React.useState(false)
  const [linkedId, setLinkedId] = React.useState<string | null>(null)
  const isLearner = turn.speaker === "learner"
  const streaming = phase === "streaming"
  const marked = phase === "marked"
  const segments = React.useMemo(() => segmentTurn(turn), [turn])
  const corrections = turn.corrections ?? []
  const words = React.useMemo(() => turn.es.split(" "), [turn])
  const enShown = !streaming && (showEnGlobal || showEn)

  return (
    <section className="group xl:grid xl:grid-cols-[minmax(0,42rem)_14rem] xl:gap-10">
      <div>
        <div className="mb-2.5 text-[10px] font-medium tracking-[0.22em] text-muted-foreground/50 uppercase">
          {isLearner ? "you" : "tutor"}
        </div>
        <p
          className={cn(
            "transition-colors duration-700",
            isLearner
              ? "text-[1.375rem] leading-[1.65] tracking-[-0.01em]"
              : "text-[1.1875rem] leading-[1.7] text-muted-foreground",
            isLearner && (streaming ? "text-muted-foreground/80" : "text-foreground")
          )}
        >
          {streaming ? (
            <StreamedWords words={words} count={visibleWords} />
          ) : (
            segments.map((seg, i) =>
              seg.type === "text" ? (
                <React.Fragment key={i}>{seg.value}</React.Fragment>
              ) : (
                <CorrectionMark
                  key={seg.correction.id}
                  correction={seg.correction}
                  marked={marked}
                  linked={linkedId === seg.correction.id}
                  onLink={setLinkedId}
                />
              )
            )
          )}
          {streaming && caret && <Caret />}
          {!streaming && !showEnGlobal && (
            <button
              type="button"
              onClick={() => setShowEn((v) => !v)}
              className={cn(
                "ml-2 align-super text-[10px] font-medium tracking-widest lowercase outline-none transition-opacity duration-200 focus-visible:opacity-100",
                showEn
                  ? "text-muted-foreground opacity-100"
                  : "text-muted-foreground/60 opacity-0 group-hover:opacity-100"
              )}
            >
              en
            </button>
          )}
        </p>
        <AnimatePresence initial={false}>
          {enShown && (
            <motion.div
              key="en"
              initial={{ height: 0, opacity: 0 }}
              animate={{ height: "auto", opacity: 1 }}
              exit={{ height: 0, opacity: 0 }}
              transition={{ duration: 0.3, ease: "easeOut" }}
              className="overflow-hidden"
            >
              <p className="pt-2 text-sm leading-relaxed text-muted-foreground/80 italic">
                {turn.en}
              </p>
            </motion.div>
          )}
        </AnimatePresence>
      </div>
      {isLearner && corrections.length > 0 && (
        <aside className="hidden xl:block">
          <div className="flex flex-col gap-5 border-l border-border/60 pt-6 pl-5">
            {corrections.map((c) => (
              <MarginNote
                key={c.id}
                correction={c}
                visible={marked}
                linked={linkedId === c.id}
                onLink={setLinkedId}
              />
            ))}
          </div>
        </aside>
      )}
    </section>
  )
}

/* The perpetually in-progress utterance at the bottom. */
function InterimBlock({
  count,
  showEn,
}: {
  count: number
  showEn: boolean
}) {
  return (
    <section className="xl:grid xl:grid-cols-[minmax(0,42rem)_14rem] xl:gap-10">
      <div>
        <div className="mb-2.5 text-[10px] font-medium tracking-[0.22em] text-muted-foreground/50 uppercase">
          you
        </div>
        <p className="text-[1.375rem] leading-[1.65] tracking-[-0.01em] text-muted-foreground/80">
          <StreamedWords words={INTERIM.esWords} count={count} />
          <Caret />
        </p>
        {showEn && count > 2 && (
          <motion.p
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ duration: 0.4 }}
            className="pt-2 text-sm leading-relaxed text-muted-foreground/60 italic"
          >
            {INTERIM.enPartial}
          </motion.p>
        )}
      </div>
    </section>
  )
}

/* ------------------------------------------------------------------ */
/* Page                                                                */
/* ------------------------------------------------------------------ */

export default function TextFirstPage() {
  const [stage, setStage] = React.useState<Stage>("entering")
  const [w8, setW8] = React.useState(0)
  const [w9, setW9] = React.useState(0)
  const [wi, setWi] = React.useState(0)
  const [override, setOverride] = React.useState<ConvState | null>(null)
  const [showAllEn, setShowAllEn] = React.useState(false)
  const [micOn, setMicOn] = React.useState(true)
  const scrollRef = React.useRef<HTMLDivElement>(null)
  const firstScroll = React.useRef(true)

  const at = STAGE_INDEX[stage]

  /* Choreography: interim → final → marked is the signature motion. */
  React.useEffect(() => {
    let t: ReturnType<typeof setTimeout> | undefined
    switch (stage) {
      case "entering":
        t = setTimeout(() => setStage("stream-turn"), 1200)
        break
      case "stream-turn":
        if (w8 < STAGED_WORDS.length)
          t = setTimeout(() => setW8((n) => n + 1), 230)
        else t = setTimeout(() => setStage("settle"), 480)
        break
      case "settle":
        t = setTimeout(() => setStage("mark"), 950)
        break
      case "mark":
        t = setTimeout(() => setStage("reply"), 1050)
        break
      case "reply":
        if (w9 < REPLY_WORDS.length)
          t = setTimeout(() => setW9((n) => n + 1), 150)
        else t = setTimeout(() => setStage("interim"), 750)
        break
      case "interim":
        if (wi < INTERIM.esWords.length)
          t = setTimeout(() => setWi((n) => n + 1), 360)
        else t = setTimeout(() => setStage("live"), 400)
        break
      case "live":
        break
    }
    return () => {
      if (t) clearTimeout(t)
    }
  }, [stage, w8, w9, wi])

  /* Keep the latest line in view while the conversation moves. */
  React.useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    el.scrollTo({
      top: el.scrollHeight,
      behavior: firstScroll.current ? "auto" : "smooth",
    })
    firstScroll.current = false
  }, [stage, w8, w9, wi])

  const autoState: ConvState =
    stage === "entering"
      ? "connecting"
      : stage === "stream-turn"
        ? "listening"
        : stage === "settle" || stage === "mark"
          ? "thinking"
          : stage === "reply"
            ? "speaking"
            : "listening"
  const state = override ?? (micOn ? autoState : "idle")

  const stagedPhase: TurnPhase =
    stage === "stream-turn" ? "streaming" : stage === "settle" ? "settled" : "marked"

  const cycleState = () => {
    const i = STATE_CYCLE.indexOf(override)
    setOverride(STATE_CYCLE[(i + 1) % STATE_CYCLE.length] ?? null)
  }

  const replay = () => {
    setStage("entering")
    setW8(0)
    setW9(0)
    setWi(0)
  }

  return (
    <div className="relative flex h-full flex-col overflow-hidden">
      {/* State indicator — the whole orb, in twelve pixels. */}
      <div className="pointer-events-none absolute inset-x-0 top-4 z-20 flex justify-center">
        <StateIndicator state={state} />
      </div>
      {/* Soft fade so text scrolls quietly beneath the indicator. */}
      <div className="pointer-events-none absolute inset-x-0 top-0 z-10 h-16 bg-linear-to-b from-background to-transparent" />

      {/* Dev corner: cycle states, replay the choreography. */}
      <div className="absolute top-3 right-4 z-30 flex items-center gap-1.5">
        <button
          type="button"
          onClick={cycleState}
          className="rounded-full border border-border/60 bg-background/70 px-2.5 py-1 font-mono text-[10px] text-muted-foreground/70 backdrop-blur-sm transition-colors hover:text-foreground"
        >
          state: {override ?? "auto"}
        </button>
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                variant="ghost"
                size="icon-sm"
                onClick={replay}
                className="rounded-full text-muted-foreground/70"
              >
                <RotateCcw />
              </Button>
            }
          />
          <TooltipContent>replay choreography</TooltipContent>
        </Tooltip>
      </div>

      {/* The transcript is the interface. */}
      <div
        ref={scrollRef}
        className="min-h-0 flex-1 overflow-x-hidden overflow-y-auto"
      >
        <div className="mx-auto w-full max-w-2xl px-6 pt-24 pb-48 xl:max-w-[62rem]">
          <div className="flex flex-col gap-12">
            {SETTLED_TURNS.map((turn, i) => (
              <motion.div
                key={turn.id}
                initial={{ opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{
                  delay: 0.1 + i * 0.06,
                  duration: 0.5,
                  ease: "easeOut",
                }}
              >
                <TurnBlock
                  turn={turn}
                  phase="marked"
                  showEnGlobal={showAllEn}
                />
              </motion.div>
            ))}

            {at >= STAGE_INDEX["stream-turn"] && (
              <TurnBlock
                turn={STAGED_TURN}
                phase={stagedPhase}
                visibleWords={w8}
                caret
                showEnGlobal={showAllEn}
              />
            )}

            {at >= STAGE_INDEX.reply && (
              <TurnBlock
                turn={REPLY_TURN}
                phase={stage === "reply" ? "streaming" : "settled"}
                visibleWords={w9}
                caret
                showEnGlobal={showAllEn}
              />
            )}

            {at >= STAGE_INDEX.interim && (
              <InterimBlock count={wi} showEn={showAllEn} />
            )}
          </div>
        </div>
      </div>

      {/* Minimal controls. */}
      <div className="pointer-events-none absolute inset-x-0 bottom-0 z-20 flex justify-center bg-linear-to-t from-background via-background/85 to-transparent pt-16 pb-7">
        <div className="pointer-events-auto flex items-center gap-2">
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  variant="ghost"
                  size="icon-lg"
                  onClick={() => setMicOn((v) => !v)}
                  className={cn(
                    "rounded-full",
                    micOn
                      ? "text-muted-foreground hover:text-foreground"
                      : "bg-muted text-foreground"
                  )}
                >
                  {micOn ? <Mic /> : <MicOff />}
                </Button>
              }
            />
            <TooltipContent>{micOn ? "mute" : "unmute"}</TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  variant="ghost"
                  size="icon-lg"
                  onClick={() => setShowAllEn((v) => !v)}
                  className={cn(
                    "rounded-full",
                    showAllEn
                      ? "bg-muted text-foreground"
                      : "text-muted-foreground hover:text-foreground"
                  )}
                >
                  <Languages />
                </Button>
              }
            />
            <TooltipContent>
              {showAllEn ? "hide translations" : "show translations"}
            </TooltipContent>
          </Tooltip>
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
            <TooltipContent>end conversation</TooltipContent>
          </Tooltip>
        </div>
      </div>
    </div>
  )
}
