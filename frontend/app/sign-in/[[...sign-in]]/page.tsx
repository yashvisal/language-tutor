import type { Metadata } from "next"
import { SignIn } from "@clerk/nextjs"

import { Spinner } from "@/components/spinner"

/**
 * The Clerk component on our own page, with a spinner behind it.
 *
 * Clerk finishes a login by routing through here (the OAuth callback, the
 * continue step), and for that moment it renders nothing, so the page used
 * to show only the wordmark in the middle of nowhere (Yash, 2026-09-13).
 * The spinner sits under Clerk's card: visible whenever Clerk has nothing
 * to show, covered as soon as it does. `min-h-svh` is the height a phone
 * actually has (`min-h-screen` is the one it claims to have, under the
 * browser chrome).
 */
export const metadata: Metadata = {
  title: "Sign in",
}

export default function SignInPage() {
  return (
    <div className="relative flex min-h-svh flex-col items-center justify-center px-6 py-12">
      <Spinner className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2" />
      <div className="relative">
        <SignIn />
      </div>
    </div>
  )
}
