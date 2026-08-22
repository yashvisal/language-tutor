import { MarketingFooter } from "@/components/marketing/marketing-footer"
import { MarketingHeader } from "@/components/marketing/marketing-header"

/**
 * Placeholder until real terms exist — the footer links here, and a 404 from
 * a legal link reads worse than an honest stub.
 */
export default function TermsPage() {
  return (
    <div className="flex min-h-svh flex-col">
      <MarketingHeader />
      <main className="mx-auto w-full max-w-xl flex-1 px-6 py-24">
        <h1 className="text-2xl font-medium tracking-tight">Terms</h1>
        <p className="mt-4 text-sm text-muted-foreground">
          We&rsquo;re still writing these. Until then, the short version: be
          kind, don&rsquo;t abuse the service, and minutes you buy are yours —
          they never expire.
        </p>
      </main>
      <MarketingFooter />
    </div>
  )
}
