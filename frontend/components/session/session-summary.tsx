"use client"

/**
 * After the conversation. The summary IS the review.
 *
 * It used to be two facts and two doors: how long the learner talked and what
 * the analyzer caught. Everything else the session produced — what it was
 * actually about, the vocabulary and phrases and tables the Review tab had
 * been showing, the transcript — lived in browser memory and died with the
 * tab, while `out-of-minutes.tsx` promised the opposite.
 *
 * So this screen renders TWO sources and prefers whichever is more complete:
 *
 * 1. The client's `SessionOutcome`, assembled at the instant of ending. It is
 *    here immediately, and it is the only half that knows the exact metered
 *    seconds and whether the clock ended the session.
 * 2. `sessions.byRoom`, reactive, which is where the worker's teardown report
 *    lands a few seconds later: the one-line "what this was about", the Review
 *    snapshot, the transcript. The screen fills in around the learner rather
 *    than making them wait for it — and rather than showing them nothing,
 *    which is what a non-reactive read would do.
 *
 * The History modal reads the same record through the same components
 * (`review-material.tsx`, `transcript-record.tsx`), so the two surfaces cannot
 * tell different stories about one conversation.
 *
 * Corrections are grouped by category because a category is a pattern a
 * learner can act on, where a flat list is a scorecard. No count of "mistakes",
 * no score, no streak: this is a record of what the tutor noticed, not a grade.
 */

import Link from "next/link"
import { MoveRight } from "lucide-react"
import { useQuery } from "convex/react"

import { Overline } from "@/components/overline"
import { CATEGORY_STYLES } from "@/components/session/correction-mark"
import {
  ReviewMaterialView,
  hasReviewMaterial,
} from "@/components/session/review-material"
import {
  AsksList,
  EndReasonNote,
  GoalLine,
  LookupsList,
  endReasonNote,
} from "@/components/session/session-record"
import { TranscriptRecord } from "@/components/session/transcript-record"
import { Button } from "@/components/ui/button"
import { api } from "@/convex/_generated/api"
import { formatClock } from "@/lib/billing"
import {
  CATEGORY_LABELS,
  type Correction,
  type SessionOutcome,
} from "@/lib/session/contract"
import { ANCHOR_LANGUAGE, TARGET_LANGUAGE } from "@/lib/session/protocol"
import { groupCorrections } from "@/lib/session/reducer"
import { cn } from "@/lib/utils"

