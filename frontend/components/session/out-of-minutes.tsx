"use client"

/**
 * Out of minutes: one card, one line, one door.
 *
 * The same card in the two places the fact can appear — over a conversation the
 * worker is holding at zero, and in front of a session that never started
 * because the token route said 402. One component because it is one sentence,
 * and the learner should not be able to tell that the two moments are different
 * code paths.
 *
 * Buying more will land in this card. Until then the only honest offer is to
 * end the session — over a conversation, the same thing the End button does,
 * which writes the outcome and puts the row in History at once. "Back to
 * home" used to be a plain link here, and an in-app navigation never told
 * the session it was over: nothing was written until the worker's own close
 * half a minute later, and History looked empty (Yash, 2026-09-10). Before a
 * session (the 402 screen) there is nothing to end, and home is the door.
 *
 * The second line used to promise the transcript and review were "saved in
 * this session", which was true only until the tab closed. Since the worker
 * writes both to the `sessions` row at teardown (`sessions.recordSummary`) and
 * History renders them, the promise is now the one the code keeps.
 */

import type { RefObject } from "react"
import Link from "next/link"

import { CARD_CLASS } from "@/components/surface"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"

export function OutOfMinutesCard({
  className,
  linkRef,
  endRef,
  onEnd,
  hasSession = true,
}: {
  className?: string
  /** Where focus lands when this card is the surface's only control. */
  linkRef?: RefObject<HTMLAnchorElement | null>
  endRef?: RefObject<HTMLButtonElement | null>
  /** End the session the way the End button does. Given over a conversation;
   * absent on the pre-session screen, where the door is home. */
  onEnd?: () => void
  /** False when the token route refused before a room existed: there is no
   * conversation and no review to promise a place in History. */
  hasSession?: boolean
}) {
  return (
    <div className={cn(CARD_CLASS, className)}>
      <h2 className="text-base font-medium text-foreground">
        You&rsquo;re out of minutes.
      </h2>
      <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
        {hasSession
          ? "Buying more will land here. For now, end the session — this conversation and its review go to your history."
          : "You need minutes to start a conversation. Buying more will land here; for now, head home."}
      </p>
      {onEnd ? (
        <Button size="lg" className="mt-5" ref={endRef} onClick={onEnd}>
          End session
        </Button>
      ) : (
        <Button
          size="lg"
          className="mt-5"
          render={<Link ref={linkRef} href="/home" />}
          nativeButton={false}
        >
          Back to home
        </Button>
      )}
    </div>
  )
}

/** The whole screen, for a session that could not start at all. */
export function OutOfMinutesScreen() {
  return (
    <div className="flex min-h-svh items-center justify-center bg-background px-8">
      <OutOfMinutesCard className="w-full max-w-md" hasSession={false} />
    </div>
  )
}
