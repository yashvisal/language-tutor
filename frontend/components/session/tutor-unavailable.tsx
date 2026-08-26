"use client"

/**
 * The tutor didn't join.
 *
 * Audit B6: the stage used to render on ROOM connection rather than on TUTOR
 * connection, so a worker that was down produced a live-looking screen with an
 * idle Aura, no clock and no transcript — forever, and indistinguishable from
 * a tutor thinking. A stranger's first session ending in that silence is fatal
 * to a beta.
 *
 * Same card, same voice as `out-of-minutes.tsx`, for the same reason: this is
 * a state the session is in, not a fault to apologize for. No red, no error
 * code, no stack trace. Two doors, and the one that matters is Try again —
 * a worker that is down for one dispatch is usually up for the next.
 *
 * The line about billing is not reassurance, it is the fact: the meter starts
 * at the first frame of tutor audio, and there was none.
 */

import Link from "next/link"

import { CARD_CLASS } from "@/components/surface"
import { Button } from "@/components/ui/button"
import type { TutorFailure } from "@/lib/session/live-producer"
import { cn } from "@/lib/utils"

export function TutorUnavailableCard({
  reason,
  onRetry,
  className,
}: {
  reason: TutorFailure
  onRetry: () => void
  className?: string
}) {
  return (
    <div className={cn(CARD_CLASS, className)}>
      <h2 className="text-base font-medium text-foreground">
        The tutor didn&rsquo;t join.
      </h2>
      <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
        {reason === "silent"
          ? "It connected but never spoke. Nothing was charged — the clock starts when the tutor does."
          : "Nothing was charged. Try again — this usually clears on the next attempt."}
      </p>
      <div className="mt-5 flex items-center gap-3">
        <Button size="lg" onClick={onRetry}>
          Try again
        </Button>
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
  )
}

/** The whole screen, which is where `/session` shows it: the stage never got
 * a conversation to put behind this. */
export function TutorUnavailableScreen({
  reason,
  onRetry,
}: {
  reason: TutorFailure
  onRetry: () => void
}) {
  return (
    <div className="flex min-h-svh items-center justify-center bg-background px-8">
      <TutorUnavailableCard
        reason={reason}
        onRetry={onRetry}
        className="w-full max-w-md"
      />
    </div>
  )
}
