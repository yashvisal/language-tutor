"use client"

/**
 * Out of minutes before a session: one card, one line, one door.
 *
 * This is the 402 path — the token route refused before a room existed, so
 * there is no conversation and no review to promise a place in History, and
 * home is the only door. The other place the fact appears, over a conversation
 * the worker is holding at zero, is a modal inside the study surface
 * (`study-overlay.tsx`): that one offers End, which writes the outcome and
 * puts the row in History at once. "Back to home" used to be a plain link
 * there too, and an in-app navigation never told the session it was over:
 * nothing was written until the worker's own close half a minute later, and
 * History looked empty (Yash, 2026-09-10).
 *
 * Buying more will land in this card. Until then the only honest offer is the
 * way out.
 */

import type { RefObject } from "react"
import Link from "next/link"

import { CARD_CLASS } from "@/components/surface"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"

export function OutOfMinutesCard({
  className,
  linkRef,
  hasSession = true,
}: {
  className?: string
  /** Where focus lands when this card is the surface's only control. */
  linkRef?: RefObject<HTMLAnchorElement | null>
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
      <Button
        size="lg"
        className="mt-5"
        render={<Link ref={linkRef} href="/home" />}
        nativeButton={false}
      >
        Back to home
      </Button>
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
