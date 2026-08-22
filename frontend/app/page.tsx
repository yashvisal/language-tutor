import type { Metadata } from "next"

import { ACCENT_TEXT } from "@/components/marketing/brand"
import { MarketingFooter } from "@/components/marketing/marketing-footer"
import { MarketingHeader } from "@/components/marketing/marketing-header"
import { PricingPacks } from "@/components/marketing/pricing"
import { PrimaryCta } from "@/components/marketing/primary-cta"

export const metadata: Metadata = {
  title: "tutor — speak Spanish, uninterrupted",
  description:
    "A live Spanish tutor that keeps the conversation going. Your words appear as you speak them, and after your turn settles you see what you should have said.",
}

/**
 * Landing, variant 1 — conventional and restrained.
 *
 * One screen of typography: the thesis, one call to action, the loop in three
 * lines, and pricing kept quiet at the bottom. The accent blue appears twice —
 * on the CTA (the theme primary) and on the single corrected word.
 */
export default function LandingPage() {
  return (
    <div className="flex min-h-svh flex-col">
      <MarketingHeader />

      <main className="mx-auto w-full max-w-3xl flex-1 px-6">
        {/* Thesis */}
        <section className="pt-20 pb-16 sm:pt-28">
          <h1 className="max-w-2xl text-4xl leading-[1.1] font-medium tracking-tight text-balance sm:text-5xl">
            Speak Spanish with a tutor that lets you finish.
          </h1>
          <p className="mt-6 max-w-xl text-lg leading-relaxed text-muted-foreground">
            You talk, and the conversation keeps going. Your words appear as you
            say them. When a tense comes out wrong nobody stops you — once your
            turn settles you see what you should have said, and why, if you want
            to know.
          </p>

          <div className="mt-10">
            <PrimaryCta />
          </div>
          <p className="mt-4 text-xs text-muted-foreground">
            Spanish for now. Runs in your browser.
          </p>
        </section>

        {/* How it works — three lines, not cards */}
        <section
          aria-labelledby="how-heading"
          className="border-t border-border/70 py-14"
        >
          <h2
            id="how-heading"
            className="text-xs font-medium tracking-[0.18em] text-muted-foreground uppercase"
          >
            How it works
          </h2>

          <ol className="mt-6 max-w-xl space-y-5">
            <li className="text-base">
              <span className="font-medium">Speak.</span>{" "}
              <span className="text-muted-foreground">
                A voice tutor answers in Spanish, at conversation speed.
              </span>
            </li>
            <li className="text-base">
              <span className="font-medium">See your words.</span>{" "}
              <span className="text-muted-foreground">
                Both sides transcribe live, so you can follow without
                translating in your head.
              </span>
            </li>
            <li className="text-base">
              <span className="font-medium">
                See what you should have said.
              </span>{" "}
              <span className="text-muted-foreground">
                After the turn settles, quietly, in place.
              </span>
              <p className="mt-3 text-lg">
                Ayer yo{" "}
                <span className="text-muted-foreground line-through decoration-muted-foreground/40">
                  fue
                </span>{" "}
                <span className={ACCENT_TEXT}>fui</span> al supermercado.
              </p>
            </li>
          </ol>
        </section>

        {/* Pricing */}
        <section className="border-t border-border/70 py-14">
          <div className="max-w-xl">
            <PricingPacks />
          </div>
        </section>
      </main>

      <MarketingFooter />
    </div>
  )
}
