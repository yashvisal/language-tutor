import { SignUp } from "@clerk/nextjs"

import { Wordmark } from "@/components/app-shell/wordmark"

/** The sign-in page's twin — see the note there. */
export default function SignUpPage() {
  return (
    <div className="flex min-h-svh flex-col items-center justify-center gap-8 px-6 py-12">
      <Wordmark href="/" />
      <SignUp />
    </div>
  )
}
