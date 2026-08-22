import Link from "next/link"
import { Show, SignInButton, SignUpButton, UserButton } from "@clerk/nextjs"

import { ThemeToggle } from "@/components/design/theme-toggle"
import { WORDMARK } from "@/components/marketing/brand"
import { Button } from "@/components/ui/button"

/**
 * The only chrome a public page gets: the wordmark, and the one way in.
 *
 * Auth is modal from every entry point (phase-5 decision), so both buttons
 * open Clerk in place rather than navigating to /sign-in or /sign-up. A
 * signed-in visitor gets a way back into the product instead.
 */
export function MarketingHeader() {
  return (
    <header className="sticky top-0 z-30 border-b border-border/60 bg-background/80 backdrop-blur-sm">
      <div className="mx-auto flex h-14 w-full max-w-6xl items-center justify-between px-6">
        <Link
          href="/"
          className="text-sm font-medium tracking-tight lowercase transition-opacity hover:opacity-70"
        >
          {WORDMARK}
        </Link>

        <nav className="flex items-center gap-1.5">
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
            <UserButton />
          </Show>
          <ThemeToggle />
        </nav>
      </div>
    </header>
  )
}
