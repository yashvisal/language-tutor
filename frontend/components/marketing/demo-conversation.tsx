"use client"

import { useEffect, useState } from "react"
import type { AgentState } from "@livekit/components-react"
import { motion, useReducedMotion } from "motion/react"

import { AmbientAura } from "@/components/marketing/ambient-aura"
import { cn } from "@/lib/utils"

/**
 * The product, playing by itself.
 *
 * One scripted exchange on a loop — the tutor asks, the learner answers with a
 * wrong preterite, the turn settles, the correction surfaces in place, the
 * conversation moves on. It is built from the session's own parts (the Aura,
 * the caption, the inline correction) rather than an illustration of them, so
 * what a visitor sees here is what they get after signing up.
 *
 * Time drives it, not scroll: a demo you can watch is legible; one you have to
 * operate is a puzzle.
 */

type Beat =
  | { kind: "tutor"; text: string; ms: number }
  | { kind: "learner"; text: string; ms: number }
  | { kind: "settle"; ms: number }
  | { kind: "correct"; ms: number }
  | { kind: "hold"; ms: number }

const SCRIPT: Beat[] = [
  { kind: "tutor", text: "¿Qué tal tu fin de semana? Cuéntame qué hiciste.", ms: 2600 },
  { kind: "learner", text: "Ayer yo fue al supermercado.", ms: 2000 },
  { kind: "settle", ms: 1100 },
  { kind: "correct", ms: 2600 },
  { kind: "tutor", text: "¡Qué bien! ¿Y qué compraste?", ms: 2200 },
  { kind: "hold", ms: 2400 },
]

const LEARNER_WORDS = ["Ayer", "yo", "fue", "al", "supermercado."]
const WRONG_INDEX = 2
const LEARNER_WRONG = "fue"
const LEARNER_RIGHT = "fui"
const LEARNER_BEFORE = "Ayer yo"
const LEARNER_AFTER = "al supermercado."

