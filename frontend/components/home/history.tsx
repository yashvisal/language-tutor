"use client"

/**
 * History: the conversations the learner has already had, under the panel that
 * starts the next one.
 *
 * This replaces the activity calendar. A contributions grid answered "did you
 * show up", which is a streak metric — it says nothing about what was said or
 * what the tutor caught, and a learner who wants to review yesterday's
 * mistakes could not get to them from it (cut 2026-08-24).
 *
 * The list borrows the Billing dialog's grammar deliberately — hairline-
 * separated rows, muted date, tabular numbers — so the two records of the same
 * sessions (what they cost, what they were) read as one family. The whole row
 * is a button, because the interesting half is inside it.
 */

import { useState } from "react"
import { MoveRight } from "lucide-react"
import { useQuery } from "convex/react"

import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { api } from "@/convex/_generated/api"
import { formatClock } from "@/lib/billing"
import {
  CATEGORY_LABELS,
  type CorrectionCategory,
} from "@/lib/session/contract"
import { SCENARIOS, tensesFor } from "@/lib/session/plan"
import { TARGET_LANGUAGE } from "@/lib/session/protocol"

/** One finished conversation, as `sessions.history` returns it. */
type HistoryEntry = NonNullable<
  ReturnType<typeof useQuery<typeof api.sessions.history>>
>[number]

/** The plan as STORED — `SessionPlan` with the two back-compat notes optional
 * (`sessionPlanValidator`), because rows predate them. */
type StoredPlan = HistoryEntry["plan"]