export function SessionSummary({
  outcome,
  onStartAnother,
}: {
  outcome: SessionOutcome
  onStartAnother: () => void
}) {
  /**
   * The worker's half of the record. `"skip"` for a session that never got a
   * room — there is nothing to look up, and the client's outcome is the whole
   * story. Reactive: the teardown report lands after `finish` does, and this
   * screen is already on the learner's monitor when it arrives.
   */
  const record = useQuery(
    api.sessions.byRoom,
    outcome.room === null ? "skip" : { room: outcome.room }
  )

  /**
   * The client's corrections win — they are the complete set, streamed to this
   * browser one turn at a time. The stored ones are the worker's backstop for
   * a tab that never reached `finish`, and this tab plainly did; they only
   * matter when the client somehow ended with none, which is what a summary
   * re-mounted after a reload looks like.
   */
  const corrections: Correction[] =
    outcome.corrections.length > 0
      ? outcome.corrections
      : ((record?.outcome?.corrections as Correction[] | undefined) ?? [])
  const groups = groupCorrections(corrections)

  /**
   * The meter, from whichever half can prove it. The client reads the agent's
   * last `tutor.elapsed_s`, which is absent when the agent left before
   * publishing one — and in exactly that case the ledger still knows what was
   * billed. Two surfaces disagreeing about the length of one conversation is
   * the failure this avoids.
   */
  const secondsTalked =
    outcome.secondsTalked ??
    (record && record.secondsBilled > 0 ? record.secondsBilled : null)

  const about = record?.about ?? null
  const review = record?.review ?? null
  const transcript = record?.transcript ?? null
  const goal = record?.goal?.text ?? null

  /**
   * Why it stopped, as the WORKER saw it — the only half that can tell a
   * goodbye from a crash. It arrives with the teardown report, so it appears a
   * moment after the screen does, and it replaces the client's own guess
   * (`endedUnexpectedly`) whenever it has something to say: "the connection
   * dropped" printed twice, once vaguely and once precisely, is two surfaces
   * disagreeing about one conversation.
   */
  const ending = endReasonNote(record?.endReason)

  return (
    <div className="flex min-h-svh justify-center bg-background px-8 py-[clamp(3rem,12vh,7rem)]">
      <div className="w-full max-w-xl">
        <Overline>
          {outcome.endedByClock ? "Time's up" : "Session ended"}
        </Overline>
        <h1 className="mt-3 text-xl tracking-[-0.015em] text-foreground">
          {secondsTalked === null
            ? "That's the session."
            : `You talked for ${formatClock(secondsTalked)}.`}
        </h1>

        {/* What the conversation was SET UP to be, against `about`'s what it
            became. One line, the one the tutor and the learner agreed on at
            the top of the session; absent for a session that never got that
            far, and for every session recorded before step 3. */}
        <GoalLine goal={goal} className="mt-6" />

        {/* What this was about, from the transcript rather than the plan — so
            it describes the conversation that happened, not the one that was
            declared. Absent until the worker's report lands, and absent
            forever for a session too short to have been about anything. */}
        {about && (
          <p
            className={cn(
              "text-sm leading-relaxed text-foreground",
              goal ? "mt-4" : "mt-2"
            )}
          >
            {about}
          </p>
        )}

        <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
          {secondsTalked === null
            ? "Nice work."
            : "That's what you were charged for — time spent paused is free."}
        </p>

        {/* Why it ended, when that is worth a sentence. One quiet line in the
            ordinary voice — nothing was lost, and a red banner would make an
            ordinary network blip feel like a fault (audit B5). The worker's
            stored reason is the precise one; the client's `endedUnexpectedly`
            is the fallback for a record that has not landed (or never will). */}
        {ending !== null ? (
          <EndReasonNote reason={record?.endReason} className="mt-2" />
        ) : (
          outcome.endedUnexpectedly && (
            <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
              The connection dropped — here&rsquo;s what we have.
            </p>
          )
        )}

        <section className="mt-10 border-t border-border/50 pt-8">
          <Overline>What the tutor caught</Overline>
          {groups.length === 0 ? (
            <p className="mt-3 text-sm text-muted-foreground">
              Nothing came back from the analyzer this session.
            </p>
          ) : (
            <div className="mt-3 space-y-8">
              {groups.map(({ category, corrections: group }) => (
                <div key={category}>
                  <Overline>{CATEGORY_LABELS[category]}</Overline>
                  <ul className="mt-3 space-y-3">
                    {group.map((correction) => (
                      <li key={correction.id}>
                        <p
                          className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-sm"
                          lang={TARGET_LANGUAGE}
                        >
                          <span className="text-muted-foreground line-through decoration-muted-foreground/40">
                            {correction.original}
                          </span>
                          <MoveRight
                            aria-hidden
                            className="size-3.5 shrink-0 text-muted-foreground"
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
                            className="mt-1 text-xs leading-relaxed text-muted-foreground"
                            lang={ANCHOR_LANGUAGE}
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

        {/* What the learner reached for mid-conversation. Both of these used
            to die with the tab: the questions lived in a thread the overlay
            owned, and the lookups in an overlay that unmounted on resume. They
            are the sharpest study record a session produces. */}
        {record?.asks && record.asks.length > 0 && (
          <AsksList
            asks={record.asks}
            className="mt-10 border-t border-border/50 pt-8"
          />
        )}
        {record?.lookups && record.lookups.length > 0 && (
          <LookupsList
            lookups={record.lookups}
            className="mt-10 border-t border-border/50 pt-8"
          />
        )}

        {/* The material the Review tab was showing mid-session, now kept. It
            arrives with the worker's report, so this section simply appears —
            there is nothing to wait for and nothing to announce. */}
        {hasReviewMaterial(review) && (
          <section className="mt-10 border-t border-border/50 pt-8">
            <Overline>To review</Overline>
            <ReviewMaterialView
              material={review}
              focusTenses={outcome.plan.tenses}
              className="mt-5"
            />
          </section>
        )}

        {transcript && transcript.length > 0 && (
          <section className="mt-10 border-t border-border/50 pt-8">
            <TranscriptRecord turns={transcript} />
          </section>
        )}

        <div className="mt-10 flex items-center gap-3 border-t border-border/50 pt-6">
          <Button size="lg" onClick={onStartAnother}>
            Start another session
          </Button>
          {/* The way out. `/session` was a cul-de-sac otherwise — browser-back
              was the only route home from the end of a conversation. Buying
              minutes lands here when payments do; a disabled button promising
              a purchase nobody can make was worse than no button. */}
          <Button
            size="lg"
            variant="ghost"
            render={<Link href="/home" />}
            nativeButton={false}
          >
            Back to home
          </Button>
        </div>
      </div>
    </div>
  )
}
