import type { Metadata } from "next"
import { ArrowDown } from "lucide-react"

import {
  AnswerFragment,
  FixFragment,
  SpeakFragment,
} from "@/components/marketing/demo-conversation"
import { LabDemoConversation } from "@/components/marketing/lab-panel/demo-conversation"
import { GlowTuner } from "@/components/marketing/lab-plain/glow-tuner"
import { MarketingFooter } from "@/components/marketing/marketing-footer"
import { MarketingHeader } from "@/components/marketing/marketing-header"
import { PricingPacks } from "@/components/marketing/pricing"
import { PrimaryCta } from "@/components/marketing/primary-cta"
import { Reveal } from "@/components/marketing/reveal"
import { Button } from "@/components/ui/button"
import { SIGNUP_GRANT_MINUTES } from "@/lib/billing"
import { LANGUAGE_NAMES, TARGET_LANGUAGES } from "@/lib/session/plan"

export const metadata: Metadata = {
  title: "Plain stage — landing lab",
}

const LANGUAGES = TARGET_LANGUAGES.map(({ code, native }) => ({
  name: LANGUAGE_NAMES[code],
  native,
}))

/**
 * Landing candidate: PLAIN STAGE.
 *
 * The hero is the Paper "H1/H3 plain stage" board: the demo stands on the
 * page with nothing around it, so the first thing a visitor sees is the
 * product running rather than a screenshot of it. Everything under the hero
 * is the shipped landing's own sections (Yash, 2026-09-13: the current
 * how-it-works, languages and minutes beat the lab's alternatives), minus
 * the pricing note, which repeated the heading and the tiles.
 *
 * Blue appears in exactly three places, all of them the product's own: the
 * orb's light, the corrected word, the primary button.
 */
export default function PlainStageLanding() {
  return (
    <div className="flex min-h-svh flex-col">
      <MarketingHeader />

      <main className="flex-1">
        {/* Hero — one laptop screen, with the slack spread BETWEEN the pieces
            rather than piled above them: a tight stack centred in a tall box
            reads as cramped copy floating in emptiness (Yash, 2026-09-11).
            Hence the fixed start under the header and the growing gaps. */}
        <section className="relative mx-auto flex min-h-[calc(100svh-3.5rem)] w-full max-w-5xl flex-col items-center px-6 pt-16 pb-16 text-center sm:pt-20">
          {/* The wide wash the shipped landing puts behind the whole hero,
              here at a strength the glow tuner controls (default off): the
              Paper boards have only the orb's own halo. */}
          <div
            aria-hidden
            className="pointer-events-none absolute top-[58%] left-1/2 -z-10 h-[40rem] w-[40rem] -translate-x-1/2 -translate-y-1/2 rounded-full bg-blue-400 blur-[120px] dark:bg-blue-500"
            style={{ opacity: "var(--lab-wash-opacity, 0)" }}
          />

          {/* The measurements are the Paper "H1/H3 plain stage" heroes
              (2026-09-13): headline 64/68 at medium weight with -0.03em,
              subline 18/28 in a 520px measure, 16px between them, the
              buttons 12px further down, the demo 56px under them. Medium at
              this size reads bolder than semibold a size smaller did, and it
              is the weight every other heading on the page uses. */}
          <h1 className="max-w-[900px] text-4xl leading-[1.06] font-medium tracking-[-0.03em] text-balance sm:text-5xl lg:text-[4rem]">
            Your next language, out loud.
          </h1>
          <p className="mt-4 max-w-[520px] text-lg leading-7 text-balance text-muted-foreground">
            A tutor that answers naturally and never talks over you. The
            corrections wait until you have finished the thought.
          </p>

          {/* The app's own button at the app's own size, the bare verb: the
              grant sits under it instead of inside it (Yash, 2026-09-13).
              Beside it the way down to the explanation as a ghost, not an
              outline: a white-filled box on the stage light read as a
              sticker (Yash, 2026-09-13). */}
          <div className="mt-7 flex items-center gap-1">
            <PrimaryCta label="Start speaking" />
            <Button
              variant="ghost"
              size="lg"
              render={<a href="#how" />}
              nativeButton={false}
              className="text-muted-foreground hover:text-foreground"
            >
              How it works
              <ArrowDown data-icon="inline-end" />
            </Button>
          </div>
          <p className="mt-3 text-sm text-muted-foreground">
            Your first {SIGNUP_GRANT_MINUTES} minutes are free
          </p>

          <LabDemoConversation
            auraClassName="h-[200px]"
            className="mt-14 w-full max-w-2xl"
          />
        </section>

        {/* How it works — the shipped landing's section, as is: the same
            stage, three moments, in bordered tiles. */}
        <section
          id="how"
          aria-labelledby="how-heading"
          className="scroll-mt-14 border-t border-border/60"
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

        {/* Languages — the shipped landing's five names, as is. */}
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

        {/* Minutes — the shipped tiles, without the note under the heading:
            "your first minutes are free" already says it, and the tiles say
            the rest (Yash, 2026-09-13). */}
        <section
          aria-labelledby="pricing-heading"
          className="border-t border-border/60"
        >
          <div className="mx-auto w-full max-w-6xl px-6 py-20">
            <Reveal>
              <h2
                id="pricing-heading"
                className="text-xs font-medium tracking-[0.18em] text-muted-foreground uppercase"
              >
                Minutes
              </h2>
              <p className="mt-3 text-2xl font-medium tracking-tight">
                Your first {SIGNUP_GRANT_MINUTES} minutes are free.
              </p>
              <PricingPacks className="mt-8" />
            </Reveal>
          </div>
        </section>

        {/* Closing — the hero's voice, a size under it. No orb: the demo at
            the top is the only place the product should be playing, and a
            second one here read as a rerun. */}
        <section className="border-t border-border/60">
          <div className="mx-auto flex w-full max-w-6xl flex-col items-center px-6 py-24 text-center">
            <Reveal className="flex flex-col items-center">
              <h2 className="text-2xl font-medium tracking-tight text-balance sm:text-3xl">
                Practice with a tutor that lets you finish.
              </h2>
              <p className="mt-3 max-w-md text-muted-foreground">
                No lesson, no quiz. A conversation that waits for you.
              </p>
              <div className="mt-8">
                <PrimaryCta />
              </div>
              <p className="mt-6 text-xs text-muted-foreground/80">
                No card needed. A desktop browser and a microphone.
              </p>
            </Reveal>
          </div>
        </section>
      </main>

      <MarketingFooter />

      {/* Dev-only: the stage light dial. Never ships; the lab is a 404 in
          production. */}
      <GlowTuner />
    </div>
  )
}
