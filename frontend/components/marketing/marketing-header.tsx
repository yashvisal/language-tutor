import Link from "next/link"
import { Show, SignInButton, SignUpButton, UserButton } from "@clerk/nextjs"

import { Wordmark } from "@/components/app-shell/wordmark"
import { ThemeToggle } from "@/components/theme-toggle"
import { Button } from "@/components/ui/button"

/**
 * The only chrome a public page gets: the wordmark, and the one way in.
 *
 * Auth is modal from every entry point (phase-5 decision), so both buttons
 * open Clerk in place rather than navigating to /sign-in or /sign-up. A
 * signed-in visitor gets a way back into the product instead.
 *
 * Same bar as the app's (`AppHeader`): full width, the wordmark at one edge
 * and the controls at the other, so crossing from the landing into the
 * product moves nothing. The centred column it had before put the two ends
 * mid-screen on a wide laptop (Yash, 2026-09-11).
 */
export function MarketingHeader() {
  return (
    <header className="sticky top-0 z-30 border-b border-border/60 bg-background/80 backdrop-blur-sm">
      <div className="flex h-14 w-full items-center justify-between px-6 sm:px-8">
        <Wordmark href="/" />

        <nav className="flex items-center gap-1">
          <Show when="signed-out">
            <SignInButton mode="modal">
              <Button variant="ghost" size="sm">
                Sign in
              </Button>
            </SignInButton>
            <SignUpButton mode="modal">
              <Button size="sm">Start speaking</Button>
            </SignUpButton>
          </Show>
          <Show when="signed-in">
            <Button
              variant="ghost"
              size="sm"
              render={<Link href="/home" />}
              nativeButton={false}
            >
              Continue
            </Button>
          </Show>
          <ThemeToggle />
          <Show when="signed-in">
            <UserButton />
          </Show>
        </nav>
      </div>
    </header>
  )
}
