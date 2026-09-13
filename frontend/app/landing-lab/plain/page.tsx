import type { Metadata } from "next"

import { PACKS, PACKS_NOTE } from "@/components/marketing/brand"
import {
  AnswerFragment,
  FixFragment,
  SpeakFragment,
} from "@/components/marketing/demo-conversation"
import { LabDemoConversation } from "@/components/marketing/lab-panel/demo-conversation"
import { SectionHeading } from "@/components/marketing/lab-plain/section-heading"
import { MarketingFooter } from "@/components/marketing/marketing-footer"
import { MarketingHeader } from "@/components/marketing/marketing-header"
import { PrimaryCta } from "@/components/marketing/primary-cta"
import { Reveal } from "@/components/marketing/reveal"
import { SIGNUP_GRANT_MINUTES } from "@/lib/billing"
import { TARGET_LANGUAGES } from "@/lib/session/plan"

export const metadata: Metadata = {
  title: "Plain stage — landing lab",
}

const STEPS = [
  {
    n: "01",
    title: "You speak",
    body: "Say it however it comes out. Your words appear as you say them, so you can follow without translating in your head.",
    stage: <SpeakFragment />,
  },
  {
    n: "02",
    title: "The tutor answers",
    body: "In your chosen language, at conversation speed — and it waits. Nobody stops you mid-sentence to fix a verb.",
    stage: <AnswerFragment />,
  },
  {
    n: "03",
    title: "The fix appears",
    body: "Once your turn settles, the better word steps in quietly, in place, with the reason if you want it.",
    stage: <FixFragment />,
  },
]

/**
 * Landing candidate: PLAIN STAGE.
 *
 * The demo stands on the page with nothing around it — no panel, no card, no
 * session chrome — so the first thing a visitor sees is the product running
 * rather than a screenshot of it. Everything below the hero follows the same
 * rule: fills and hairlines instead of boxes, so the only drawn edges on the
 * page are the ones that separate sections.
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
          {/* The measurements are the Paper "H1/H3 plain stage" heroes
              (2026-09-13): headline 64/68 at medium weight with -0.03em,
              subline 18/28 in a 520px measure, 16px between them, the button
              12px further down, the demo 56px under the button. Medium at
              this size reads bolder than semibold a size smaller did, and it
              is the weight every other heading on the page uses. No wash of
              blue behind the hero: the orb carries its own halo. */}
          <h1 className="max-w-[900px] text-4xl leading-[1.06] font-medium tracking-[-0.03em] text-balance sm:text-5xl lg:text-[4rem]">
            Your next language, out loud.
          </h1>
          <p className="mt-4 max-w-[520px] text-lg leading-7 text-balance text-muted-foreground">
            A tutor that answers naturally and never talks over you. The
            corrections wait until you have finished the thought.
          </p>

          {/* The app's own button at the app's own size, the promise inside
              the label: the same control the header and the product use. */}
          <div className="mt-7">
            <PrimaryCta />
          </div>

          <LabDemoConversation
            auraClassName="h-[200px]"
            className="mt-14 w-full max-w-2xl"
          />
        </section>

        {/* How it works — the same stage, three moments. Fill-only tiles: the
            miniatures are already a picture each, and a border around each
            one turned the row into a spec sheet. */}
        <section
          id="how"
          aria-labelledby="how-heading"
          className="border-t border-border/60"
        >
          <div className="mx-auto w-full max-w-6xl px-6 py-20 sm:py-24">
            <Reveal>
              <SectionHeading overline="How it works" id="how-heading">
                A conversation, with the teaching around it instead of in it.
              </SectionHeading>
            </Reveal>

            <ol className="mt-12 grid gap-6 md:grid-cols-3">
              {STEPS.map((step, i) => (
                <li key={step.n} className="flex h-full flex-col">
                  <Reveal delay={i * 0.08} className="flex h-full flex-col">
                    <div className="h-56 rounded-2xl bg-muted/60 px-6 dark:bg-card/50">
                      {step.stage}
                    </div>
                    <div className="px-1 pt-5">
                      {/* The numeral sits on the title's baseline at the
                          title's size — a small numeral above the line read
                          as floating (Yash, 2026-09-11). Mono and tabular so
                          "01 02 03" line up down the row. */}
                      <h3 className="flex items-baseline gap-3 text-lg font-medium tracking-tight">
                        <span className="font-mono text-sm text-muted-foreground/70 tabular-nums">
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

        {/* Languages — one typographic line instead of a grid. Every language
            is live, so the list is a statement, not a chooser: five names in
            their own spelling, the separators dropped back so the eye reads
            names and not punctuation. */}
        <section
          aria-labelledby="languages-heading"
          className="border-t border-border/60"
        >
          <div className="mx-auto w-full max-w-6xl px-6 py-20 sm:py-24">
            <Reveal>
              <SectionHeading overline="Languages" id="languages-heading">
                Five languages to speak. The coaching is in English.
              </SectionHeading>
              <p className="mt-10 flex flex-wrap items-baseline gap-x-4 gap-y-2 text-3xl font-medium tracking-tight sm:text-4xl lg:text-[2.75rem]">
                {TARGET_LANGUAGES.map(({ code, native }, i) => (
                  <span key={code} className="flex items-baseline gap-x-4">
                    {i > 0 && (
                      <span aria-hidden className="text-muted-foreground/40">
                        ·
                      </span>
                    )}
                    {native}
                  </span>
                ))}
              </p>
            </Reveal>
          </div>
        </section>

        {/* Minutes — a rule-divided row, not cards. There is nothing to buy
            yet, so the packs are a price list: hairlines above, below and
            between, no badge and no buttons. */}
        <section
          aria-labelledby="pricing-heading"
          className="border-t border-border/60"
        >
          <div className="mx-auto w-full max-w-6xl px-6 py-20 sm:py-24">
            <Reveal>
              <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
                <SectionHeading overline="Minutes" id="pricing-heading">
                  Your first {SIGNUP_GRANT_MINUTES} minutes are free.
                </SectionHeading>
                <p className="text-sm text-muted-foreground">{PACKS_NOTE}</p>
              </div>

              <dl className="mt-10 grid border-y border-border/60 sm:grid-cols-3">
                {PACKS.map((pack) => (
                  // The rule between cells only exists where the cells are
                  // side by side; stacked, a top hairline divides them and
                  // the row's own border closes the ends.
                  <div
                    key={pack.minutes}
                    className="flex items-baseline justify-between gap-4 border-t border-border/60 px-1 py-6 first:border-t-0 sm:border-t-0 sm:border-l sm:px-6 sm:first:border-l-0"
                  >
                    <dt className="text-sm text-muted-foreground">
                      {pack.minutes} min
                    </dt>
                    <dd className="text-2xl tabular-nums sm:text-[2rem]">
                      {pack.price}
                    </dd>
                    {/* The per-minute rate is real but not the point here;
                        kept for screen readers so the row still states what
                        it costs to talk. */}
                    <span className="sr-only">{pack.per}</span>
                  </div>
                ))}
              </dl>
            </Reveal>
          </div>
        </section>

        {/* Closing — the hero's voice, a size under it. No orb: the demo at
            the top is the only place the product should be playing, and a
            second one here read as a rerun. */}
        <section className="border-t border-border/60">
          <div className="mx-auto flex w-full max-w-6xl flex-col items-center px-6 py-24 text-center sm:py-28">
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
    </div>
  )
}
