import type { ReactNode } from "react"

import { MarketingFooter } from "@/components/marketing/marketing-footer"
import { MarketingHeader } from "@/components/marketing/marketing-header"
import { Overline } from "@/components/overline"

/**
 * The shared frame for Terms and Privacy: the marketing chrome, one narrow
 * measure, and one set of type rules for the only two documents in the
 * product that are mostly prose.
 *
 * The prose styling lives here as descendant selectors rather than a class on
 * every heading and paragraph, so the two pages stay readable as writing —
 * the copy is the thing being reviewed, and it should not be buried in
 * markup. `max-w-xl` matches the rest of the marketing pages.
 *
 * `draft` renders the muted line that says these have not been signed off.
 * It comes off when they have; nothing else about the page changes.
 */
export function LegalPage({
  title,
  lastUpdated,
  draft = false,
  children,
}: {
  title: string
  lastUpdated: string
  draft?: boolean
  children: ReactNode
}) {
  return (
    <div className="flex min-h-svh flex-col">
      <MarketingHeader />
      <main className="mx-auto w-full max-w-xl flex-1 px-6 py-24">
        <Overline>Last updated: {lastUpdated}</Overline>
        <h1 className="mt-3 text-2xl font-medium tracking-tight">{title}</h1>
        {draft && (
          <p className="mt-2 text-sm text-muted-foreground">
            Draft — under review.
          </p>
        )}
        <div
          className={
            "mt-10 text-sm leading-relaxed text-muted-foreground " +
            "[&_h2]:mt-10 [&_h2]:mb-2 [&_h2]:text-base [&_h2]:font-medium [&_h2]:tracking-tight [&_h2]:text-foreground " +
            "[&_li]:list-disc [&_li]:marker:text-border [&_p]:mt-3 [&_ul]:mt-3 [&_ul]:space-y-1.5 [&_ul]:pl-5 " +
            "[&_a]:text-foreground [&_a]:underline [&_a]:underline-offset-4"
          }
        >
          {children}
        </div>
      </main>
      <MarketingFooter />
    </div>
  )
}
