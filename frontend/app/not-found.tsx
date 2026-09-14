import Link from "next/link"

import { Button } from "@/components/ui/button"

/**
 * A URL that is not a page. Same plain surface as `error.tsx` — the theme's
 * background and foreground, so it reads in light and dark — one sentence and
 * the way back.
 */
export default function NotFound() {
  return (
    <main className="flex min-h-svh flex-col items-center justify-center gap-6 bg-background px-6 text-center">
      <p className="text-base text-foreground">There&rsquo;s nothing here.</p>
      <p className="max-w-sm text-sm text-muted-foreground">
        The page you asked for does not exist.
      </p>
      <Button variant="ghost" render={<Link href="/" />} nativeButton={false}>
        Go home
      </Button>
    </main>
  )
}
