import type { Metadata } from "next"

import { AmbientAura } from "@/components/marketing/ambient-aura"
import {
  AnswerFragment,
  DemoConversation,
  FixFragment,
  SpeakFragment,
} from "@/components/marketing/demo-conversation"
import { MarketingFooter } from "@/components/marketing/marketing-footer"
import { MarketingHeader } from "@/components/marketing/marketing-header"
import { PricingNote, PricingPacks } from "@/components/marketing/pricing"
import { PrimaryCta } from "@/components/marketing/primary-cta"
import { Reveal } from "@/components/marketing/reveal"
import { SIGNUP_GRANT_MINUTES } from "@/lib/billing"
import { LANGUAGE_NAMES, TARGET_LANGUAGES } from "@/lib/session/plan"

export const metadata: Metadata = {
  title: "tutor — practice languages, uninterrupted",
  description:
    "A live language tutor that keeps the conversation going. Your words appear as you speak them, and after your turn settles you see what you should have said.",
}

const LANGUAGES = TARGET_LANGUAGES.map(({ code, native }) => ({
  name: LANGUAGE_NAMES[code],
  native,
}))

/**
 * The landing page. The Aura is the hero — the product, playing by itself —
 * then how it works as three miniatures of the same stage, the languages,
 * the minutes, and the way in. Blue appears where the product puts it: the
 * orb's light, the corrected word, the primary button.
 */
