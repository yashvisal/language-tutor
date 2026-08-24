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
 * Buying more will land in this card. Until then the only honest offer is the
 * way home, so that is the only button: an offer nobody can accept is worse
 * than no offer.
 */

import type { RefObject } from "react"
import Link from "next/link"

import { CARD_CLASS } from "@/components/surface"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"

export function OutOfMinutesCard({
  className,
  linkRef,
}: {
  className?: string
  /** Where focus lands when this card is the surface's only control. */
  linkRef?: RefObject<HTMLAnchorElement | null>
}) {
  return (
    <div className={cn(CARD_CLASS, className)}>
      <h2 className="text-base font-medium text-foreground">
        You&rsquo;re out of minutes.
      </h2>
      <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
        Buying more will land here. For now, head home — your transcript and
        review are saved in this session.
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
      <OutOfMinutesCard className="w-full max-w-md" />
    </div>
  )
}