export function DemoConversation({
  size = "hero",
  className,
}: {
  size?: "hero" | "compact"
  className?: string
}) {
  const reducedMotion = useReducedMotion()
  // One state for "where in the script" and "how much of it is typed", so
  // advancing a beat and resetting the typed count is a single update.
  const [step, setStep] = useState({ index: 0, words: 0 })
  const { index, words } = step
  const beat = SCRIPT[index]!

  // Advance the script; type the spoken beats out word by word.
  useEffect(() => {
    if (reducedMotion) return
    const next = setTimeout(
      () => setStep((s) => ({ index: (s.index + 1) % SCRIPT.length, words: 0 })),
      beat.ms
    )
    if (beat.kind !== "tutor" && beat.kind !== "learner") {
      return () => clearTimeout(next)
    }
    const total = beat.text.split(" ").length
    const perWord = Math.max(120, (beat.ms - 500) / total)
    const typer = setInterval(
      () => setStep((s) => (s.words >= total ? s : { ...s, words: s.words + 1 })),
      perWord
    )
    return () => {
      clearTimeout(next)
      clearInterval(typer)
    }
  }, [index, beat, reducedMotion])

  // Reduced motion: the resolved frame, no loop.
  const resolved = reducedMotion === true

  const auraState: AgentState = resolved
    ? "listening"
    : beat.kind === "tutor"
      ? "speaking"
      : beat.kind === "settle"
        ? "thinking"
        : "listening"

  // The hold beat is the tutor's last line, still on screen — not a blank.
  const holdText =
    beat.kind === "hold" && index > 0
      ? (() => {
          const prev = SCRIPT[index - 1]!
          return prev.kind === "tutor" ? prev.text : null
        })()
      : null
  const speaker =
    (beat.kind === "tutor" || holdText !== null) && !resolved ? "Tutor" : "You"

  const corrected = resolved || beat.kind === "correct"
  const learnerVisible =
    resolved ||
    beat.kind === "learner" ||
    beat.kind === "settle" ||
    beat.kind === "correct"

  const hero = size === "hero"

  return (
    <div
      className={cn("flex flex-col items-center", className)}
      aria-label="A short example of a session"
      role="img"
    >
      <div className={cn("relative", hero ? "h-44 sm:h-52" : "h-36")}>
        {/* The glow is the stage light, not decoration: it is where the
            orb's own color lands on the surface around it. */}
        <div
          aria-hidden
          className="pointer-events-none absolute inset-0 -z-10 scale-150 rounded-full bg-blue-400/25 blur-3xl dark:bg-blue-500/20"
        />
        <AmbientAura state={auraState} className="h-full" />
      </div>

      <div
        className={cn(
          "mt-6 w-full text-center",
          hero ? "min-h-[5.5rem]" : "min-h-[4rem]"
        )}
      >
        <div className="mb-2 text-[10px] font-medium tracking-[0.22em] text-muted-foreground/60 uppercase">
          {speaker}
        </div>

        {beat.kind === "tutor" && !resolved ? (
          <Caption
            text={beat.text}
            words={words}
            typing
            className={hero ? "text-xl sm:text-2xl" : "text-base"}
          />
        ) : holdText !== null && !resolved ? (
          <Caption
            text={holdText}
            words={Number.MAX_SAFE_INTEGER}
            className={hero ? "text-xl sm:text-2xl" : "text-base"}
          />
        ) : learnerVisible ? (
          <p
            className={cn(
              "leading-snug tracking-tight text-balance",
              hero ? "text-xl sm:text-2xl" : "text-base"
            )}
          >
            {LEARNER_WORDS.map((word, i) => {
              const shown = beat.kind !== "learner" || i < words
              if (!shown) return null
              return (
                <span key={i}>
                  {i === WRONG_INDEX ? (
                    <CorrectedWord revealed={corrected} />
                  ) : (
                    word
                  )}
                  {i < LEARNER_WORDS.length - 1 ? " " : ""}
                </span>
              )
            })}
            {beat.kind === "learner" && words < LEARNER_WORDS.length && (
              <Caret />
            )}
          </p>
        ) : (
          <p
            className={cn(
              "text-muted-foreground/70",
              hero ? "text-xl sm:text-2xl" : "text-base"
            )}
          >
            …
          </p>
        )}

        <motion.p
          initial={false}
          animate={{ opacity: corrected ? 1 : 0, y: corrected ? 0 : 4 }}
          transition={{ duration: 0.4, ease: "easeOut" }}
          className="mt-3 text-xs text-muted-foreground"
          aria-hidden={!corrected}
        >
          <span className="font-medium text-foreground/80">fue → fui</span>
          {" · "}past tense, first person. Nobody interrupted you to say so.
        </motion.p>
      </div>
    </div>
  )
}

function Caption({
  text,
  words,
  typing,
  className,
}: {
  text: string
  words: number
  typing?: boolean
  className?: string
}) {
  const all = text.split(" ")
  const shown = all.slice(0, words).join(" ")
  return (
    <p className={cn("leading-snug tracking-tight text-balance", className)}>
      {shown}
      {typing && words < all.length && <Caret />}
    </p>
  )
}

function Caret() {
  return (
    <span
      aria-hidden
      className="ml-1 inline-block h-[1.05em] w-0.5 translate-y-[0.16em] rounded-full bg-primary/60 motion-safe:animate-pulse"
    />
  )
}

