import type { Metadata } from "next"

import { AmbientAura } from "@/components/marketing/ambient-aura"
import {
  CaptionFragment,
  CorrectionFragment,
  DemoConversation,
} from "@/components/marketing/demo-conversation"
import { MarketingFooter } from "@/components/marketing/marketing-footer"
import { MarketingHeader } from "@/components/marketing/marketing-header"
import { PricingNote, PricingPacks } from "@/components/marketing/pricing"
import { PrimaryCta } from "@/components/marketing/primary-cta"
import { Button } from "@/components/ui/button"

export const metadata: Metadata = {
  title: "tutor — speak Spanish, uninterrupted",
  description:
    "A live Spanish tutor that keeps the conversation going. Your words appear as you speak them, and after your turn settles you see what you should have said.",
}

/**
 * Landing, variant 1 — the conventional shape, with the product in the hero.
 *
 * Copy on the left, the session itself on the right: the Aura and one exchange
 * playing on a loop. Every illustration further down is a fragment of the real
 * session UI, not a drawing of it — the orb, a caption mid-transcription, the
 * inline correction. Blue appears where the product puts it: the orb's light,
 * the corrected word, the primary button.
 */
export default function LandingPage() {
  return (
    <div className="flex min-h-svh flex-col">
      <MarketingHeader />

      <main className="flex-1">
        {/* Hero */}
        <section className="mx-auto grid w-full max-w-6xl items-center gap-12 px-6 pt-16 pb-20 lg:min-h-[calc(100svh-3.5rem)] lg:grid-cols-[1.05fr_0.95fr] lg:gap-16 lg:pt-0 lg:pb-0">
          <div className="max-w-xl">
            <p className="text-xs font-medium tracking-[0.18em] text-blue-600 uppercase dark:text-blue-400">
              Live Spanish tutor
            </p>
            <h1 className="mt-4 text-5xl leading-[1.05] font-semibold tracking-tight text-balance sm:text-6xl">
              Speak Spanish with a tutor that lets you finish.
            </h1>
            <p className="mt-6 text-lg leading-relaxed text-muted-foreground">
              You talk, and the conversation keeps going. Your words appear as
              you say them. When a tense comes out wrong nobody stops you — once
              your turn settles you see what you should have said, and why.
            </p>
            <div className="mt-8 flex flex-wrap items-center gap-3">
              <PrimaryCta />
              <Button
                variant="ghost"
                size="lg"
                render={<a href="#how" />}
                nativeButton={false}
              >
                See how it works
              </Button>
            </div>
            <p className="mt-5 text-xs text-muted-foreground">
              Spanish for now. Runs in your browser — no app to install.
            </p>
          </div>

          {/* The product, live. */}
          <div className="relative">
            <div className="rounded-3xl border border-border/60 bg-card/40 px-6 py-10 shadow-sm backdrop-blur-sm sm:px-10 sm:py-14">
              <DemoConversation size="hero" />
            </div>
          </div>
        </section>

        {/* How it works — three fragments of the session */}
        <section
          id="how"
          aria-labelledby="how-heading"
          className="border-t border-border/60"
        >
          <div className="mx-auto w-full max-w-6xl px-6 py-20">
            <h2
              id="how-heading"
              className="text-xs font-medium tracking-[0.18em] text-muted-foreground uppercase"
            >
              How it works
            </h2>
            <ol className="mt-10 grid gap-10 md:grid-cols-3 md:gap-8">
              <li>
                <div className="flex h-24 items-center">
                  <AmbientAura state="listening" className="h-16" />
                </div>
                <h3 className="mt-6 text-lg font-medium tracking-tight">
                  Speak
                </h3>
                <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
                  A voice tutor answers in Spanish, at conversation speed. It
                  listens for as long as you need.
                </p>
              </li>
              <li>
                <div className="flex h-24 items-center">
                  <CaptionFragment />
                </div>
                <h3 className="mt-6 text-lg font-medium tracking-tight">
                  See your words
                </h3>
                <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
                  Both sides are transcribed live, so you can follow without
                  translating in your head.
                </p>
              </li>
              <li>
                <div className="flex h-24 items-center">
                  <CorrectionFragment />
                </div>
                <h3 className="mt-6 text-lg font-medium tracking-tight">
                  See what you should have said
                </h3>
                <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
                  After your turn settles, the fix appears in place — quietly,
                  with the reason if you want it.
                </p>
              </li>
            </ol>
          </div>
        </section>

        {/* Pricing */}
        <section
          aria-labelledby="pricing-heading"
          className="border-t border-border/60"
        >
          <div className="mx-auto w-full max-w-6xl px-6 py-20">
            <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
              <div>
                <h2
                  id="pricing-heading"
                  className="text-xs font-medium tracking-[0.18em] text-muted-foreground uppercase"
                >
                  Minutes
                </h2>
                <p className="mt-3 text-2xl font-medium tracking-tight">
                  Your first 10 minutes are free.
                </p>
              </div>
              <PricingNote />
            </div>
            <PricingPacks className="mt-8" />
          </div>
        </section>

        {/* Closing */}
        <section className="border-t border-border/60">
          <div className="mx-auto flex w-full max-w-6xl flex-col items-center px-6 py-24 text-center">
            <div className="relative h-20">
              <div
                aria-hidden
                className="pointer-events-none absolute inset-0 -z-10 scale-150 rounded-full bg-blue-500/15 blur-2xl"
              />
              <AmbientAura state="listening" className="h-full" />
            </div>
            <h2 className="mt-8 text-3xl font-semibold tracking-tight text-balance sm:text-4xl">
              Ten minutes of Spanish, out loud.
            </h2>
            <p className="mt-3 max-w-md text-muted-foreground">
              No lesson, no quiz. A conversation that waits for you to finish.
            </p>
            <div className="mt-8">
              <PrimaryCta />
            </div>
          </div>
        </section>
      </main>

      <MarketingFooter />
    </div>
  )
}
