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
import { cn } from "@/lib/utils"

export const metadata: Metadata = {
  title: "tutor — speak Spanish, uninterrupted",
  description:
    "A live Spanish tutor that keeps the conversation going. Your words appear as you speak them, and after your turn settles you see what you should have said.",
}

/** The languages we mean to reach, the one we have, honestly labelled. */
const LANGUAGES = [
  { name: "Spanish", native: "Español", available: true },
  { name: "French", native: "Français" },
  { name: "Portuguese", native: "Português" },
  { name: "Italian", native: "Italiano" },
  { name: "German", native: "Deutsch" },
  { name: "Japanese", native: "日本語" },
] as const

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
        {/* Hero — sized to the first screen, CTA included. */}
        <section className="relative mx-auto flex min-h-[calc(100svh-3.5rem)] w-full max-w-4xl flex-col items-center justify-center px-6 py-10 text-center">
          <div
            aria-hidden
            className="pointer-events-none absolute top-[55%] left-1/2 -z-10 h-[40rem] w-[40rem] -translate-x-1/2 -translate-y-1/2 rounded-full bg-blue-500/10 blur-[120px] dark:bg-blue-500/15"
          />
          <h1 className="text-4xl leading-[1.05] font-semibold tracking-tight text-balance sm:text-5xl lg:text-6xl">
            Ten minutes of Spanish, out loud.
          </h1>
          <p className="mt-4 max-w-lg text-base leading-relaxed text-balance text-muted-foreground sm:text-lg">
            A tutor that answers naturally and never talks over you. The
            corrections wait until you have finished the thought.
          </p>

          <DemoConversation size="hero" className="mt-10 w-full max-w-2xl" />

          <div className="mt-8">
            <PrimaryCta />
          </div>
          <p className="mt-3 text-xs text-muted-foreground">
            Spanish for now. Runs in your browser — no app to install.
          </p>
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
                  body: "In Spanish, at conversation speed — and it waits. Nobody stops you mid-sentence to fix a verb.",
                  stage: <AnswerFragment />,
                },
                {
                  n: "3",
                  title: "The fix appears",
                  body: "Once your turn settles, the better word steps in quietly, in place, with the reason if you want it.",
                  stage: <FixFragment />,
                },
              ].map((step, i) => (
                <Reveal key={step.n} delay={i * 0.08}>
                  <li className="flex h-full flex-col">
                    <div className="h-56 rounded-2xl border border-border/60 bg-card/40 px-6">
                      {step.stage}
                    </div>
                    <div className="px-1 pt-5">
                      <div className="flex items-baseline gap-3">
                        <span className="text-xs font-medium tabular-nums text-blue-600 dark:text-blue-400">
                          {step.n}
                        </span>
                        <h3 className="text-lg font-medium tracking-tight">
                          {step.title}
                        </h3>
                      </div>
                      <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
                        {step.body}
                      </p>
                    </div>
                  </li>
                </Reveal>
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
              <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
                <div>
                  <h2
                    id="languages-heading"
                    className="text-xs font-medium tracking-[0.18em] text-muted-foreground uppercase"
                  >
                    Languages
                  </h2>
                  <p className="mt-3 text-2xl font-medium tracking-tight">
                    Spanish today. More as we go.
                  </p>
                </div>
                <p className="text-sm text-muted-foreground">
                  Tell us which one you want next.
                </p>
              </div>
              <ul className="mt-8 flex flex-wrap gap-2.5">
                {LANGUAGES.map((lang) => {
                  const available = "available" in lang && lang.available
                  return (
                    <li
                      key={lang.name}
                      className={cn(
                        "flex items-baseline gap-2 rounded-full border px-4 py-2 text-sm",
                        available
                          ? "border-blue-500/50 text-foreground dark:border-blue-400/40"
                          : "border-border/70 text-muted-foreground"
                      )}
                    >
                      <span className="font-medium">{lang.native}</span>
                      <span className="text-xs text-muted-foreground">
                        {lang.name}
                        {available ? " · now" : " · soon"}
                      </span>
                    </li>
                  )
                })}
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
                    Your first 10 minutes are free.
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
                  className="pointer-events-none absolute inset-0 -z-10 scale-150 rounded-full bg-blue-500/15 blur-2xl"
                />
                <AmbientAura state="listening" className="h-full" />
              </div>
              <h2 className="mt-8 text-3xl font-semibold tracking-tight text-balance sm:text-4xl">
                Speak Spanish with a tutor that lets you finish.
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
