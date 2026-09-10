import { SignIn } from "@clerk/nextjs"

import { Wordmark } from "@/components/app-shell/wordmark"

/**
 * The Clerk component on our own page, not floating in a white void: the
 * wordmark at the top says whose sign-in this is, and `min-h-svh` is the
 * height a phone actually has (`min-h-screen` is the one it claims to have,
 * under the browser chrome).
 */
export default function SignInPage() {
  return (
    <div className="flex min-h-svh flex-col items-center justify-center gap-8 px-6 py-12">
      <Wordmark href="/" />
      <SignIn />
    </div>
  )
}
