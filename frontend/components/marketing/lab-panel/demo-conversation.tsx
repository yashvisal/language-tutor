"use client"

/**
 * Landing-lab copy of `components/marketing/demo-conversation.tsx`.
 *
 * Same script, same beats, same parts of the real session — the only change is
 * `onStateChange`, which lifts the agent state out so the panel's chrome row
 * can say LISTENING / SPEAKING the way the product's own surface does. The
 * original is left untouched; the sibling variant renders it.
 */

import { useEffect, useState } from "react"
import type { AgentState } from "@livekit/components-react"
import { motion, useReducedMotion } from "motion/react"

import { AmbientAura } from "@/components/marketing/ambient-aura"
import { CorrectedWord } from "@/components/marketing/demo-conversation"
import { cn } from "@/lib/utils"

type Beat =
  | { kind: "tutor"; text: string; ms: number }
  | { kind: "learner"; text: string; ms: number }
  | { kind: "settle"; ms: number }
  | { kind: "correct"; ms: number }
  | { kind: "hold"; ms: number }

const SCRIPT: Beat[] = [
  {
    kind: "tutor",
    text: "¿Qué tal tu fin de semana? Cuéntame qué hiciste.",
    ms: 2600,
  },
  { kind: "learner", text: "Ayer yo fue al supermercado.", ms: 2000 },
  { kind: "settle", ms: 1100 },
  { kind: "correct", ms: 2600 },
  { kind: "tutor", text: "¡Qué bien! ¿Y qué compraste?", ms: 2200 },
  { kind: "hold", ms: 2400 },
]

const LEARNER_WORDS = ["Ayer", "yo", "fue", "al", "supermercado."]
const WRONG_INDEX = 2

export function LabDemoConversation({
  className,
  onStateChange,
  auraClassName,
}: {
  className?: string
  /** The beat's agent state, so the panel chrome can mirror the session. */
  onStateChange?: (state: AgentState) => void
  /** The orb's box. Paper's heroes size it 200px on the plain stage and
   * 176px inside the panel; the shipped demo's 224px is the fallback. */
  auraClassName?: string
}) {
  const reducedMotion = useReducedMotion()
  const [step, setStep] = useState({ index: 0, words: 0 })
  const { index, words } = step
  const beat = SCRIPT[index]!

  useEffect(() => {
    if (reducedMotion) return
    const next = setTimeout(
      () =>
        setStep((s) => ({ index: (s.index + 1) % SCRIPT.length, words: 0 })),
      beat.ms
    )
    if (beat.kind !== "tutor" && beat.kind !== "learner") {
      return () => clearTimeout(next)
    }
    const total = beat.text.split(" ").length
    const perWord = Math.max(120, (beat.ms - 500) / total)
    const typer = setInterval(
      () =>
        setStep((s) => (s.words >= total ? s : { ...s, words: s.words + 1 })),
      perWord
    )
    return () => {
      clearTimeout(next)
      clearInterval(typer)
    }
  }, [index, beat, reducedMotion])

  const resolved = reducedMotion === true

  const auraState: AgentState = resolved
    ? "listening"
    : beat.kind === "tutor"
      ? "speaking"
      : beat.kind === "settle"
        ? "thinking"
        : "listening"

  // Reported from an effect rather than during render: the chrome row is a
  // sibling, and a parent setState mid-render would be a render-phase update.
  useEffect(() => {
    onStateChange?.(auraState)
  }, [auraState, onStateChange])

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

  return (
    <div
      className={cn("flex flex-col items-center", className)}
      aria-label="A short example of a session"
      role="img"
    >
      <div className={cn("relative h-48 sm:h-56", auraClassName)}>
        {/* The stage light: the orb's own colour landing on the surface
            around it. Opacity, spread and blur read from CSS variables so the
            lab's glow tuner can dial them live; the defaults are the Paper
            halo (a tight 60px blur at about a fifth strength). */}
        <div
          aria-hidden
          className="pointer-events-none absolute inset-0 -z-10 rounded-full bg-blue-400 dark:bg-blue-500"
          style={{
            opacity: "var(--lab-glow-opacity, 0.22)",
            transform: "scale(var(--lab-glow-scale, 1.25))",
            filter: "blur(var(--lab-glow-blur, 40px))",
          }}
        />
        <AmbientAura state={auraState} className="h-full" />
      </div>

      <div className="mt-8 min-h-[5.5rem] w-full text-center">
        <div className="mb-2 text-[10px] font-medium tracking-[0.22em] text-muted-foreground/60 uppercase">
          {speaker}
        </div>

        {beat.kind === "tutor" && !resolved ? (
          <Caption text={beat.text} words={words} typing />
        ) : holdText !== null && !resolved ? (
          <Caption text={holdText} words={Number.MAX_SAFE_INTEGER} />
        ) : learnerVisible ? (
          <p className="text-xl leading-snug tracking-tight text-balance sm:text-2xl">
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
          <p className="text-xl text-muted-foreground/70 sm:text-2xl">…</p>
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
}: {
  text: string
  words: number
  typing?: boolean
}) {
  const all = text.split(" ")
  const shown = all.slice(0, words).join(" ")
  return (
    <p className="text-xl leading-snug tracking-tight text-balance sm:text-2xl">
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
