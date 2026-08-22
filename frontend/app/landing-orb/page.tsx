import type { Metadata } from "next"

import { MarketingFooter } from "@/components/marketing/marketing-footer"
import { MarketingHeader } from "@/components/marketing/marketing-header"
import { PricingLine } from "@/components/marketing/pricing"
import { PrimaryCta } from "@/components/marketing/primary-cta"
import { OrbStage } from "./orb-stage"

export const metadata: Metadata = {
  title: "tutor — speak Spanish, uninterrupted",
  description:
    "A live Spanish tutor that keeps the conversation going. Your words appear as you speak them, and after your turn settles you see what you should have said.",
}

/**
 * Landing, variant 2 — the Aura is the page.
 *
 * The scroll-driven stage does the arguing (`orb-stage.tsx`); everything after
 * it is quiet text: the loop the product exists to produce, one call to
 * action, and the pack prices in a single line.
 */
export default function LandingOrbPage() {
  return (
    <div className="flex min-h-svh flex-col">
      <MarketingHeader />

      <main className="flex-1">
        <OrbStage />

        {/* The loop, verbatim from the vision doc — it is already the product. */}
        <section className="mx-auto w-full max-w-3xl px-6 py-24">
          <p className="text-lg leading-[2] text-muted-foreground">
            <span className="block">I speak Spanish.</span>
            <span className="block">I see my words appear.</span>
            <span className="block">The tutor responds naturally.</span>
            <span className="block">
              I make a mistake, but nobody interrupts me.
            </span>
            <span className="block">
              After I finish, I subtly see what I should have said.
            </span>
            <span className="block">I can understand why if I want to.</span>
            <span className="block">
              I can reveal translation if I need it.
            </span>
            <span className="block text-foreground">Then I keep talking.</span>
          </p>
        </section>

        {/* One call to action, and what it costs after the free minutes. */}
        <section className="mx-auto w-full max-w-3xl border-t border-border/70 px-6 py-16">
          <PrimaryCta />
          <div className="mt-10">
            <PricingLine />
          </div>
        </section>
      </main>

      <MarketingFooter />
    </div>
  )
}