/** `fue → fui` in place: the wrong word steps aside for the right one. */
export function CorrectedWord({ revealed }: { revealed: boolean }) {
  return (
    <span className="inline-flex items-baseline gap-1.5">
      <motion.span
        initial={false}
        animate={{ opacity: revealed ? 0.5 : 1 }}
        transition={{ duration: 0.4, ease: "easeOut" }}
        className={cn(
          "rounded-[3px] px-px underline decoration-[0.06em] underline-offset-[0.22em] transition-colors duration-500",
          revealed
            ? "text-muted-foreground line-through decoration-muted-foreground/30"
            : "decoration-primary/60"
        )}
        aria-hidden={revealed}
      >
        {LEARNER_WRONG}
      </motion.span>
      <motion.span
        initial={false}
        animate={{
          opacity: revealed ? 1 : 0,
          y: revealed ? 0 : -4,
          width: revealed ? "auto" : 0,
        }}
        transition={{ duration: 0.4, ease: "easeOut" }}
        className="overflow-hidden font-medium text-primary"
        aria-hidden={!revealed}
      >
        {LEARNER_RIGHT}
      </motion.span>
    </span>
  )
}

/**
 * The correction on its own, for the "how it works" fragment: resolves once
 * it scrolls into view, and stays resolved.
 */
export function CorrectionFragment({ className }: { className?: string }) {
  const reducedMotion = useReducedMotion()
  const [revealed, setRevealed] = useState(reducedMotion === true)
  return (
    <motion.p
      onViewportEnter={() => setTimeout(() => setRevealed(true), 700)}
      viewport={{ once: true, amount: 0.8 }}
      className={cn("text-lg leading-snug tracking-tight", className)}
    >
      {LEARNER_BEFORE} <CorrectedWord revealed={revealed} /> {LEARNER_AFTER}
    </motion.p>
  )
}

/**
 * Words arriving one at a time, on a loop — the shape of a live caption.
 * Types the sentence, holds it, clears, and starts again.
 */
function useLoopTyping(text: string, perWordMs = 260, holdMs = 1800) {
  const reducedMotion = useReducedMotion()
  const total = text.split(" ").length
  const [shown, setShown] = useState(reducedMotion ? total : 0)
  useEffect(() => {
    if (reducedMotion) return
    const timer = setTimeout(
      () => setShown((n) => (n >= total ? 0 : n + 1)),
      shown >= total ? holdMs : shown === 0 ? 500 : perWordMs
    )
    return () => clearTimeout(timer)
  }, [shown, total, perWordMs, holdMs, reducedMotion])
  return { shown, done: shown >= total, text }
}

/** Step 1 — the learner talking, their words arriving as they say them. */
export function SpeakFragment() {
  const typing = useLoopTyping("Ayer yo fue al supermercado.")
  return (
    <StepStage state="listening" speaker="You">
      <Caption
        text={typing.text}
        words={typing.shown}
        typing={!typing.done}
        className="text-lg"
      />
    </StepStage>
  )
}

/** Step 2 — the tutor answering in Spanish, at conversation speed. */
export function AnswerFragment() {
  const typing = useLoopTyping("¡Qué bien! ¿Y qué compraste?", 300)
  return (
    <StepStage state={typing.done ? "listening" : "speaking"} speaker="Tutor">
      <Caption
        text={typing.text}
        words={typing.shown}
        typing={!typing.done}
        className="text-lg"
      />
    </StepStage>
  )
}

/** Step 3 — the correction, in place, with its reason. */
export function FixFragment() {
  return (
    <StepStage state="listening" speaker="You">
      <CorrectionFragment />
      <p className="mt-2 text-xs text-muted-foreground">
        <span className="font-medium text-foreground/80">fue → fui</span>
        {" · "}past tense, first person
      </p>
    </StepStage>
  )
}

/** A miniature of the session stage: small orb, speaker label, caption. */
function StepStage({
  state,
  speaker,
  children,
}: {
  state: AgentState
  speaker: string
  children: React.ReactNode
}) {
  return (
    <div className="flex h-full flex-col items-center justify-center text-center">
      <AmbientAura state={state} className="h-14" />
      <div className="mt-4 mb-1.5 text-[10px] font-medium tracking-[0.22em] text-muted-foreground/60 uppercase">
        {speaker}
      </div>
      <div className="min-h-[3.25rem]">{children}</div>
    </div>
  )
}
