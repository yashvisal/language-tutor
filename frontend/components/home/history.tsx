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

import {
  ReviewMaterialView,
  hasReviewMaterial,
} from "@/components/session/review-material"
import {
  AsksList,
  CorrectionDiff,
  EndReasonNote,
  LookupsList,
} from "@/components/session/session-record"
import { TranscriptRecord } from "@/components/session/transcript-record"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import type { FunctionReturnType } from "convex/server"

import { api } from "@/convex/_generated/api"
import { useAuthedQuery } from "@/lib/use-authed-query"
import { formatClock } from "@/lib/billing"
import {
  CATEGORY_LABELS,
  type CorrectionCategory,
} from "@/lib/session/contract"
import { SCENARIOS } from "@/lib/session/plan"
import { SessionLanguageProvider } from "@/components/session/session-language"
import { LANGUAGE_NAMES, targetLanguage } from "@/lib/session/plan"

/** One finished conversation, as `sessions.history` returns it. */
type HistoryEntry = FunctionReturnType<typeof api.sessions.history>[number]

/** The plan as STORED — `SessionPlan` with the two back-compat notes optional
 * (`sessionPlanValidator`), because rows predate them. */
type StoredPlan = HistoryEntry["plan"]

export function History() {
  const sessions = useAuthedQuery(api.sessions.history, {})
  const [openId, setOpenId] = useState<string | null>(null)

  const selected = sessions?.find((entry) => entry.id === openId) ?? null

  // In flight. Nothing at all, not a heading over an empty box: a learner with
  // no history would otherwise watch "History" appear and then vanish on the
  // very first paint of their dashboard (audit §4.19).
  if (sessions === undefined) return null

  // Nothing yet: the section vanishes rather than announcing its emptiness.
  if (sessions.length === 0) return null

  return (
    <section>
      <h2 className="text-sm font-medium text-foreground">History</h2>

      <div className="mt-2">
        {sessions.length > 0 && (
          <ul className="divide-y divide-foreground/[0.06] dark:divide-white/10">
            {sessions.map((entry) => (
              <li key={entry.id}>
                <button
                  type="button"
                  onClick={() => setOpenId(entry.id)}
                  className="flex w-full items-baseline justify-between gap-4 rounded-md px-2 py-2.5 text-left transition-colors duration-200 hover:bg-foreground/[0.03] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
                >
                  {/* The goal: the line the tutor and the learner agreed at
                      the top. It is there from the moment the goal is set
                      and it does not change, which is why it is the title —
                      the worker's `about` line used to take over when the
                      record landed, and a row renaming itself a minute later
                      read as a glitch (Yash, 2026-09-09). The plan's topic
                      stands in for a row with no goal. */}
                  {/* Date first, at a fixed width, so every row's columns
                      line up whatever the date's length; the language pill
                      sits at the far right for the same reason. The fix count
                      is gone from the row — it is inside, and it read as a
                      score (Yash, 2026-09-10). */}
                  <span className="w-14 shrink-0 text-xs text-muted-foreground tabular-nums">
                    {formatDate(entry.startedAt)}
                  </span>
                  <span className="min-w-0 flex-1 truncate text-sm text-foreground">
                    {entry.goal?.trim() || titleFor(entry.plan)}
                  </span>
                  <span className="w-12 shrink-0 text-right text-sm text-foreground tabular-nums">
                    {formatClock(entry.secondsTalked)}
                  </span>
                  <span className="w-20 shrink-0 text-right">
                    <span className="rounded-full bg-foreground/[0.05] px-2 py-0.5 text-[11px] text-muted-foreground dark:bg-white/10">
                      {
                        LANGUAGE_NAMES[
                          targetLanguage(entry.plan.targetLanguage)
                        ]
                      }
                    </span>
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
  /**
   * The rest of the record — the Review material and the transcript — which
   * `sessions.history` deliberately does not carry: it is a list, and neither
   * belongs in a payload rendered thirty rows at a time. Fetched only for the
   * row that was actually opened, and rendered with the same two components
   * the post-session summary uses, so one conversation has one appearance.
   */
  const room = entry?.room ?? null
  const record = useAuthedQuery(
    api.sessions.byRoom,
    room === null ? "skip" : { room }
  )
  const review = record?.review ?? null
  const transcript = record?.transcript ?? null
  const endReason = entry?.endReason ?? record?.endReason ?? null

  /**
   * The transcript, the asks and the lookups open on request. They are the
   * long part, and the modal opened at full height with eleven things
   * stacked in it read as clutter (Yash, 2026-09-11): the goal, what it
   * became, the mistakes and the review are the record; the rest is there
   * for whoever wants to read the whole conversation back.
   */
  const [showTranscript, setShowTranscript] = useState(false)
  const [openedFor, setOpenedFor] = useState<string | null>(null)
  const id = entry?.id ?? null
  if (openedFor !== id) {
    setOpenedFor(id)
    setShowTranscript(false)
  }
  const hasTranscript =
    (transcript?.length ?? 0) > 0 ||
    (record?.asks?.length ?? 0) > 0 ||
    (record?.lookups?.length ?? 0) > 0

  return (
    <SessionLanguageProvider language={entry?.plan.targetLanguage}>
      <Dialog open={entry !== null} onOpenChange={onOpenChange}>
        <DialogContent className="gap-0 overflow-hidden p-0 sm:max-w-lg">
          {entry !== null && (
            <>
              <DialogHeader className="px-6 pt-6 pb-4 text-left">
                <DialogTitle className="text-lg font-semibold tracking-tight">
                  {entry.goal?.trim() || titleFor(entry.plan)}
                </DialogTitle>
                {/* One line of facts; the old plan table under the body said
                    the same language again and then listed a form the
                    learner no longer fills in. */}
                <DialogDescription className="tabular-nums">
                  {formatDate(entry.startedAt)} ·{" "}
                  {formatClock(entry.secondsTalked)} talked ·{" "}
                  {LANGUAGE_NAMES[targetLanguage(entry.plan.targetLanguage)]}
                </DialogDescription>
              </DialogHeader>

              <div className="max-h-[60svh] [scrollbar-width:thin] [scrollbar-color:var(--border)_transparent] space-y-6 overflow-y-auto px-6 py-1">
                {/* What it BECAME: the worker's one line off the transcript,
                    against the goal in the title — what was set up. A plain
                    sentence, no label. Absent for a row the worker never
                    closed. */}
                {entry.about?.trim() && (
                  <p className="text-sm leading-relaxed text-foreground/80">
                    {entry.about.trim()}
                  </p>
                )}

                {/* And why it stopped, where that is worth saying. Absent for an
                  ordinary ending, and for every row that predates the field —
                  which is why a missing reason is never read as a clean end. */}
                <EndReasonNote reason={endReason} />

                <div>
                  <p className="text-sm font-medium text-foreground">
                    Mistakes
                  </p>
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
                            <CorrectionDiff
                              original={correction.original}
                              replacement={correction.replacement}
                            />
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

                {hasReviewMaterial(review) && (
                  <div>
                    <p className="text-sm font-medium text-foreground">
                      To review
                    </p>
                    <ReviewMaterialView
                      material={review}
                      focusTenses={entry.plan.tenses}
                      className="mt-3"
                    />
                  </div>
                )}

                {hasTranscript && (
                  <div className="pb-2">
                    {showTranscript ? (
                      <div className="space-y-6">
                        {/* The same two pieces the post-session summary
                            shows, from the same components: what the learner
                            asked, and what they had to look up. */}
                        <AsksList asks={record?.asks} />
                        <LookupsList lookups={record?.lookups} />
                        {transcript && transcript.length > 0 && (
                          <TranscriptRecord turns={transcript} />
                        )}
                      </div>
                    ) : (
                      <button
                        type="button"
                        onClick={() => setShowTranscript(true)}
                        className="cursor-pointer text-sm text-muted-foreground underline-offset-4 transition-colors hover:text-foreground hover:underline"
                      >
                        {transcript && transcript.length > 0
                          ? "Show the transcript"
                          : "Show what was asked and looked up"}
                      </button>
                    )}
                  </div>
                )}
              </div>

              <div className="flex items-center justify-end gap-4 border-t border-foreground/[0.06] px-6 py-4 dark:border-white/10">
                <Button onClick={() => onOpenChange(false)}>Done</Button>
              </div>
            </>
          )}
        </DialogContent>
      </Dialog>
    </SessionLanguageProvider>
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

/** Catalog labels where we have one, the stored value otherwise: a plan
 * written against an older catalog is still what the learner picked. */
function scenarioLabel(value: string): string {
  return SCENARIOS.find((option) => option.value === value)?.label ?? value
}

/** Stored as a plain string (see `convex/validators.ts`), so an unrecognized
 * category prints itself rather than blanking out. */
function categoryLabel(category: string): string {
  return CATEGORY_LABELS[category as CorrectionCategory] ?? category
}

/** Short and local: "Aug 24" — the same date the Billing dialog prints. */
function formatDate(ms: number): string {
  return new Date(ms).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
  })
}
