"use client"

/**
 * The pre-flight: the one thing between a learner and speaking.
 *
 * It is three question cards rather than a form, and the reason is what the
 * answers are FOR. A form asks you to configure a session; a question asks you
 * something, and what you say becomes context the tutor carries into the
 * conversation — which is why every card pairs a short catalog with one open
 * line in the learner's own words. "when to use he comido vs comí" is worth
 * more to the tutor than any chip, and there was nowhere to type it before.
 *
 * One question on screen at a time, `1 / 3` in the footer, Skip always
 * available, Back on the cards that have something behind them. Nothing is
 * required: skipping all three is a legitimate plan (free conversation), and
 * the last card's button never disables.
 *
 * Two hosts: the dashboard's modal (`components/home/start-session.tsx`) and
 * `/session`'s own pre-connect state (`SessionPreflight` below). Both render
 * `PlanCards` — the questions are exported rather than copied so the two can
 * never ask the same thing two ways.
 *
 * Nothing here is Spanish-specific: the situations are prompt-ready phrases,
 * the forms and the focus example come from the per-language catalogs in
 * `plan.ts`, and the language is named through `TARGET_LANGUAGE_NAME`.
 */

import { useState, type ReactNode } from "react"
import { AnimatePresence, motion, useReducedMotion } from "motion/react"

import { Overline } from "@/components/overline"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import type { SessionPlan } from "@/lib/session/contract"
import {
  LEVELS,
  PLAN_LIMITS,
  SCENARIOS,
  TARGET_LANGUAGE_NAME,
  focusNotePlaceholder,
  suggestPlan,
  tensesFor,
} from "@/lib/session/plan"
import { cn } from "@/lib/utils"

const STEP_COUNT = 3

/**
 * The three questions, and the footer that walks them.
 *
 * The host supplies the frame (a modal, a page column) and the class names for
 * its own padding; this owns everything inside — including the Start button,
 * because "the last card's Continue IS Start" is a property of the sequence,
 * not of whoever is hosting it.
 */
export function PlanCards({
  plan,
  onChange,
  onStart,
  levelHint,
  starting = false,
  startLabel = "Start",
  className,
  bodyClassName,
  footerClassName,
}: {
  plan: SessionPlan
  onChange: (plan: SessionPlan) => void
  /** Fired by the last card's button. The host persists and connects. */
  onStart: () => void
  /** Said beside the level when it arrived from somewhere the learner set it. */
  levelHint?: string
  starting?: boolean
  startLabel?: string
  className?: string
  bodyClassName?: string
  footerClassName?: string
}) {
  const [step, setStep] = useState(0)
  // Which way the next card should come from. Kept in state rather than derived
  // because the outgoing card animates after `step` has already changed.
  const [forward, setForward] = useState(true)
  const reducedMotion = useReducedMotion()

  const patch = (next: Partial<SessionPlan>) => onChange({ ...plan, ...next })

  const go = (next: number) => {
    setForward(next > step)
    setStep(next)
  }

  const last = step === STEP_COUNT - 1
  const advance = () => (last ? onStart() : go(step + 1))

  const tenses = tensesFor()

  const toggleTense = (value: string) =>
    patch({
      tenses: plan.tenses.includes(value)
        ? plan.tenses.filter((t) => t !== value)
        : plan.tenses.length < PLAN_LIMITS.maxTenses
          ? [...plan.tenses, value]
          : plan.tenses,
    })

  const cards: ReactNode[] = [
    <Card
      key="subject"
      question="What do you want to be ready to talk about?"
      aside={
        <button
          type="button"
          onClick={() => onChange(suggestPlan(plan.level))}
          className="shrink-0 text-xs text-muted-foreground underline underline-offset-4 transition-colors duration-200 outline-none hover:text-foreground focus-visible:text-foreground"
        >
          Suggest one for me
        </button>
      }
      noteLabel="Or, in your own words"
      noteValue={plan.topic}
      notePlaceholder="Something specific — a trip next week, a call with your grandmother…"
      noteMaxLength={PLAN_LIMITS.topicChars}
      onNoteChange={(topic) => patch({ topic })}
    >
      {SCENARIOS.map((option) => (
        <Chip
          key={option.value}
          selected={plan.scenario === option.value}
          onClick={() =>
            patch({
              scenario: plan.scenario === option.value ? null : option.value,
            })
          }
        >
          {option.label}
        </Chip>
      ))}
    </Card>,

    <Card
      key="focus"
      question="Anything you want the tutor to push you on?"
      hint={
        tenses.length > 0
          ? "You could use some of these — pick any, or none."
          : undefined
      }
      noteLabel="Something specific?"
      noteValue={plan.focusNote}
      notePlaceholder={focusNotePlaceholder()}
      noteMaxLength={PLAN_LIMITS.focusNoteChars}
      onNoteChange={(focusNote) => patch({ focusNote })}
    >
      {tenses.map((option) => (
        <Chip
          key={option.value}
          selected={plan.tenses.includes(option.value)}
          onClick={() => toggleTense(option.value)}
        >
          {option.label}
        </Chip>
      ))}
    </Card>,

    <Card
      key="level"
      question={`Where are you with ${TARGET_LANGUAGE_NAME} right now?`}
      hint={levelHint}
      noteLabel="Anything else the tutor should know?"
      noteValue={plan.note}
      notePlaceholder="Grew up hearing it, haven’t spoken it in years…"
      noteMaxLength={PLAN_LIMITS.noteChars}
      onNoteChange={(note) => patch({ note })}
    >
      {LEVELS.map((option) => (
        <Chip
          key={option.value}
          selected={plan.level === option.value}
          onClick={() => patch({ level: option.value })}
        >
          {option.label}
        </Chip>
      ))}
    </Card>,
  ]

  const offset = reducedMotion ? 0 : forward ? 12 : -12

  return (
    <div className={cn("flex flex-col", className)}>
      {/* Reserved height, sized to the tallest card: the three are different
          lengths, and a footer that jumps between questions reads as a
          different screen each time rather than one that turned a page. */}
      <div className={cn("min-h-80", bodyClassName)}>
        <AnimatePresence mode="wait" initial={false}>
          <motion.div
            key={step}
            initial={{ opacity: 0, x: offset }}
            animate={{ opacity: 1, x: 0 }}
            exit={{ opacity: 0, x: -offset }}
            transition={{ duration: reducedMotion ? 0 : 0.18, ease: "easeOut" }}
          >
            {cards[step]}
          </motion.div>
        </AnimatePresence>
      </div>

      <div
        className={cn(
          "flex items-center justify-between gap-4 border-t border-foreground/[0.06] dark:border-white/10",
          footerClassName
        )}
      >
        <div className="flex items-center gap-3">
          <span className="text-xs text-muted-foreground tabular-nums">
            {step + 1} / {STEP_COUNT}
          </span>
          {step > 0 && (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => go(step - 1)}
              className="-mx-2 text-muted-foreground"
            >
              Back
            </Button>
          )}
        </div>

        <div className="flex items-center gap-2">
          {/* Skip advances without touching this card's answers. The last card
              has nothing to advance to — its Skip would be its Start. */}
          {!last && (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => go(step + 1)}
              className="text-muted-foreground"
            >
              Skip
            </Button>
          )}
          <Button size="lg" onClick={advance} disabled={last && starting}>
            {last ? (starting ? "Connecting…" : startLabel) : "Continue"}
          </Button>
        </div>
      </div>
    </div>
  )
}

