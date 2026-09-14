"use client"

import { useEffect, useState } from "react"
import type { AgentState } from "@livekit/components-react"
import { AnimatePresence, motion, useReducedMotion } from "motion/react"

import { AmbientAura } from "@/components/marketing/ambient-aura"
import { cn } from "@/lib/utils"

/**
 * The product, playing by itself.
 *
 * One conversation on a loop — three turns each way. The tutor asks, the
 * learner answers with one mistake, the turn settles, the correction surfaces
 * in place, and the tutor's next question carries the story on. It is built
 * from the session's own parts (the Aura, the caption, the inline correction)
 * rather than an illustration of them, so what a visitor sees here is what
 * they get after signing up.
 *
 * One story rather than three scenes (Yash, 2026-09-13): three unrelated
 * exchanges back to back went by too fast to follow, with nothing marking
 * where one ended and the next began. A single conversation with a slip in
 * every learner turn shows the same range — a past tense, a gender agreement,
 * ser against estar — without ever feeling disjoint, and a breath before the
 * loop restarts marks the restart. Spanish only: it is the launch language,
 * and the copy already says the coaching is in English.
 *
 * Time drives it, not scroll: a demo you can watch is legible; one you have to
 * operate is a puzzle.
 */

/** One turn of the story: the tutor's question, the learner's answer with
 * one wrong word, the reason, and what the tutor says next — which is the
 * next turn's question, so the turns chain into one conversation. */
export type Scene = {
  tutor: string
  before: string
  wrong: string
  right: string
  after: string
  /** The reason, in the product's own terse voice. */
  note: string
  followUp: string
}

export const SCENES: Scene[] = [
  {
    tutor: "¿Qué tal tu fin de semana? Cuéntame qué hiciste.",
    before: "Ayer yo",
    wrong: "fue",
    right: "fui",
    after: "al supermercado.",
    note: "past tense, first person",
    followUp: "¡Qué bien! ¿Y qué compraste?",
  },
  {
    tutor: "¡Qué bien! ¿Y qué compraste?",
    before: "Compré",
    wrong: "un",
    right: "una",
    after: "cerveza y algo de fruta.",
    note: "cerveza is feminine",
    followUp: "Suena bien. ¿Y hoy, cómo estás?",
  },
  {
    tutor: "Suena bien. ¿Y hoy, cómo estás?",
    before: "Hoy",
    wrong: "soy",
    right: "estoy",
    after: "un poco cansado.",
    note: "estar, for how you feel right now",
    followUp: "Te entiendo. Descansa un poco.",
  },
]

/** The scene the "how it works" miniatures show. The second one, so a
 * visitor scrolling down from the hero sees a different sentence, not the
 * same one again (Yash, 2026-09-13). */
const STEP_SCENE = SCENES[1]!

type Beat =
  | { kind: "tutor"; text: string; ms: number }
  | { kind: "pause"; ms: number }
  | { kind: "learner"; ms: number }
  | { kind: "settle"; ms: number }
  | { kind: "correct"; ms: number }
  | { kind: "followUp"; text: string; ms: number }
  | { kind: "hold"; ms: number }
  | { kind: "break"; ms: number }

/** Words arrive at a reading pace rather than a speaking one, and a beat
 * ends the same short breath after its last word every time, so the rhythm
 * holds from line to line. The first cut gave each line a fixed length and
 * let the tail vary, which read as a stall; the second ran at speech pace
 * and went by too fast to follow (Yash, 2026-09-13). */
const TUTOR_WORD_MS = 300
const LEARNER_WORD_MS = 340
const TAIL_MS = 500

const learnerWords = (s: Scene) =>
  `${s.before} ${s.wrong} ${s.after}`.split(" ")

const spoken = (text: string, perWord: number) =>
  text.split(" ").length * perWord + TAIL_MS

/** A turn's beats. The tutor's follow-up is the next turn's question, so
 * only the last turn plays it here — then holds, then takes a breath. */
