"use client"

import { useEffect } from "react"
import Link from "next/link"

import { Button } from "@/components/ui/button"

/**
 * The page that appears when a route throws.
 *
 * Deliberately plain: no header, no Clerk, no Convex — an error boundary that
 * needs providers to render is an error boundary that can fail for the same
 * reason its child did. The whole surface is the landing's own type and
 * colours (Geist through the root layout, `bg-background`/`text-foreground`,
 * so light and dark both follow the theme the visitor already had), one
 * sentence, and two ways out: try the page again, or go home.
 *
 * `retry()` rather than `reset()` (Next 16): retry re-fetches and re-renders
 * the boundary's children, which is what recovers a page that threw on data.
 * `reset()` only clears the error state and would replay the same failure.
 */
export default function Error({
  error,
  retry,
}: {
  error: Error & { digest?: string }
  retry: () => void
}) {
  useEffect(() => {
    // Until error reporting lands (launch checklist A11), the console is the
    // only record that this happened.
    console.error(error)
  }, [error])

  return (
    <main className="flex min-h-svh flex-col items-center justify-center gap-6 bg-background px-6 text-center">
      <p className="text-base text-foreground">Something went wrong.</p>
      <p className="max-w-sm text-sm text-muted-foreground">
        The page stopped before it finished. Trying again usually settles it.
      </p>
      <div className="flex flex-col items-center gap-3 sm:flex-row">
        <Button onClick={() => retry()}>Try again</Button>
        <Button variant="ghost" render={<Link href="/" />} nativeButton={false}>
          Go home
        </Button>
      </div>
    </main>
  )
}
