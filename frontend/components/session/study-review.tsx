"use client"

/**
 * REVIEW — the session's material, not a lesson.
 *
 * It used to be a fixture: the plan named a scenario and some forms, the worker
 * turned that into one set of vocabulary, phrases and tables, and that was the
 * session's Review from beginning to end. From phase 7 step 3 it is generated
 * from the CONFIRMED GOAL and regenerated from the transcript when the
 * conversation has earned new material — so this tab is a live document, and
 * the worker tells it so by bumping `tutor.review_version` (`useStudy` owns the
 * fetching; see the push note there).
 *
 * Two consequences for what is rendered here:
 *
 * - The goal sits at the top, and only here. The stage stays minimal — the
 *   screen during a conversation carries the current moment and nothing else —
 *   but a pause is exactly when "what are we doing today" is worth a line.
 * - New material arrives UNDER a learner who is reading. The old snapshot stays
 *   until the new one lands, and the only announcement is one muted word that
 *   fades. No toast, no badge, nothing to dismiss.
 *
 * This file owns only those states. The typesetting is `review-material.tsx`,
 * shared with the post-session summary and the History modal, so the same
 * material cannot look like three different things depending on where the
 * learner meets it.
 */

import { useEffect, useState } from "react"

import { Overline } from "@/components/overline"
import {
  ReviewMaterialView,
  hasReviewMaterial,
} from "@/components/session/review-material"
import { Shimmer } from "@/components/session/translate-overlay"
import type { ReviewState } from "@/lib/session/contract"
import { ANCHOR_LANGUAGE, REVIEW_UPDATED_MS } from "@/lib/session/protocol"
import { cn } from "@/lib/utils"

export function ReviewTab({
  review,
  /** The session's confirmed goal, one line. Absent until there is one. */
  goal = null,
  /** Plan focus forms, hoisted to the top of the tables. */
  focusTenses = [],
}: {
  review: ReviewState
  goal?: string | null
  focusTenses?: readonly string[]
}) {
  const { material, absent, updatedAt } = review

  /**
   * The marker, for as long as it is worth wearing. State records which update
   * has EXPIRED rather than whether one is showing, for two reasons: a second
   * refresh while the marker is still up restarts it instead of being
   * swallowed, and an update that happened while this tab was closed (the
   * material is fetched whether or not the overlay is mounted) is already
   * expired on the first render, so re-opening a hold does not replay an
   * announcement about material the learner has not been away from.
   */
  const [expired, setExpired] = useState<number | null>(() =>
    updatedAt !== null && Date.now() - updatedAt >= REVIEW_UPDATED_MS
      ? updatedAt
      : null
  )
  const updated = updatedAt !== null && expired !== updatedAt
  useEffect(() => {
    if (!updated || updatedAt === null) return
    const remaining = Math.max(0, REVIEW_UPDATED_MS - (Date.now() - updatedAt))
    const timer = setTimeout(() => setExpired(updatedAt), remaining)
    return () => clearTimeout(timer)
  }, [updated, updatedAt])

  return (
    <div className="pt-2">
      {/* Always mounted, so the live region below is there BEFORE it has
          anything to say — a region inserted at the same moment as its content
          is a region screen readers may never announce. */}
      <div
        className={cn(
          "flex items-baseline justify-between gap-4",
          (goal || updated) && "pb-6"
        )}
      >
        {goal ? (
          <div className="min-w-0">
            <Overline>Today</Overline>
            <p
              lang={ANCHOR_LANGUAGE}
              className="mt-1.5 text-sm leading-relaxed text-foreground"
            >
              {goal}
            </p>
          </div>
        ) : (
          <span />
        )}
        {/* One word, and it leaves on its own. The fade is a transition rather
            than an animation so `motion-reduce` can simply switch it off —
            there is nothing to see, only something to stop seeing. */}
        <span role="status" aria-live="polite" className="shrink-0">
          <span
            aria-hidden={!updated}
            className={cn(
              "text-xs text-muted-foreground transition-opacity duration-700 motion-reduce:transition-none",
              updated ? "opacity-100" : "opacity-0"
            )}
          >
            Updated
          </span>
        </span>
      </div>

      {/* Waiting is the absence of material, and it only ever shimmers before
          the FIRST snapshot: a regeneration behind material already on screen
          leaves the page exactly where the learner was reading it. */}
      {material === null && !absent ? (
        <div className="pt-4">
          <Shimmer lines={4} className="gap-3" />
        </div>
      ) : !hasReviewMaterial(material) ? (
        // Nothing came, or something came with nothing in it. A learner cannot
        // tell those apart and should not have to: one quiet line, no retry.
        <p className="pt-16 text-sm text-muted-foreground">
          No material for this session yet.
        </p>
      ) : (
        <ReviewMaterialView material={material} focusTenses={focusTenses} />
      )}
    </div>
  )
}