const turnBeats = (s: Scene, last: boolean): Beat[] => [
  { kind: "tutor", text: s.tutor, ms: spoken(s.tutor, TUTOR_WORD_MS) },
  // The question stays up while the learner thinks: the answer arriving on
  // the tutor's last word read as a rush (Yash, 2026-09-13).
  { kind: "pause", ms: 1300 },
  {
    kind: "learner",
    ms: learnerWords(s).length * LEARNER_WORD_MS + TAIL_MS,
  },
  { kind: "settle", ms: 1200 },
  // Long enough to read the fix and its reason, twice.
  { kind: "correct", ms: 3400 },
  ...(last
    ? ([
        {
          kind: "followUp",
          text: s.followUp,
          ms: spoken(s.followUp, TUTOR_WORD_MS),
        },
        { kind: "hold", ms: 1400 },
        // The caption clears and the orb sits alone for a moment: the
        // conversation is starting over, and the visitor can see that it is.
        // Short — the long wait here read as the demo having stopped.
        { kind: "break", ms: 900 },
      ] satisfies Beat[])
    : []),
]

/** The whole loop, flat, each beat knowing its turn. */
const SCRIPT: { scene: number; beat: Beat }[] = SCENES.flatMap((s, i) =>
  turnBeats(s, i === SCENES.length - 1).map((beat) => ({ scene: i, beat }))
)