export function History() {
  const sessions = useQuery(api.sessions.history)
  const [openId, setOpenId] = useState<string | null>(null)

  const selected = sessions?.find((entry) => entry.id === openId) ?? null

  // Nothing yet: the section vanishes rather than announcing its emptiness.
  if (sessions !== undefined && sessions.length === 0) return null

  return (
    <section>
      <h2 className="text-sm font-medium text-foreground">History</h2>

      {/* Reserved height, so nothing below jumps when the query lands. */}
      <div className="mt-2 min-h-24">
        {sessions !== undefined && sessions.length > 0 && (
          <ul className="divide-y divide-foreground/[0.06] dark:divide-white/10">
            {sessions.map((entry) => (
              <li key={entry.id}>
                <button
                  type="button"
                  onClick={() => setOpenId(entry.id)}
                  className="flex w-full items-baseline justify-between gap-4 rounded-md px-2 py-2.5 text-left transition-colors duration-200 hover:bg-foreground/[0.03] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
                >
                  <span className="min-w-0 flex-1 truncate text-sm text-foreground">
                    {titleFor(entry.plan)}
                  </span>
                  <span className="shrink-0 text-xs text-muted-foreground tabular-nums">
                    {formatDate(entry.startedAt)}
                  </span>
                  <span className="w-12 shrink-0 text-right text-sm text-foreground tabular-nums">
                    {formatClock(entry.secondsTalked)}
                  </span>
                  <span className="w-16 shrink-0 text-right text-xs text-muted-foreground tabular-nums">
                    {fixes(entry.corrections.length)}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>

      <SessionDialog
        entry={selected}
        onOpenChange={(open) => {
          if (!open) setOpenId(null)
        }}
      />
    </section>
  )
}

/** The review modal: what the conversation was about, and what it earned. */
function SessionDialog({
  entry,
  onOpenChange,
}: {
  entry: HistoryEntry | null
  onOpenChange: (open: boolean) => void
}) {
  const rows = entry === null ? [] : planRows(entry.plan)

  return (
    <Dialog open={entry !== null} onOpenChange={onOpenChange}>
      <DialogContent className="gap-0 overflow-hidden p-0 sm:max-w-md">
        {entry !== null && (
          <>
            <DialogHeader className="px-6 pt-6 pb-4 text-left">
              <DialogTitle className="text-lg font-semibold tracking-tight">
                {titleFor(entry.plan)}
              </DialogTitle>
              <DialogDescription className="tabular-nums">
                {formatDate(entry.startedAt)} ·{" "}
                {formatClock(entry.secondsTalked)} talked
              </DialogDescription>
            </DialogHeader>

            <div className="max-h-[60svh] [scrollbar-width:thin] [scrollbar-color:var(--border)_transparent] space-y-6 overflow-y-auto px-6 py-1">
              <div>
                <p className="text-sm font-medium text-foreground">
                  What you talked about
                </p>
                {rows.length === 0 ? (
                  <p className="mt-2 text-sm text-muted-foreground">
                    No plan — you just talked.
                  </p>
                ) : (
                  <dl className="mt-2 divide-y divide-foreground/[0.06] dark:divide-white/10">
                    {rows.map((row) => (
                      <div
                        key={row.label}
                        className="flex items-baseline justify-between gap-4 py-2"
                      >
                        <dt className="shrink-0 text-xs text-muted-foreground">
                          {row.label}
                        </dt>
                        <dd className="min-w-0 text-right text-sm text-foreground">
                          {row.value}
                        </dd>
                      </div>
                    ))}
                  </dl>
                )}
              </div>

              <div>
                <p className="text-sm font-medium text-foreground">Mistakes</p>
                {entry.corrections.length === 0 ? (
                  <p className="mt-2 text-sm text-muted-foreground">
                    Nothing to fix — clean run.
                  </p>
                ) : (
                  <ul className="mt-2 divide-y divide-foreground/[0.06] dark:divide-white/10">
                    {entry.corrections.map((correction, index) => (
                      <li
                        key={`${correction.id}-${index}`}
                        className="flex items-start justify-between gap-3 py-2.5"
                      >
                        {/* The fix and its reason are one block; the tag sits
                            beside them so a long sentence never pushes it onto
                            a line of its own. */}
                        <div className="min-w-0">
                          <p className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-sm">
                            <span
                              className="text-muted-foreground line-through decoration-muted-foreground/40"
                              lang={TARGET_LANGUAGE}
                            >
                              {correction.original}
                            </span>
                            <MoveRight
                              aria-hidden
                              className="size-3.5 shrink-0 text-muted-foreground/50"
                            />
                            <span
                              className="font-medium text-foreground"
                              lang={TARGET_LANGUAGE}
                            >
                              {correction.replacement}
                            </span>
                          </p>
                          {correction.explanation && (
                            <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
                              {correction.explanation}
                            </p>
                          )}
                        </div>
                        <span className="mt-0.5 shrink-0 rounded-full bg-foreground/[0.05] px-2 py-0.5 text-[11px] text-muted-foreground dark:bg-white/10">
                          {categoryLabel(correction.category)}
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            </div>

            <div className="flex items-center justify-end gap-4 border-t border-foreground/[0.06] px-6 py-4 dark:border-white/10">
              <Button onClick={() => onOpenChange(false)}>Done</Button>
            </div>
          </>
        )}
      </DialogContent>
    </Dialog>
  )
}

/**
 * What the conversation was, in one line. The topic is the learner's own
 * words, so it wins over the catalog scenario; with neither, the session was
 * free conversation, which is a real answer and not a missing one.
 */
function titleFor(plan: StoredPlan): string {
  const topic = plan.topic?.trim()
  if (topic) return sentenceCase(topic)
  const scenario = plan.scenario?.trim()
  if (scenario) return scenarioLabel(scenario)
  return "Free conversation"
}

/** The learner typed it mid-sentence; as a title it wants a capital. */
function sentenceCase(text: string): string {
  return text.charAt(0).toLocaleUpperCase() + text.slice(1)
}

/** The plan as the learner declared it, skipping everything they left blank. */
function planRows(plan: StoredPlan): { label: string; value: string }[] {
  const rows: { label: string; value: string }[] = []
  const topic = plan.topic?.trim()
  if (topic) rows.push({ label: "Topic", value: topic })
  const scenario = plan.scenario?.trim()
  if (scenario) rows.push({ label: "Scenario", value: scenarioLabel(scenario) })
  const focusNote = plan.focusNote?.trim()
  if (focusNote) rows.push({ label: "Pushed on", value: focusNote })
  const note = plan.note?.trim()
  if (note) rows.push({ label: "Note", value: note })
  if (plan.tenses.length > 0) {
    rows.push({ label: "Forms", value: plan.tenses.map(tenseLabel).join(", ") })
  }
  return rows
}

/** Catalog labels where we have one, the stored value otherwise: a plan
 * written against an older catalog is still what the learner picked. */
function scenarioLabel(value: string): string {
  return SCENARIOS.find((option) => option.value === value)?.label ?? value
}

function tenseLabel(value: string): string {
  const label = tensesFor().find((option) => option.value === value)?.label
  // Catalog labels carry the native term ("Preterite · pretérito"); one line
  // of a summary row wants the short side.
  return label?.split(" · ")[0] ?? value
}

/** Stored as a plain string (see `convex/validators.ts`), so an unrecognized
 * category prints itself rather than blanking out. */
function categoryLabel(category: string): string {
  return CATEGORY_LABELS[category as CorrectionCategory] ?? category
}

function fixes(count: number): string {
  if (count === 0) return "no fixes"
  return `${count} ${count === 1 ? "fix" : "fixes"}`
}

/** Short and local: "Aug 24" — the same date the Billing dialog prints. */
function formatDate(ms: number): string {
  return new Date(ms).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
  })
}
