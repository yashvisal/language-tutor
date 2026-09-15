import { SignUp } from "@clerk/nextjs"

import { Spinner } from "@/components/spinner"

/** The sign-in page's twin — see the note there. */

export default function SignUpPage() {
  return (
    <div className="relative flex min-h-svh flex-col items-center justify-center px-6 py-12">
      <Spinner className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2" />
      <div className="relative">
        <SignUp />
      </div>
    </div>
  )
}
