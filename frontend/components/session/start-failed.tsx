"use client"

/**
 * A start that failed before there was a room: a blocked microphone, a
 * refused token, a network that never answered. One sentence with the fix
 * in it, the way `describeStartError` wrote it, and two ways out.
 *
 * Same card, same voice as `tutor-unavailable.tsx`. `/session` shows this
 * rather than falling back to a pre-flight of its own: the pre-flight lives
 * on `/home`, and there is exactly one.
 */

import Link from "next/link"

import { CARD_CLASS } from "@/components/surface"
import { Button } from "@/components/ui/button"
import type { StartFailure } from "@/lib/session/livekit"
import { cn } from "@/lib/utils"

export function StartFailedScreen({
  error,
  onRetry,
}: {
  error: StartFailure
  /** Dial the same plan again, or `null` when there is no plan to redial. */
  onRetry: (() => void) | null
}) {
  return (
    <div className="flex min-h-svh items-center justify-center bg-background px-8">
      <div className={cn(CARD_CLASS, "w-full max-w-md")}>
        <h2 className="text-base font-medium text-foreground">
          Couldn&rsquo;t start the session.
        </h2>
        <p
          role="alert"
          className="mt-2 text-sm leading-relaxed text-muted-foreground"
        >
          {error.message}
          {error.action && (
            <>
              {" "}
              <Link
                href={error.action.href}
                className="text-foreground underline decoration-foreground/30 underline-offset-4 transition-colors duration-200 hover:decoration-foreground"
              >
                {error.action.label}
              </Link>
            </>
          )}
        </p>
        <div className="mt-5 flex items-center gap-3">
          {onRetry && (
            <Button size="lg" onClick={onRetry}>
              Try again
            </Button>
          )}
          <Button
            size="lg"
            variant={onRetry ? "ghost" : "default"}
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
