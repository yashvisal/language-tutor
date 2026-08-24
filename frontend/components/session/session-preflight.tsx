"use client"

/**
 * The pre-flight: the one screen between a learner and speaking.
 *
 * It exists because a session with a declared intent is a better session — the
 * plan steers the tutor's prompt and weights the analyzer — but the cost of
 * asking is that nobody has said a word yet. So it is a single quiet column,
 * not a wizard: every field is optional, defaults are already chosen, and
 * "Suggest one for me" fills the whole thing in one tap. Starting with nothing
 * selected is a legitimate answer (free conversation), and the button never
 * disables.
 *
 * Two hosts now: `/session`'s own pre-connect state (this component) and the
 * dashboard's plan modal (`PlanFields` alone). The fields are exported rather
 * than copied so the two can never ask the same question two ways.
 *
 * Nothing here is Spanish-specific: the situations are prompt-ready phrases and
 * the focus forms come from the per-language catalog in `plan.ts`.
 */

import { useState, type ReactNode } from "react"
import { Shuffle, X } from "lucide-react"

import { Overline } from "@/components/overline"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import type { SessionPlan } from "@/lib/session/contract"
import {
  LEVELS,
  PLAN_LIMITS,
  SCENARIOS,
  suggestPlan,
  tensesFor,
} from "@/lib/session/plan"
import { cn } from "@/lib/utils"

/**
 * Every question the plan is made of, and nothing around them — no heading, no
 * Start. The host supplies the frame.
 */