export default function LandingPage() {
  return (
    <div className="flex min-h-svh flex-col">
      <MarketingHeader />

      <main className="flex-1">
        {/* Hero — sized to the first screen, CTA included. The stack is not
            centred in the box: centring a tight stack in a tall box piles the
            slack above and below and leaves the pieces cramped in the middle
            (Yash, laptop, 2026-09-11). It starts a fixed distance under the
            header and the room goes between the pieces. */}
        <section className="relative mx-auto flex min-h-[calc(100svh-3.5rem)] w-full max-w-4xl flex-col items-center px-6 pt-16 pb-16 text-center sm:pt-20">
          <div
            aria-hidden
            className="pointer-events-none absolute top-[55%] left-1/2 -z-10 h-[40rem] w-[40rem] -translate-x-1/2 -translate-y-1/2 rounded-full bg-blue-400/25 blur-[120px] dark:bg-blue-500/15"
          />
          {/* The demo is the hero; the headline introduces it. One clause,
              medium weight, a size down from a billboard — the first cut was
              two sentences at 60px and nothing else on the screen registered
              (Yash, 2026-09-11). The pricing half of the old line is gone:
              there is nothing to buy until payments land. */}
          <h1 className="text-3xl leading-tight font-medium tracking-tight text-balance sm:text-4xl lg:text-[2.75rem]">
            Your next language, out loud.
          </h1>
          <p className="mt-4 max-w-md text-base leading-relaxed text-balance text-muted-foreground">
            A tutor that answers naturally and never talks over you. The
            corrections wait until you have finished the thought.
          </p>

          <DemoConversation
            size="hero"
            className="mt-16 w-full max-w-2xl sm:mt-20"
          />

          {/* The correction line under the demo is laid out whether or not it
              is visible, so the space under the demo reads as generous until
              the correction fades in and then as tight. This gap is the
              middle: it holds up with the line showing and does not gape
              without it (Yash, 2026-09-11). */}
          <div className="mt-10">
            <PrimaryCta />
          </div>
        </section>

        {/* How it works — the same stage, three moments. */}
        <section
          id="how"
          aria-labelledby="how-heading"
          className="border-t border-border/60"
        >
          <div className="mx-auto w-full max-w-6xl px-6 py-20">
            <Reveal>
              <h2
                id="how-heading"
                className="text-xs font-medium tracking-[0.18em] text-muted-foreground uppercase"
              >
                How it works
              </h2>
              <p className="mt-3 max-w-xl text-2xl font-medium tracking-tight text-balance">
                A conversation, with the teaching around it instead of in it.
              </p>
            </Reveal>

            <ol className="mt-10 grid gap-5 md:grid-cols-3">
              {[
                {
                  n: "1",
                  title: "You speak",
                  body: "Say it however it comes out. Your words appear as you say them, so you can follow without translating in your head.",
                  stage: <SpeakFragment />,
                },
                {
                  n: "2",
                  title: "The tutor answers",
                  body: "In your chosen language, at conversation speed — and it waits. Nobody stops you mid-sentence to fix a verb.",
                  stage: <AnswerFragment />,
                },
                {
                  n: "3",
                  title: "The fix appears",
                  body: "Once your turn settles, the better word steps in quietly, in place, with the reason if you want it.",
                  stage: <FixFragment />,
                },
              ].map((step, i) => (
                <li key={step.n} className="flex h-full flex-col">
                  <Reveal delay={i * 0.08} className="flex h-full flex-col">
                    <div className="h-56 rounded-2xl border border-border/60 bg-muted/50 px-6 shadow-xs dark:bg-card/40 dark:shadow-none">
                      {step.stage}
                    </div>
                    <div className="px-1 pt-5">
                      {/* The number at the title's own size: a 12px numeral
                          on an 18px baseline read as floating (Yash,
                          2026-09-11). */}
                      <h3 className="flex items-center gap-3 text-lg font-medium tracking-tight">
                        <span className="text-primary tabular-nums">
                          {step.n}
                        </span>
                        {step.title}
                      </h3>
                      <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
                        {step.body}
                      </p>
                    </div>
                  </Reveal>
                </li>
              ))}
            </ol>
          </div>
        </section>

        {/* Languages */}
        <section
          aria-labelledby="languages-heading"
          className="border-t border-border/60"
        >
          <div className="mx-auto w-full max-w-6xl px-6 py-20">
            <Reveal>
              <h2
                id="languages-heading"
                className="text-xs font-medium tracking-[0.18em] text-muted-foreground uppercase"
              >
                Languages
              </h2>
              <p className="mt-3 max-w-xl text-2xl font-medium tracking-tight text-balance">
                Five languages to speak. The coaching is in English.
              </p>
              {/* Each language in its own name, large and unadorned, with the
                  English underneath. Every one is live, so the old "· now"
                  tag said nothing, and a row of bordered pills looked like a
                  filter bar with no list under it (Yash, 2026-09-11). */}
              <ul className="mt-10 grid grid-cols-2 gap-x-6 gap-y-8 sm:grid-cols-3 lg:grid-cols-5">
                {LANGUAGES.map((lang) => (
                  <li key={lang.name} className="flex flex-col gap-1">
                    <span className="text-2xl font-medium tracking-tight">
                      {lang.native}
                    </span>
                    <span className="text-sm text-muted-foreground">
                      {lang.name}
                    </span>
                  </li>
                ))}
              </ul>
            </Reveal>
          </div>
        </section>

        {/* Minutes */}
        <section
          aria-labelledby="pricing-heading"
          className="border-t border-border/60"
        >
          <div className="mx-auto w-full max-w-6xl px-6 py-20">
            <Reveal>
              <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
                <div>
                  <h2
                    id="pricing-heading"
                    className="text-xs font-medium tracking-[0.18em] text-muted-foreground uppercase"
                  >
                    Minutes
                  </h2>
                  <p className="mt-3 text-2xl font-medium tracking-tight">
                    Your first {SIGNUP_GRANT_MINUTES} minutes are free.
                  </p>
                </div>
                <PricingNote />
              </div>
              <PricingPacks className="mt-8" />
            </Reveal>
          </div>
        </section>

        {/* Closing */}
        <section className="border-t border-border/60">
          <div className="mx-auto flex w-full max-w-6xl flex-col items-center px-6 py-24 text-center">
            <Reveal className="flex flex-col items-center">
              <div className="relative h-20">
                <div
                  aria-hidden
                  className="pointer-events-none absolute inset-0 -z-10 scale-150 rounded-full bg-blue-400/30 blur-2xl dark:bg-blue-500/15"
                />
                <AmbientAura state="listening" className="h-full" />
              </div>
              {/* The same voice as the hero's headline: medium weight, a size
                  under it. Bolder here read as a second, louder billboard
                  (Yash, 2026-09-11). */}
              <h2 className="mt-8 text-2xl font-medium tracking-tight text-balance sm:text-3xl">
                Practice with a tutor that lets you finish.
              </h2>
              <p className="mt-3 max-w-md text-muted-foreground">
                No lesson, no quiz. A conversation that waits for you.
              </p>
              <div className="mt-8">
                <PrimaryCta />
              </div>
            </Reveal>
          </div>
        </section>
      </main>

      <MarketingFooter />
    </div>
  )
}
