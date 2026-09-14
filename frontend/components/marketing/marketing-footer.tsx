import Link from "next/link"
import { Show, SignInButton } from "@clerk/nextjs"

import { SUPPORT_EMAIL, WORDMARK } from "@/components/marketing/brand"

/**
 * Minimal footer: who we are, a way to reach a person, and the way in for
 * someone who already has an account. Nothing else belongs here.
 *
 * The year is read at render; these pages are static, so it is the year of
 * the build — close enough for a copyright line, and one less client
 * component.
 */
export function MarketingFooter() {
  const year = new Date().getFullYear()

  return (
    <footer className="border-t border-border/60">
      <div className="flex w-full flex-wrap items-center justify-between gap-3 px-6 py-8 text-xs text-muted-foreground sm:px-8">
        <span className="lowercase">
          © {year} {WORDMARK}
        </span>
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
          <a
            href={`mailto:${SUPPORT_EMAIL}`}
            className="underline-offset-4 transition-colors hover:text-foreground hover:underline"
          >
            Contact
          </a>
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
