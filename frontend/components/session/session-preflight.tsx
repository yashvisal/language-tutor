"use client"

/**
 * The pre-flight: the one thing between a learner and speaking.
 *
 * It is a short conversation, not a form. Three questions, one on screen at a
 * time, each answered by typing — because what the learner types is what the
 * tutor carries into the session. "when to use he comido vs comí" is worth more
 * than any chip could be, and a grid of chips only ever asked the learner to
 * configure a session before they had said anything.
 *
 * So: one prominent question, one text field, `1 / 3` in the footer, Skip and
 * Continue. Answered questions collapse into quiet rows above the current one,
 * which is what makes the card read as a conversation rather than a wizard —
 * and clicking a row goes back to it. Nothing is required: skipping all three
 * is a legitimate plan (free conversation), and the last step's button never
 * disables.
 *
 * The three answers land in `plan.topic`, `plan.focusNote` and `plan.note`.
 * `scenario` and `tenses` stay in the contract — the catalogs and `suggestPlan`
 * still use them — but this screen never sets them, and the level is whatever
 * the learner's profile says.
 *
 * Two hosts: the dashboard's modal (`components/home/start-session.tsx`) and
 * `/session`'s own pre-connect state (`SessionPreflight` below). Both render
 * `PlanCards` — the questions are exported rather than copied so the two can
 * never ask the same thing two ways.
 *
 * Nothing here is Spanish-specific: the focus example comes from the
 * per-language catalog in `plan.ts`, and the language is named through
 * `TARGET_LANGUAGE_NAME`.
 */

import {
  useEffect,
  useLayoutEffect,
  useState,
  type KeyboardEvent,
  type ReactNode,
  useRef,
} from "react"
import { AnimatePresence, motion, useReducedMotion } from "motion/react"

import { Overline } from "@/components/overline"
import { Button } from "@/components/ui/button"
import type { SessionPlan } from "@/lib/session/contract"
import {
  PLAN_LIMITS,
  TARGET_LANGUAGE_NAME,
  focusNotePlaceholder,
} from "@/lib/session/plan"
import { cn } from "@/lib/utils"

/** The plan fields this screen can write. The rest of the plan is untouched. */
type AnswerField = "topic" | "focusNote" | "note"

interface Question {
  field: AnswerField
  question: string
  hint?: string
  placeholder: string
  maxLength: number
}

/** Two rows of room, growing to about five before it scrolls. */
const FIELD_LINE_HEIGHT = 24
const FIELD_PADDING = 16
const FIELD_MAX_HEIGHT = FIELD_LINE_HEIGHT * 5 + FIELD_PADDING

/**
 * The three questions, and the footer that walks them.
 *
 * The host supplies the frame (a modal, a page column) and the class names for
 * its own padding; this owns everything inside — including the Start button,
 * because "the last question's Continue IS Start" is a property of the
 * sequence, not of whoever is hosting it.
 */
