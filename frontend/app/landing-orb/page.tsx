import type { Metadata } from "next"

import { DemoConversation } from "@/components/marketing/demo-conversation"
import { MarketingFooter } from "@/components/marketing/marketing-footer"
import { MarketingHeader } from "@/components/marketing/marketing-header"
import { PricingLine } from "@/components/marketing/pricing"
import { PrimaryCta } from "@/components/marketing/primary-cta"
import { Reveal } from "./reveal"

export const metadata: Metadata = {
  title: "tutor — speak Spanish, uninterrupted",
  description:
    "A live Spanish tutor that keeps the conversation going. Your words appear as you speak them, and after your turn settles you see what you should have said.",
}

/**
 * Landing, variant 2 — the Aura is the page.
 *
 * One headline, then the orb, large and alive, with a session playing beneath
 * it. Nothing competes: no columns, no tiles, the CTA directly under the demo.
 * Further down, the loop the product exists to produce and the price, each
 * surfacing as it scrolls into view.
 */
export default function LandingOrbPage() {
  return (
    <div className="flex min-h-svh flex-col">
      <MarketingHeader />

      <main className="flex-1">
        {/* Hero: headline, then the orb with the session under it. */}
        <section className="relative mx-auto flex w-full max-w-4xl flex-col items-center px-6 pt-20 pb-24 text-center sm:pt-24">
          <div
            aria-hidden
            className="pointer-events-none absolute top-1/3 left-1/2 -z-10 h-[44rem] w-[44rem] -translate-x-1/2 -translate-y-1/2 rounded-full bg-blue-500/10 blur-[120px] dark:bg-blue-500/15"
          />
          <h1 className="text-5xl leading-[1.05] font-semibold tracking-tight text-balance sm:text-6xl">
            Ten minutes of Spanish, out loud.
          </h1>
          <p className="mt-5 max-w-lg text-lg leading-relaxed text-balance text-muted-foreground">
            A tutor that answers naturally and never talks over you. The
            corrections wait until you have finished the thought.
          </p>

          <DemoConversation size="hero" className="mt-16 w-full max-w-2xl" />

          <div className="mt-14">
            <PrimaryCta />
          </div>
          <p className="mt-4 text-xs text-muted-foreground">
            Spanish for now. Runs in your browser.
          </p>
        </section>

        {/* The loop, verbatim from the vision doc — it is already the product. */}
        <section className="border-t border-border/60">
          <div className="mx-auto w-full max-w-4xl px-6 py-24">
            <Reveal>
              <p className="text-2xl leading-[1.8] font-medium tracking-tight text-muted-foreground sm:text-3xl">
                <span className="block">I speak Spanish.</span>
                <span className="block">I see my words appear.</span>
                <span className="block">The tutor responds naturally.</span>
                <span className="block">
                  I make a mistake, but nobody interrupts me.
                </span>
                <span className="block">
                  After I finish, I see what I should have said.
                </span>
                <span className="block text-foreground">
                  Then I keep talking.
                </span>
              </p>
            </Reveal>
          </div>
        </section>

        {/* Price and the way in. */}
        <section className="border-t border-border/60">
          <div className="mx-auto flex w-full max-w-4xl flex-col items-start gap-8 px-6 py-20 sm:flex-row sm:items-end sm:justify-between">
            <div>
              <p className="text-xs font-medium tracking-[0.18em] text-muted-foreground uppercase">
                Minutes
              </p>
              <p className="mt-3 text-2xl font-medium tracking-tight">
                Your first 10 minutes are free.
              </p>
              <PricingLine className="mt-4" />
            </div>
            <PrimaryCta />
          </div>
        </section>
      </main>

      <MarketingFooter />
    </div>
  )
}
