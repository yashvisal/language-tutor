import Link from "next/link"
import { Show, SignInButton } from "@clerk/nextjs"

import { WORDMARK } from "@/components/marketing/brand"

/**
 * Minimal footer: who we are, and the way in for someone who already has an
 * account. Nothing else belongs here.
 */
export function MarketingFooter() {
  return (
    <footer className="border-t border-border/60">
      <div className="mx-auto flex w-full max-w-3xl flex-wrap items-center justify-between gap-3 px-6 py-8 text-xs text-muted-foreground">
        <span className="lowercase">{WORDMARK}</span>
        <div className="flex items-center gap-5">
          <Show when="signed-out">
            <SignInButton mode="modal">
              <button
                type="button"
                className="cursor-pointer underline-offset-4 transition-colors hover:text-foreground hover:underline"
              >
                Sign in
              </button>
            </SignInButton>
          </Show>
          <Show when="signed-in">
            <Link
              href="/home"
              className="underline-offset-4 transition-colors hover:text-foreground hover:underline"
            >
              Continue
            </Link>
          </Show>
          <Link
            href="/terms"
            className="underline-offset-4 transition-colors hover:text-foreground hover:underline"
          >
            Terms
          </Link>
          <Link
            href="/privacy"
            className="underline-offset-4 transition-colors hover:text-foreground hover:underline"
          >
            Privacy
          </Link>
        </div>
      </div>
    </footer>
  )
}
