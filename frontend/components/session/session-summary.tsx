"use client"

/**
 * After the conversation.
 *
 * Two facts and two doors. The facts: how many minutes went, and what the
 * analyzer caught — the first time the session's corrections are seen all at
 * once rather than one utterance at a time. The doors: talk again, or buy more
 * minutes.
 *
 * Corrections are grouped by category because a category is a pattern a learner
 * can act on, where a flat list is a scorecard. No count of "mistakes", no
 * score, no streak: this is a record of what the tutor noticed, not a grade.
 */

import { MoveRight } from "lucide-react"

import { CATEGORY_STYLES } from "@/components/session/correction-mark"
import { Button } from "@/components/ui/button"
import { CATEGORY_LABELS, type SessionOutcome } from "@/lib/session/contract"
import { groupCorrections } from "@/lib/session/reducer"
import { cn } from "@/lib/utils"

export function SessionSummary({
  outcome,
  onStartAnother,
}: {
  outcome: SessionOutcome
  onStartAnother: () => void
}) {
  const groups = groupCorrections(outcome.corrections)
  const { minutesUsed } = outcome

  return (
    <div className="flex min-h-svh justify-center bg-background px-8 py-[clamp(3rem,12vh,7rem)]">
      <div className="w-full max-w-xl">
        <p className="text-[10px] tracking-[0.14em] text-muted-foreground/50 uppercase">
          {outcome.endedByClock ? "Time's up" : "Session ended"}
        </p>
        <h1 className="mt-3 text-xl tracking-[-0.015em] text-foreground">
          {minutesUsed === null
            ? "That's the session."
            : `You talked for ${minutesUsed} ${
                minutesUsed === 1 ? "minute" : "minutes"
              }.`}
        </h1>
        <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
          {minutesUsed === null
            ? "Nice work."
            : "Minutes are counted while you're talking — time spent paused is free."}
        </p>

        <section className="mt-10 border-t border-border/50 pt-8">
          {groups.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              Nothing came back from the analyzer this session.
            </p>
          ) : (
            <div className="space-y-8">
              {groups.map(({ category, corrections }) => (
                <div key={category}>
                  <p className="text-[10px] tracking-[0.14em] text-muted-foreground/50 uppercase">
                    {CATEGORY_LABELS[category]}
                  </p>
                  <ul className="mt-3 space-y-3">
                    {corrections.map((correction) => (
                      <li key={correction.id}>
                        <p
                          className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-sm"
                          lang="es"
                        >
                          <span className="text-muted-foreground line-through decoration-muted-foreground/40">
                            {correction.original}
                          </span>
                          <MoveRight
                            aria-hidden
                            className="size-3.5 shrink-0 text-muted-foreground/50"
                          />
                          <span
                            className={cn(
                              "font-medium",
                              CATEGORY_STYLES[category].accent
                            )}
                          >
                            {correction.replacement}
                          </span>
                        </p>
                        {correction.explanation && (
                          <p
                            className="mt-1 text-xs leading-relaxed text-muted-foreground/80"
                            lang="en"
                          >
                            {correction.explanation}
                          </p>
                        )}
                      </li>
                    ))}
                  </ul>
                </div>
              ))}
            </div>
          )}
        </section>

        <div className="mt-10 flex items-center gap-3 border-t border-border/50 pt-6">
          <Button size="lg" onClick={onStartAnother}>
            Start another session
          </Button>
          {/* TODO(stripe): Checkout for credit packs ($3.99 single, 5 for
              $15.99, 12 for $34.99), webhook writes the ledger grant. Disabled
              until payments land — the affordance is here so the summary's
              shape is the real one. */}
          <Button size="lg" variant="ghost" disabled>
            Buy more minutes
          </Button>
        </div>
      </div>
    </div>
  )
}