export function PlanFields({
  plan,
  onChange,
  levelHint,
  className,
}: {
  plan: SessionPlan
  onChange: (plan: SessionPlan) => void
  /** Said beside the level when it arrived from somewhere the learner set it. */
  levelHint?: string
  className?: string
}) {
  // Free text is revealed rather than always shown: an empty input next to the
  // situations reads as a second, competing question. Derived rather than
  // purely stateful, so a plan that arrives after mount (the stored one) opens
  // its own input.
  const [topicToggled, setTopicToggled] = useState(false)
  const topicOpen = topicToggled || plan.topic !== null
  const [vocabDraft, setVocabDraft] = useState("")

  const patch = (next: Partial<SessionPlan>) => onChange({ ...plan, ...next })

  const toggleTense = (value: string) =>
    patch({
      tenses: plan.tenses.includes(value)
        ? plan.tenses.filter((t) => t !== value)
        : plan.tenses.length < PLAN_LIMITS.maxTenses
          ? [...plan.tenses, value]
          : plan.tenses,
    })

  const addVocab = () => {
    const value = vocabDraft.trim().slice(0, PLAN_LIMITS.vocabChars)
    if (!value || plan.vocab.includes(value)) {
      setVocabDraft("")
      return
    }
    if (plan.vocab.length >= PLAN_LIMITS.maxVocab) return
    patch({ vocab: [...plan.vocab, value] })
    setVocabDraft("")
  }

  // Suggest sits with the fields it fills rather than up at heading altitude,
  // where it competed with the question itself.
  const suggest = () => {
    const suggested = suggestPlan(plan.level)
    setTopicToggled(false)
    onChange(suggested)
  }

  const tenses = tensesFor()

  return (
    <div className={cn("flex flex-col gap-7", className)}>
      <Field
        label="Situation"
        aside={
          <Button
            variant="ghost"
            size="xs"
            onClick={suggest}
            className="-my-1 gap-1.5 text-muted-foreground"
          >
            <Shuffle />
            Suggest one for me
          </Button>
        }
      >
        <div className="flex flex-wrap gap-1.5">
          {SCENARIOS.map((option) => (
            <Chip
              key={option.value}
              selected={plan.scenario === option.value}
              onClick={() => {
                const selected = plan.scenario === option.value
                setTopicToggled(false)
                // A situation and a topic are two answers to one question.
                patch({
                  scenario: selected ? null : option.value,
                  topic: null,
                })
              }}
            >
              {option.label}
            </Chip>
          ))}
          <Chip
            selected={topicOpen}
            onClick={() => {
              setTopicToggled(!topicOpen)
              if (topicOpen) patch({ topic: null })
              else patch({ scenario: null })
            }}
          >
            Something else…
          </Chip>
        </div>
        {topicOpen && (
          <Input
            autoFocus
            value={plan.topic ?? ""}
            maxLength={PLAN_LIMITS.topicChars}
            onChange={(e) => {
              // Typing is itself the toggle: without this, clearing the last
              // character would drop `topic` to null and unmount the input
              // under the learner's cursor.
              setTopicToggled(true)
              patch({ topic: e.target.value || null })
            }}
            placeholder="Anything — my trip to Oaxaca, why I quit my job…"
            aria-label="Topic"
            className="mt-3 h-9"
          />
        )}
      </Field>

      {tenses.length > 0 && (
        <Field label="Focus" hint="The tutor will steer toward these forms">
          <div className="flex flex-wrap gap-1.5">
            {tenses.map((option) => (
              <Chip
                key={option.value}
                selected={plan.tenses.includes(option.value)}
                onClick={() => toggleTense(option.value)}
              >
                {option.label}
              </Chip>
            ))}
          </div>
        </Field>
      )}

      <Field label="Vocabulary" hint="Themes to work in">
        <div className="flex flex-wrap items-center gap-1.5">
          {plan.vocab.map((theme) => (
            <span
              key={theme}
              className="inline-flex items-center gap-1 rounded-full border border-primary/30 bg-primary/5 py-1 pr-1 pl-3 text-sm text-foreground"
            >
              {theme}
              <button
                type="button"
                onClick={() =>
                  patch({ vocab: plan.vocab.filter((v) => v !== theme) })
                }
                aria-label={"Remove " + theme}
                className="rounded-full p-0.5 text-muted-foreground transition-colors duration-200 hover:text-foreground"
              >
                <X className="size-3" />
              </button>
            </span>
          ))}
          {plan.vocab.length < PLAN_LIMITS.maxVocab && (
            <Input
              value={vocabDraft}
              maxLength={PLAN_LIMITS.vocabChars}
              onChange={(e) => setVocabDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key !== "Enter") return
                e.preventDefault()
                addVocab()
              }}
              onBlur={addVocab}
              placeholder={plan.vocab.length ? "Add another…" : "food, travel…"}
              aria-label="Add a vocabulary theme"
              className="h-8 w-44 rounded-full px-3"
            />
          )}
        </div>
      </Field>

      <Field label="Where you are" hint={levelHint}>
        <div className="flex flex-wrap gap-1.5">
          {LEVELS.map((option) => (
            <Chip
              key={option.value}
              selected={plan.level === option.value}
              onClick={() => patch({ level: option.value })}
            >
              {option.label}
            </Chip>
          ))}
        </div>
      </Field>
    </div>
  )
}

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
        <h1 className="mt-3 text-xl tracking-[-0.015em] text-foreground">
          What do you want to talk about?
        </h1>
        <p className="mt-2 max-w-sm text-sm leading-relaxed text-muted-foreground">
          Spanish out loud, with corrections when you finish a thought. Talk
          for as long as you like. Everything below is optional.
        </p>

        <PlanFields plan={plan} onChange={onChange} className="mt-9" />

        <div className="mt-10 flex items-center gap-4 border-t border-border/50 pt-6">
          <Button size="lg" onClick={onStart} disabled={connecting}>
            {connecting ? "Connecting…" : "Start talking"}
          </Button>
          <p className="text-xs text-muted-foreground">
            Microphone required. Pausing to study doesn’t use your minutes.
          </p>
        </div>
        {error && (
          <p role="alert" className="mt-4 text-xs text-destructive">
            {error}
          </p>
        )}
      </div>
    </div>
  )
}

/** A labelled block. Sections are separated by space and a small label — no
 * cards, no boxes: the plan is one column of questions. */
function Field({
  label,
  hint,
  aside,
  children,
}: {
  label: string
  hint?: string
  aside?: ReactNode
  children: ReactNode
}) {
  return (
    <section>
      <div className="mb-3 flex items-baseline justify-between gap-3">
        <div className="flex items-baseline gap-2">
          <Overline>{label}</Overline>
          {hint && <span className="text-xs text-muted-foreground">{hint}</span>}
        </div>
        {aside}
      </div>
      {children}
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