/**
 * `/session`'s own pre-flight: the same three cards, in a page-width column,
 * reached only without the dashboard hand-off (a bookmark, a reload).
 */
export function SessionPreflight({
  plan,
  onChange,
  onStart,
  connecting,
  error,
  above,
  className,
}: {
  plan: SessionPlan
  onChange: (plan: SessionPlan) => void
  onStart: () => void
  connecting: boolean
  error: string | null
  /** Rendered above the first question, inside the same column — `/session`
   * puts its way back to `/home` here. */
  above?: ReactNode
  /** For hosts that already provide their own page frame. */
  className?: string
}) {
  return (
    <div
      className={cn(
        "flex min-h-svh justify-center bg-background px-8 py-[clamp(3rem,12vh,7rem)]",
        className
      )}
    >
      <div className="w-full max-w-xl">
        {above}
        <Overline>Before you start</Overline>
        <p className="mt-3 max-w-sm text-sm leading-relaxed text-muted-foreground">
          {TARGET_LANGUAGE_NAME} out loud, with corrections when you finish a
          thought. Three questions first — skip any of them.
        </p>

        <PlanCards
          plan={plan}
          onChange={onChange}
          onStart={onStart}
          starting={connecting}
          startLabel="Start talking"
          className="mt-8"
          footerClassName="mt-8 pt-6"
        />

        <p className="mt-4 text-xs text-muted-foreground">
          Microphone required. Pausing to study doesn’t use your minutes.
        </p>
        {error && (
          <p role="alert" className="mt-3 text-xs text-destructive">
            {error}
          </p>
        )}
      </div>
    </div>
  )
}

/**
 * One question: the question itself, its options, and one open line under
 * them. The open line is always visible rather than revealed — on a card that
 * asks only one thing it cannot compete with the question, and hiding it hid
 * the most useful answer the learner could give.
 */
function Card({
  question,
  hint,
  aside,
  children,
  noteLabel,
  noteValue,
  notePlaceholder,
  noteMaxLength,
  onNoteChange,
}: {
  question: string
  hint?: string
  aside?: ReactNode
  children: ReactNode
  noteLabel: string
  noteValue: string | null
  notePlaceholder: string
  noteMaxLength: number
  onNoteChange: (value: string | null) => void
}) {
  return (
    <section>
      <div className="flex items-baseline justify-between gap-4">
        <h2 className="text-base leading-snug tracking-[-0.01em] text-foreground text-balance">
          {question}
        </h2>
        {aside}
      </div>
      {hint && (
        <p className="mt-1.5 text-xs text-muted-foreground">{hint}</p>
      )}

      <div className="mt-4 flex flex-wrap gap-1.5">{children}</div>

      <label className="mt-6 block">
        <span className="text-xs text-muted-foreground">{noteLabel}</span>
        <Input
          value={noteValue ?? ""}
          maxLength={noteMaxLength}
          onChange={(e) => onNoteChange(e.target.value || null)}
          placeholder={notePlaceholder}
          className="mt-1.5 h-9"
        />
      </label>
    </section>
  )
}

/** The one selection primitive on this screen: a quiet outline that fills with
 * the identity color when chosen. */
function Chip({
  selected,
  onClick,
  children,
}: {
  selected: boolean
  onClick: () => void
  children: ReactNode
}) {
  return (
    <button
      type="button"
      aria-pressed={selected}
      onClick={onClick}
      className={cn(
        "rounded-full border px-3 py-1 text-sm transition-[background-color,border-color,color] duration-200 outline-none focus-visible:ring-3 focus-visible:ring-ring/50",
        selected
          ? "border-primary/40 bg-primary/10 text-foreground"
          : "border-border/70 text-muted-foreground hover:border-border hover:text-foreground"
      )}
    >
      {children}
    </button>
  )
}
