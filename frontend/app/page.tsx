import type { Metadata } from "next"

import { AmbientAura } from "@/components/marketing/ambient-aura"
import {
  DemoConversation,
  FixFragment,
} from "@/components/marketing/demo-conversation"
import {
  AskFragment,
  TranslateFragment,
} from "@/components/marketing/feature-miniatures"
import { LanguageFlag } from "@/components/marketing/language-flag"
import { MarketingFooter } from "@/components/marketing/marketing-footer"
import { MarketingHeader } from "@/components/marketing/marketing-header"
import { PricingPacks } from "@/components/marketing/pricing"
import { PrimaryCta } from "@/components/marketing/primary-cta"
import { Reveal } from "@/components/marketing/reveal"
import { Button } from "@/components/ui/button"
import { SIGNUP_GRANT_MINUTES } from "@/lib/billing"
import { LANGUAGE_NAMES, TARGET_LANGUAGES } from "@/lib/session/plan"

export const metadata: Metadata = {
  title: "lengua — practice languages, uninterrupted",
  description:
    "A live language tutor that keeps the conversation going. Your words appear as you speak them, and after your turn settles you see what you should have said.",
}

const LANGUAGES = TARGET_LANGUAGES.map(({ code, native }) => ({
  code,
  name: LANGUAGE_NAMES[code]!,
  native,
}))

/**
 * The landing page: the "plain stage" candidate from the landing lab,
 * promoted (Yash, 2026-09-13).
 *
 * The hero follows the Paper "H1/H3 plain stage" boards: the demo stands on
 * the page with nothing around it, so the first thing a visitor sees is the
 * product running rather than a screenshot of it. Under it, how it works as
 * three miniatures of the same stage, the languages, the minutes, and the
 * way in. Blue appears where the product puts it: the orb's light, the
 * corrected word, the primary button.
 */