export function PlanCards({
  plan,
  onChange,
  onStart,
  starting = false,
  startLabel = "Start",
  className,
  bodyClassName,
  footerClassName,
}: {
  plan: SessionPlan
  onChange: (plan: SessionPlan) => void
  /** Fired by the last question's button with the plan as of that answer —
   * the host's own `plan` state is one render behind at this point. The host
   * persists and connects. */
  onStart: (plan: SessionPlan) => void
  starting?: boolean
  startLabel?: string
  className?: string
  bodyClassName?: string
  footerClassName?: string
}) {
  const [step, setStep] = useState(0)
  const reducedMotion = useReducedMotion()

  const questions: Question[] = [
    {
      field: "topic",
      question: "What do you want to be ready to talk about?",
      placeholder:
        "A trip to Oaxaca next month, a call with my grandmother, ordering at a restaurant…",
      maxLength: PLAN_LIMITS.topicChars,
    },
    {
      field: "focusNote",
      question: "Anything you want the tutor to push you on?",
      hint: "Tenses, phrases, a habit you want to break.",
      placeholder: focusNotePlaceholder(),
      maxLength: PLAN_LIMITS.focusNoteChars,
    },
    {
      field: "note",
      question: "Anything else the tutor should know?",
      placeholder: "I understand more than I can say. Go slow at first.",
      maxLength: PLAN_LIMITS.noteChars,
    },
  ]

  const last = step === questions.length - 1
  const current = questions[step]!

  const patch = (next: Partial<SessionPlan>) => onChange({ ...plan, ...next })

  /**
   * Move on. `keep` is the difference between Continue and Skip: Continue
   * commits what was typed (trimmed, empty becomes nothing at all), Skip
   * clears it, so a question the learner walked past never reaches the tutor
   * as a half-typed thought.
   */
  const advance = (keep: boolean) => {
    const raw = keep ? plan[current.field] : null
    const next: SessionPlan = { ...plan, [current.field]: raw?.trim() || null }
    onChange(next)
    // The host's `plan` is still the previous render's; hand it this one.
    // Firing twice is the host's problem to absorb (the connection owner
    // ignores a start while one is in flight; a repeated push is a no-op) —
    // a guard here outlived a failed start and made Start dead.
    if (last) onStart(next)
    else setStep(step + 1)
  }

  return (
    <div className={cn("flex flex-col", className)}>
      <div className={bodyClassName}>
        {/* Answered questions, in the order they were asked. Quiet enough that
            the live question is the only thing with weight on screen, and
            clickable because "wait, I want to change that" is the whole reason
            they stay on screen at all. */}
        {step > 0 && (
          <ul className="mb-5 divide-y divide-foreground/[0.06] dark:divide-white/10">
            {questions.slice(0, step).map((answered, index) => {
              const value = plan[answered.field]?.trim()
              return (
                <li key={answered.field}>
                  <button
                    type="button"
                    onClick={() => setStep(index)}
                    className="flex w-full items-baseline justify-between gap-4 py-2.5 text-left transition-colors duration-200 outline-none hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50"
                  >
                    <span className="min-w-0 flex-1">
                      <span className="block text-xs text-muted-foreground">
                        {answered.question}
                      </span>
                      {value && (
                        <span className="mt-0.5 block truncate text-sm text-foreground">
                          {value}
                        </span>
                      )}
                    </span>
                    {!value && (
                      <span className="shrink-0 rounded-full bg-foreground/[0.05] px-2 py-0.5 text-[11px] text-muted-foreground dark:bg-white/10">
                        Skipped
                      </span>
                    )}
                  </button>
                </li>
              )
            })}
          </ul>
        )}

        <AnimatePresence mode="wait" initial={false}>
          <motion.div
            key={step}
            initial={{ opacity: 0, y: reducedMotion ? 0 : 6 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0 }}
            transition={{ duration: reducedMotion ? 0 : 0.18, ease: "easeOut" }}
          >
            <h2 className="text-lg leading-snug font-normal text-foreground">
              {current.question}
            </h2>
            {current.hint && (
              <p className="mt-1.5 text-xs text-muted-foreground">
                {current.hint}
              </p>
            )}

            <AnswerField
              label={current.question}
              value={plan[current.field] ?? ""}
              placeholder={current.placeholder}
              maxLength={current.maxLength}
              onValueChange={(value) =>
                patch({
                  [current.field]: value || null,
                } as Partial<SessionPlan>)
              }
              onSubmit={() => advance(true)}
            />
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
            {step + 1} / {questions.length}
          </span>
          {step > 0 && (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setStep(step - 1)}
              disabled={starting}
              className="text-muted-foreground"
            >
              Back
            </Button>
          )}
        </div>

        <div className="flex items-center gap-2">
          {/* Skip clears this question's answer and moves on — on the last one
              that means starting, with nothing said here. */}
          <Button
            variant="ghost"
            size="sm"
            onClick={() => advance(false)}
            disabled={starting}
            className="text-muted-foreground"
          >
            Skip
          </Button>
          <Button size="lg" onClick={() => advance(true)} disabled={starting}>
            {last ? (starting ? "Connecting…" : startLabel) : "Continue"}
          </Button>
        </div>
      </div>
    </div>
  )
}

/**
 * The answer: one field, focused the moment its question appears, growing with
 * what is typed. Enter continues — this is a sentence, not a paragraph — and
 * Shift+Enter is there for anyone who wants a second line anyway.
 */
function AnswerField({
  value,
  placeholder,
  maxLength,
  label,
  onValueChange,
  onSubmit,
}: {
  value: string
  placeholder: string
  maxLength: number
  label: string
  onValueChange: (value: string) => void
  onSubmit: () => void
}) {
  const ref = useRef<HTMLTextAreaElement>(null)

  // Focus through a ref rather than the `autoFocus` attribute: inside a dialog
  // the attribute races the focus trap, and an effect runs after it settles.
  useEffect(() => {
    ref.current?.focus()
  }, [])

  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    el.style.height = "auto"
    el.style.height = `${Math.min(el.scrollHeight, FIELD_MAX_HEIGHT)}px`
  }, [value])

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key !== "Enter" || event.shiftKey) return
    // Enter inside an IME commits the candidate, not the answer.
    if (event.nativeEvent.isComposing) return
    event.preventDefault()
    onSubmit()
  }

  return (
    <textarea
      ref={ref}
      rows={2}
      value={value}
      aria-label={label}
      maxLength={maxLength}
      placeholder={placeholder}
      onChange={(event) => onValueChange(event.target.value)}
      onKeyDown={onKeyDown}
      style={{ maxHeight: FIELD_MAX_HEIGHT }}
      className="mt-4 block w-full resize-none rounded-xl bg-foreground/[0.04] px-4 py-3 text-[15px] leading-6 text-foreground transition-[box-shadow,background-color] duration-200 outline-none placeholder:text-muted-foreground/70 focus-visible:bg-foreground/[0.06] focus-visible:ring-2 focus-visible:ring-primary/30 dark:bg-white/[0.06] dark:focus-visible:bg-white/[0.08]"
    />
  )
}

/**
 * `/session`'s own pre-flight: the same three questions, in a page-width
 * column, reached only without the dashboard hand-off (a bookmark, a reload).
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
  onStart: (plan: SessionPlan) => void
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
          thought. Three quick questions first — skip any.
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
