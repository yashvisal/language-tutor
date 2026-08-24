import { MarketingFooter } from "@/components/marketing/marketing-footer"
import { MarketingHeader } from "@/components/marketing/marketing-header"

/**
 * Placeholder until a real policy exists — the footer links here, and a 404
 * from a privacy link reads worse than an honest stub. Deliberately claim-free:
 * an unreviewed sentence about what we do with a learner's data is a promise we
 * have not checked. Real reviewed copy is a launch blocker.
 */
export default function PrivacyPage() {
  return (
    <div className="flex min-h-svh flex-col">
      <MarketingHeader />
      <main className="mx-auto w-full max-w-xl flex-1 px-6 py-24">
        <h1 className="text-2xl font-medium tracking-tight">Privacy</h1>
        <p className="mt-4 text-sm text-muted-foreground">
          The full policy is being written; it will be here before launch.
        </p>
      </main>
      <MarketingFooter />
    </div>
  )
}