export function DemoConversation({
  size = "hero",
  className,
  auraClassName,
}: {
  size?: "hero" | "compact"
  className?: string
  /** The orb's box, when a page wants a size the two presets do not give:
   * the landing's hero takes the Paper boards' 200px. */
  auraClassName?: string
}) {
  const reducedMotion = useReducedMotion()
  // One state for "where in the script" and "how much of it is typed", so
  // advancing a beat and resetting the typed count is a single update.
  const [step, setStep] = useState({ index: 0, words: 0 })
  const { index, words } = step
  const { scene: sceneIndex, beat } = SCRIPT[index]!
  const scene = SCENES[sceneIndex]!

  // Advance the script; type the spoken beats out word by word.
  useEffect(() => {
    if (reducedMotion) return
    const next = setTimeout(
      () =>
        setStep((s) => ({ index: (s.index + 1) % SCRIPT.length, words: 0 })),
      beat.ms
    )
    const typed =
      beat.kind === "tutor" || beat.kind === "followUp"
        ? { total: beat.text.split(" ").length, perWord: TUTOR_WORD_MS }
        : beat.kind === "learner"
          ? { total: learnerWords(scene).length, perWord: LEARNER_WORD_MS }
          : null
    if (!typed) return () => clearTimeout(next)
    const typer = setInterval(
      () =>
        setStep((s) =>
          s.words >= typed.total ? s : { ...s, words: s.words + 1 }
        ),
      typed.perWord
    )
    return () => {
      clearTimeout(next)
      clearInterval(typer)
    }
  }, [index, beat, scene, reducedMotion])

  // Reduced motion: the first scene's resolved frame, no loop.
  const resolved = reducedMotion === true

  const auraState: AgentState = resolved
    ? "listening"
    : beat.kind === "tutor" || beat.kind === "followUp"
      ? "speaking"
      : beat.kind === "settle"
        ? "thinking"
        : "listening"

  // Which line is on stage. The learner's line stays mounted from the moment
  // they speak until the tutor answers, so the correction animates in place
  // rather than the line being replaced; every other change of speaker is a
  // crossfade (Yash, 2026-09-13: the hard swaps read as a glitch).
  const turn: "tutor" | "learner" | "followUp" | "break" = resolved
    ? "learner"
    : beat.kind === "tutor" || beat.kind === "pause"
      ? "tutor"
      : beat.kind === "followUp" || beat.kind === "hold"
        ? "followUp"
        : beat.kind === "break"
          ? "break"
          : "learner"
  const turnKey = `${resolved ? 0 : sceneIndex}-${turn}`
  const speaker = turn === "learner" ? "You" : "Tutor"

  const corrected = resolved || beat.kind === "correct"
  const settling = beat.kind === "settle"
  const typing =
    !resolved &&
    beat.kind !== "hold" &&
    beat.kind !== "break" &&
    beat.kind !== "pause"

  const hero = size === "hero"
  const captionClass = hero ? "text-xl sm:text-2xl" : "text-base"
  const shownScene = resolved ? SCENES[0]! : scene

  return (
    <div
      className={cn("flex flex-col items-center", className)}
      aria-label="A short example of a session"
      role="img"
    >
      <div
        className={cn(
          "relative",
          hero ? "h-48 sm:h-56" : "h-36",
          auraClassName
        )}
      >
        {/* The glow is the stage light, not decoration: it is where the
            orb's own color lands on the surface around it. Half strength,
            2.3× the orb, 108px of blur: the numbers Yash dialled in on the
            landing lab (2026-09-13), a lot more light than the first cut. */}
        <div
          aria-hidden
          className="pointer-events-none absolute inset-0 -z-10 scale-[2.3] rounded-full bg-blue-400/50 blur-[108px] dark:bg-blue-500/50"
        />
        <AmbientAura state={auraState} className="h-full" />
      </div>

      {/* A grid with every turn in the same cell, so the outgoing and
          incoming lines overlap during the crossfade instead of stacking and
          shoving the page. The reserved height is the tallest turn: the
          learner's line with its correction beneath. */}
      <div
        className={cn(
          "grid w-full text-center [&>*]:[grid-area:1/1]",
          hero ? "mt-8 min-h-[5.5rem]" : "mt-6 min-h-[4rem]"
        )}
      >
        <AnimatePresence initial={false}>
          {turn !== "break" && (
            <motion.div
              key={turnKey}
              initial={{ opacity: 0, y: 6 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -6 }}
              transition={{ duration: 0.4, ease: "easeOut" }}
            >
              <div className="mb-2 text-[10px] font-medium tracking-[0.22em] text-muted-foreground/60 uppercase">
                {speaker}
              </div>

              {turn === "tutor" || turn === "followUp" ? (
                <Caption
                  text={
                    turn === "tutor" ? shownScene.tutor : shownScene.followUp
                  }
                  words={typing ? words : Number.MAX_SAFE_INTEGER}
                  typing={typing}
                  className={captionClass}
                />
              ) : (
                <>
                  {/* The settle beat dims the line a touch: the pause before
                    the correction is the tutor listening to the whole
                    thought, and a static second read as a stall. */}
                  <motion.p
                    initial={false}
                    animate={{ opacity: settling ? 0.7 : 1 }}
                    transition={{ duration: 0.35, ease: "easeOut" }}
                    className={cn(
                      "leading-snug tracking-tight text-balance",
                      captionClass
                    )}
                  >
                    <LearnerLine
                      scene={shownScene}
                      words={beat.kind === "learner" ? words : Infinity}
                      revealed={corrected}
                      typing={beat.kind === "learner"}
                    />
                  </motion.p>
                  <motion.p
                    initial={false}
                    animate={{
                      opacity: corrected ? 1 : 0,
                      y: corrected ? 0 : 4,
                    }}
                    transition={{ duration: 0.4, ease: "easeOut" }}
                    className="mt-3 text-xs text-muted-foreground"
                    aria-hidden={!corrected}
                  >
                    <CorrectionNote scene={shownScene} />
                  </motion.p>
                </>
              )}
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    </div>
  )
}

/** The learner's sentence, word by word, with the wrong word able to step
 * aside for the right one in place. */
function LearnerLine({
  scene,
  words,
  revealed,
  typing,
}: {
  scene: Scene
  words: number
  revealed: boolean
  typing: boolean
}) {
  const all = learnerWords(scene)
  const wrongIndex = scene.before.split(" ").length
  return (
    <>
      {all.map((word, i) => {
        if (i >= words) return null
        return (
          <span key={i}>
            {i === wrongIndex ? (
              <CorrectedWord scene={scene} revealed={revealed} />
            ) : (
              word
            )}
            {i < all.length - 1 ? " " : ""}
          </span>
        )
      })}
      {typing && words < all.length && <Caret />}
    </>
  )
}

/** `fue → fui · past tense, first person`: the product's own terse note,
 * nothing else. The marketing clause that used to follow it belonged to the
 * page, not the product (Yash, 2026-09-13). */
function CorrectionNote({ scene }: { scene: Scene }) {
  return (
    <>
      <span className="font-medium text-foreground/80">
        {scene.wrong} → {scene.right}
      </span>
      {" · "}
      {scene.note}
    </>
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

/** The wrong word stepping aside for the right one, in place. */
export function CorrectedWord({
  scene,
  revealed,
}: {
  scene: Scene
  revealed: boolean
}) {
  return (
    <span className="inline-flex items-baseline">
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
        {scene.wrong}
      </motion.span>
      {/* The line eases open around the right word as it grows, no drop
          from above, no clipping — the step reveal was compared against it
          and this one read as cleaner (Yash, 2026-09-13). The struck word
          drifts during the 400ms as the centred line re-centres; at rest the
          two words share a baseline to the pixel. */}
      <motion.span
        initial={false}
        animate={{
          opacity: revealed ? 1 : 0,
          width: revealed ? "auto" : 0,
          marginLeft: revealed ? "0.25em" : 0,
        }}
        transition={{ duration: 0.4, ease: "easeOut" }}
        className="font-medium whitespace-nowrap text-primary"
        aria-hidden={!revealed}
      >
        {scene.right}
      </motion.span>
    </span>
  )
}

/**
 * The correction on its own, for the "how it works" fragment: resolves once
 * it scrolls into view, and stays resolved.
 */
export function CorrectionFragment({
  scene = STEP_SCENE,
  className,
}: {
  scene?: Scene
  className?: string
}) {
  const reducedMotion = useReducedMotion()
  const [revealed, setRevealed] = useState(reducedMotion === true)
  return (
    <motion.p
      onViewportEnter={() => setTimeout(() => setRevealed(true), 700)}
      viewport={{ once: true, amount: 0.8 }}
      className={cn("text-lg leading-snug tracking-tight", className)}
    >
      {scene.before} <CorrectedWord scene={scene} revealed={revealed} />{" "}
      {scene.after}
    </motion.p>
  )
}

/** The correction, in place, with its reason. */
export function FixFragment() {
  return (
    <FeatureTile label="You">
      <CorrectionFragment />
      <p className="mt-2 text-xs text-muted-foreground">
        <CorrectionNote scene={STEP_SCENE} />
      </p>
    </FeatureTile>
  )
}

/**
 * The shared frame of the three feature tiles: the speaker label on one line
 * at the top, the body centred in the space under it. Pinning the label and
 * centring the body is what makes three bodies of different heights read as
 * one row. The fix tile used to carry a small orb above its label; it went
 * when the other two tiles had none, so the row would sit level (Yash,
 * 2026-09-14).
 */
export function FeatureTile({
  label,
  align = "center",
  children,
}: {
  label: string
  align?: "center" | "start"
  children: React.ReactNode
}) {
  return (
    <div
      className={cn(
        "flex h-full flex-col pt-6",
        align === "center" && "items-center text-center"
      )}
    >
      <div className="text-center text-[10px] font-medium tracking-[0.22em] text-muted-foreground/60 uppercase">
        {label}
      </div>
      <div
        className={cn(
          "flex w-full flex-1 flex-col justify-center pb-3",
          align === "center" && "items-center"
        )}
      >
        {children}
      </div>
    </div>
  )
}
