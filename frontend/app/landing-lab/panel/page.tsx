import type { Metadata } from "next"

import { PACKS_NOTE } from "@/components/marketing/brand"
import {
  AnswerFragment,
  FixFragment,
  SpeakFragment,
} from "@/components/marketing/demo-conversation"
import { DemoPanel } from "@/components/marketing/lab-panel/demo-panel"
import { PanelPricingPacks } from "@/components/marketing/lab-panel/pricing"
import { PANEL_SURFACE } from "@/components/marketing/lab-panel/surface"
import { MarketingFooter } from "@/components/marketing/marketing-footer"
import { MarketingHeader } from "@/components/marketing/marketing-header"
import { PrimaryCta } from "@/components/marketing/primary-cta"
import { Reveal } from "@/components/marketing/reveal"
import { OVERLINE_CLASS } from "@/components/overline"
import { Button } from "@/components/ui/button"
import { SIGNUP_GRANT_MINUTES } from "@/lib/billing"
import { LANGUAGE_NAMES, TARGET_LANGUAGES } from "@/lib/session/plan"
import { cn } from "@/lib/utils"

export const metadata: Metadata = {
  title: "lengua — practice languages, uninterrupted",
  description:
    "A live language tutor that keeps the conversation going. Your words appear as you speak them, and after your turn settles you see what you should have said.",
}

const LANGUAGES = TARGET_LANGUAGES.map(({ code, native }) => ({
  name: LANGUAGE_NAMES[code],
  native,
}))

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

/** The label + line every section below the hero opens with. */
function SectionHead({
  id,
  overline,
  children,
}: {
  id: string
  overline: string
  children: React.ReactNode
}) {
  return (
    <>
      {/* The product's one label scale (`OVERLINE_CLASS`) — an `<h2>` rather
          than an `Overline` because it is the section's accessible name. */}
      <h2 id={id} className={OVERLINE_CLASS}>
        {overline}
      </h2>
      <p className="mt-3 max-w-xl text-[1.75rem] leading-tight font-medium tracking-tight text-balance lg:text-3xl">
        {children}
      </p>
    </>
  )
}

/**
 * Panel-stage variant.
 *
 * The demo is framed as a product screen — a panel with the session's own
 * chrome across the top — and that frame becomes the page's one surface: the
 * three "how it works" miniatures are the same panel, smaller. Headline, a
 * two-line subline, the CTA, and then the screen: the order a visitor reads
 * in, with the room between the pieces rather than above them.
 */
export default function PanelLandingPage() {
  return (
    <div className="flex min-h-svh flex-col">
      <MarketingHeader />

      <main className="flex-1">
        {/* Hero — one laptop screen. Centring a tight stack in a tall box
            piles the slack above and below (Yash, 2026-09-11), so it starts a
            fixed distance under the header and the gaps carry the height. */}
        <section className="mx-auto flex min-h-[calc(100svh-3.5rem)] w-full max-w-6xl flex-col items-center px-6 pt-14 pb-12 text-center sm:pt-[4.5rem]">
          {/* The measurements are the Paper "H2/H4 panel stage" heroes
              (2026-09-13): headline 56/60 at medium weight with -0.03em,
              subline 18/28 in a 520px measure, 16px between them, the
              buttons 12px further down, the panel 56px under them. */}
          <h1 className="max-w-[900px] text-4xl leading-[1.07] font-medium tracking-[-0.03em] text-balance sm:text-5xl lg:text-[3.5rem]">
            Your next language, out loud.
          </h1>
          <p className="mt-4 max-w-[520px] text-lg leading-7 text-balance text-muted-foreground">
            A tutor that answers naturally and never talks over you. The
            corrections wait until you have finished the thought.
          </p>

          {/* The app's own button at the app's own size, and beside it the
              one secondary the Paper panel hero carries: a quiet way down to
              the explanation for whoever wants it before the screen. */}
          <div className="mt-7 flex items-center gap-2">
            <PrimaryCta />
            <Button
              variant="outline"
              size="lg"
              render={<a href="#how" />}
              nativeButton={false}
            >
              How it works
            </Button>
          </div>

          <DemoPanel className="mt-14 w-full max-w-[896px]" />
        </section>

        {/* How it works — the same stage, three moments, in the hero's frame. */}
        <section
          id="how"
          aria-labelledby="how-heading"
          className="border-t border-border/60"
        >
          <div className="mx-auto w-full max-w-6xl px-6 py-20">
            <Reveal>
              <SectionHead id="how-heading" overline="How it works">
                A conversation, with the teaching around it instead of in it.
              </SectionHead>
            </Reveal>

            <ol className="mt-10 grid gap-5 md:grid-cols-3">
              {STEPS.map((step, i) => (
                <li key={step.n} className="flex h-full flex-col">
                  <Reveal delay={i * 0.08} className="flex h-full flex-col">
                    <div className={cn(PANEL_SURFACE, "h-52 px-6")}>
                      {step.stage}
                    </div>
                    <div className="px-1 pt-5">
                      {/* The numeral sits on the title line: a 12px one on an
                          18px baseline read as floating (Yash, 2026-09-11).
                          Mono and tabular so 01/02/03 align across columns. */}
                      <h3 className="flex items-baseline gap-3 text-lg font-medium tracking-tight">
                        <span className="font-mono text-sm text-muted-foreground tabular-nums">
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

        {/* Languages — five names between two hairlines. Every one is live, so
            there is no tag to add, and a row of bordered pills read as a
            filter bar with no list under it (Yash, 2026-09-11). */}
        <section
          aria-labelledby="languages-heading"
          className="border-t border-border/60"
        >
          <div className="mx-auto w-full max-w-6xl px-6 py-20">
            <Reveal>
              <SectionHead id="languages-heading" overline="Languages">
                Five languages to speak. The coaching is in English.
              </SectionHead>
              <ul className="mt-10 grid grid-cols-2 gap-x-6 gap-y-7 border-y border-border/60 py-8 sm:grid-cols-3 lg:grid-cols-5">
                {LANGUAGES.map((lang) => (
                  <li key={lang.name} className="flex flex-col gap-0.5">
                    <span className="text-[1.75rem] leading-tight font-medium tracking-tight">
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
                  <SectionHead id="pricing-heading" overline="Minutes">
                    Your first {SIGNUP_GRANT_MINUTES} minutes are free.
                  </SectionHead>
                </div>
                <p className="text-sm text-muted-foreground">{PACKS_NOTE}</p>
              </div>
              <PanelPricingPacks className="mt-8" />
            </Reveal>
          </div>
        </section>

        {/* Closing — the hero's voice, a size under it, and no orb: the stage
            has already played once at the top of the page. */}
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
    </div>
  )
}