export default function LandingPage() {
  return (
    <div className="flex min-h-svh flex-col">
      <MarketingHeader />

      <main className="flex-1">
        {/* Hero — one laptop screen, with the slack spread BETWEEN the pieces
            rather than piled above them: a tight stack centred in a tall box
            reads as cramped copy floating in emptiness (Yash, 2026-09-11).
            Hence the fixed start under the header and the growing gaps. */}
        <section className="relative mx-auto flex min-h-[calc(100svh-3.5rem)] w-full max-w-6xl flex-col items-center px-6 pt-16 pb-16 text-center sm:pt-20">
          {/* The wide wash behind the whole hero, at the strength Yash
              settled on with the lab's tuner (2026-09-13). */}
          <div
            aria-hidden
            className="pointer-events-none absolute top-[58%] left-1/2 -z-10 h-[40rem] w-[40rem] -translate-x-1/2 -translate-y-1/2 rounded-full bg-blue-400/20 blur-[120px] dark:bg-blue-500/20"
          />

          {/* The measurements are the Paper "H1/H3 plain stage" heroes
              (2026-09-13): headline 64/68 at medium weight with -0.03em, held
              to one line on desktop, subline 18/28 in a 520px measure, 16px
              between them, the buttons 12px further down, the demo 56px under
              them. Medium at this size reads bolder than semibold a size
              smaller did, and it is the weight every other heading on the
              page uses. "Learn your next language" was tried and reverted: the
              verb is every language app's, the button already carries it, and
              the shorter line keeps the air (Yash, 2026-09-13). */}
          <h1 className="text-4xl leading-[1.06] font-medium tracking-[-0.03em] text-balance sm:text-5xl lg:text-[4rem] lg:whitespace-nowrap">
            Your next language, out loud.
          </h1>
          <p className="mt-4 max-w-[520px] text-lg leading-7 text-balance text-muted-foreground">
            A tutor that answers naturally and never talks over you. The
            corrections wait until you have finished the thought.
          </p>

          {/* The app's own button at the app's own size, the promise inside
              the label, and beside it the one secondary from the Paper panel
              hero: a quiet way down to the explanation for whoever wants it
              before the demo. Tried as a ghost with the grant as a caption;
              the outline and the full label read better (Yash, 2026-09-13). */}
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

          {/* The orb at the Paper boards' 200px. The override has to name the
              sm breakpoint too, or the demo's own sm:h-56 wins above 640px. */}
          <DemoConversation
            size="hero"
            auraClassName="h-[200px] sm:h-[200px]"
            className="mt-14 w-full max-w-2xl"
          />
        </section>

        {/* How it works — three things the product does, each one running.
            The numerals went with the sequence they belonged to: these are
            features a visitor can pick from, not steps in an order (Yash,
            2026-09-14). */}
        <section
          id="how"
          aria-labelledby="how-heading"
          className="scroll-mt-14 border-t border-border/60"
        >
          <div className="mx-auto w-full max-w-6xl px-6 py-20">
            <Reveal>
              {/* The sentence is the heading and the eyebrow is a label: a
                  screen reader's heading list should read as sentences, not
                  as three shouted words (checklist C10). Only the tags
                  swapped — the type is the same on both. */}
              <p className="text-xs font-medium tracking-[0.18em] text-muted-foreground uppercase">
                How it works
              </p>
              {/* Section headings hold one line at desktop, all of them the
                  same (Yash, 2026-09-13). */}
              <h2
                id="how-heading"
                className="mt-3 max-w-3xl text-2xl font-medium tracking-tight text-balance"
              >
                A conversation, with the teaching around it instead of in it.
              </h2>
            </Reveal>

            <ul className="mt-10 grid gap-5 md:grid-cols-3">
              {[
                {
                  title: "The fix appears",
                  body: "Once your turn settles, the better word steps in quietly, in place, with the reason if you want it.",
                  stage: <FixFragment />,
                },
                {
                  title: "Highlight to translate",
                  body: "Unsure what the tutor said? Select any part of it and the English appears right there. Selecting holds the session — no seconds spent reading.",
                  stage: <TranslateFragment />,
                },
                {
                  title: "Ask anything",
                  body: "Pause and ask why. The tutor explains in English, with the conversation as context, then you pick up where you left off.",
                  stage: <AskFragment />,
                },
              ].map((feature, i) => (
                <li key={feature.title} className="flex h-full flex-col">
                  <Reveal delay={i * 0.08} className="flex h-full flex-col">
                    <div className="h-56 rounded-2xl border border-border/60 bg-muted/50 px-6 shadow-xs dark:bg-card/40 dark:shadow-none">
                      {feature.stage}
                    </div>
                    <div className="px-1 pt-5">
                      <h3 className="text-lg font-medium tracking-tight">
                        {feature.title}
                      </h3>
                      <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
                        {feature.body}
                      </p>
                    </div>
                  </Reveal>
                </li>
              ))}
            </ul>
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
              <p className="mt-3 max-w-3xl text-2xl font-medium tracking-tight text-balance">
                Practice speaking in these languages, with coaching in English.
              </p>
              {/* One strip, five cells, a hairline between them: the flag as
                  a small round badge, the name in its own spelling, the
                  English beneath. Five separate cards with a word each read
                  as bland (Yash, 2026-09-13); one shared surface reads as a
                  set. The flags are drawn inline: emoji flags come out as
                  letters on Windows. */}
              <ul className="mt-10 grid grid-cols-1 overflow-hidden rounded-2xl border border-border/60 bg-muted/50 shadow-xs sm:grid-cols-3 lg:grid-cols-5 dark:bg-card/40 dark:shadow-none">
                {LANGUAGES.map((lang) => (
                  <li
                    key={lang.code}
                    // At sm the five cells wrap to two rows: the second row keeps its
                    // top hairline and its first cell drops the left one, so no
                    // line sits on the container's own edge (CodeRabbit, PR #11).
                    className="flex items-center gap-4 border-border/60 px-6 py-6 not-first:border-t sm:not-first:border-t-0 sm:not-first:border-l sm:nth-4:border-l-0 sm:nth-[n+4]:border-t lg:nth-4:border-l lg:nth-[n+4]:border-t-0"
                  >
                    <LanguageFlag code={lang.code} />
                    <div className="flex flex-col">
                      <span className="text-lg font-medium tracking-tight">
                        {lang.native}
                      </span>
                      <span className="text-sm text-muted-foreground">
                        {lang.name}
                      </span>
                    </div>
                  </li>
                ))}
              </ul>
            </Reveal>
          </div>
        </section>

        {/* Minutes — the tiles, without a note under the heading: "your
            first minutes are free" already says it, and the tiles say the
            rest (Yash, 2026-09-13). */}
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

        {/* Closing — the small orb above the line. The button is the bare
            verb: the minutes section just above has already made the
            promise (Yash, 2026-09-13). */}
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
                <PrimaryCta label="Start speaking" />
              </div>
            </Reveal>
          </div>
        </section>
      </main>

      <MarketingFooter />
    </div>
  )
}
