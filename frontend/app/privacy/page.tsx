import { MarketingFooter } from "@/components/marketing/marketing-footer"
import { MarketingHeader } from "@/components/marketing/marketing-header"

/**
 * Placeholder until a real policy exists — the footer links here, and a 404
 * from a privacy link reads worse than an honest stub.
 */
export default function PrivacyPage() {
  return (
    <div className="flex min-h-svh flex-col">
      <MarketingHeader />
      <main className="mx-auto w-full max-w-xl flex-1 px-6 py-24">
        <h1 className="text-2xl font-medium tracking-tight">Privacy</h1>
        <p className="mt-4 text-sm text-muted-foreground">
          We&rsquo;re still writing the full policy. The short version: your
          conversations are processed to run the session and generate your
          feedback, and we don&rsquo;t sell your data.
        </p>
      </main>
      <MarketingFooter />
    </div>
  )
}
