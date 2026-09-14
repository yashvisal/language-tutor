import Link from "next/link"
import { Show, SignUpButton } from "@clerk/nextjs"

import { CTA_LABEL } from "@/components/marketing/brand"
import { Button } from "@/components/ui/button"

/**
 * One call to action per page. Signed out it opens the Clerk sign-up modal;
 * signed in there is nothing to sell, so it becomes the way back to the app.
 */
export function PrimaryCta({
  size = "lg",
  label = CTA_LABEL,
}: {
  size?: "default" | "lg"
  /** The signed-out label. Defaults to the shared sentence with the free
   * minutes in it; a page that states the grant elsewhere can pass the bare
   * verb. */
  label?: string
}) {
  return (
    <Show
      when="signed-out"
      fallback={
        <Button size={size} render={<Link href="/home" />} nativeButton={false}>
          Continue where you left off
        </Button>
      }
    >
      <SignUpButton mode="modal">
        <Button size={size}>{label}</Button>
      </SignUpButton>
    </Show>
  )
}
