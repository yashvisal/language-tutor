"use client"

import { useEffect, useRef, useState } from "react"
import { motion, useReducedMotion } from "motion/react"
import { MoveRight } from "lucide-react"

import { cn } from "@/lib/utils"

/**
 * The three feature tiles under "How it works": the correction mark and its
 * popover, select-to-translate, and the Ask tab.
 *
 * All three are miniatures of the real surface rather than illustrations of
 * it. The fix tile is the session's own `CorrectionMark`
 * (`components/session/correction-mark.tsx`): the word is underlined in its
 * category's colour once the turn settles, and the popover opens under it
 * with the diff and the reason — not the inline swap the hero
 * demo uses, because in the app the fix is a popover, and the tile should
 * show the app (Yash, 2026-09-14). The translate card borrows the overlay's
 * own surface (`components/session/translate-overlay.tsx`), and the Ask
 * exchange borrows the thread's own shape (`components/session/study-ask.tsx`:
 * the question in a quiet right-aligned bubble, the answer full width as
 * prose). No orbs: these are about text, and a row of orbs read as
 * decoration.
 *
 * They play once, on scroll into view, then stay resolved. Reduced motion gets
 * the resolved frame outright.
 */

/**
 * The shared frame: the body pinned to one top so the three tiles start on
 * the same line whatever they weigh. No speaker label — each body already
 * says who is talking, and a label row on top was a second layer saying the
 * same thing (Yash, 2026-09-14).
 */
function FeatureTile({
  align = "center",
  children,
}: {
  align?: "center" | "start"
  children: React.ReactNode
}) {
  return (
    <div
      className={cn(
        "flex h-full w-full flex-col justify-start pt-8",
        align === "center" && "items-center text-center"
      )}
    >
      {children}
    </div>
  )
}

/** The popover surface, as `components/ui/popover.tsx` draws it. */
const CARD_CLASS =
  "rounded-lg bg-popover p-3 text-left text-sm text-popover-foreground shadow-md ring-1 ring-foreground/10"

/**
 * The three tiles enter view together and read left to right, so their
 * clocks are staggered 400ms apart: the fix first, then translate, then Ask,
 * each keeping its own ~700ms between beats. They used to run on their own
 * timings and the row resolved right to left (Yash, 2026-09-14).
 */

/**
 * Step through a few beats once the block scrolls into view. Returns the
 * phase and the starter to hand to `onViewportEnter`. Reduced motion starts
 * (and stays) at the last phase.
 */
function useBeats(delaysMs: number[]) {
  const reducedMotion = useReducedMotion()
  const resolved = reducedMotion === true
  const [phase, setPhase] = useState(0)
  const started = useRef(false)
  const timers = useRef<ReturnType<typeof setTimeout>[]>([])

  useEffect(() => () => timers.current.forEach(clearTimeout), [])

  const start = () => {
    if (started.current || resolved) return
    started.current = true
    timers.current = delaysMs.map((ms, i) =>
      setTimeout(() => setPhase(i + 1), ms)
    )
  }

  return { phase: resolved ? delaysMs.length : phase, start }
}

/** The tutor's line, with one span picked out the way a drag picks it out. */
function SelectedSpan({
  children,
  selected,
}: {
  children: React.ReactNode
  selected: boolean
}) {
  return (
    <span className="relative inline-block">
      {/* The sweep, behind the words: a selection is painted left to right as
          the pointer travels, so the highlight grows rather than fading in. */}
      <motion.span
        aria-hidden
        initial={false}
        animate={{ scaleX: selected ? 1 : 0 }}
        transition={{ duration: 0.45, ease: "easeOut" }}
        style={{ originX: 0 }}
        className="absolute inset-x-[-0.15em] inset-y-[-0.1em] rounded-[3px] bg-primary/25"
      />
      {/* Above the sweep without a negative z-index: nothing here makes a
          stacking context, so a negative layer would sink behind the tile's
          own background. */}
      <span className="relative">{children}</span>
    </span>
  )
}

/**
 * The fix appears — the learner's line with the wrong word marked, and the
 * correction popover under it. Beat one is the mark surfacing (the turn has
 * settled); beat two is the popover opening, with the mark tinted the way the
 * app tints an open one. Tense, in the app's violet.
 */
export function FixFragment() {
  const { phase, start } = useBeats([600, 1300])
  const marked = phase >= 1
  const open = phase >= 2

  return (
    <motion.div
      onViewportEnter={start}
      viewport={{ once: true, amount: 0.6 }}
      className="h-full"
    >
      <FeatureTile>
        <p
          lang="es"
          className="text-lg leading-snug tracking-tight text-balance"
        >
          Ayer yo{" "}
          <span
            className={cn(
              "rounded-[3px] px-px underline decoration-[0.06em] underline-offset-[0.22em] transition-all duration-700",
              marked ? "decoration-violet-500/60" : "decoration-transparent",
              open && "bg-violet-500/10"
            )}
          >
            fue
          </span>{" "}
          al supermercado.
        </p>

        {/* The correction popover, at the tile's scale: the diff and the
            reason, two rows like the translate card beside it so the tiles
            match. The app's category overline is left out for the same reason
            (Yash, 2026-09-14), and the reason is shown rather than behind the
            app's "why?", because the tile has no session to hold. */}
        <motion.div
          initial={false}
          animate={{ opacity: open ? 1 : 0, y: open ? 0 : -4 }}
          transition={{ duration: 0.2, ease: "easeOut" }}
          aria-hidden={!open}
          className={cn("mt-4 w-full max-w-[16rem]", CARD_CLASS)}
        >
          <p lang="es" className="flex items-center gap-x-2">
            <span className="text-muted-foreground line-through decoration-muted-foreground/40">
              fue
            </span>
            <MoveRight
              aria-hidden
              className="size-3.5 shrink-0 text-muted-foreground"
            />
            <span className="font-medium text-violet-700 dark:text-violet-300">
              fui
            </span>
          </p>
          <p lang="en" className="mt-1.5 leading-relaxed">
            Past tense, first person.
          </p>
        </motion.div>
      </FeatureTile>
    </motion.div>
  )
}

/**
 * Highlight to translate — the tutor's sentence with a span selected and the
 * English sitting under it.
 */
export function TranslateFragment() {
  const { phase, start } = useBeats([1000, 1700])
  const selected = phase >= 1
  const answered = phase >= 2

  return (
    <motion.div
      onViewportEnter={start}
      viewport={{ once: true, amount: 0.6 }}
      className="h-full"
    >
      <FeatureTile>
        <p
          lang="es"
          className="text-lg leading-snug tracking-tight text-balance"
        >
          Suena bien. ¿Y hoy,{" "}
          <SelectedSpan selected={selected}>cómo estás?</SelectedSpan>
        </p>

        {/* The overlay's own card, at the tile's scale. */}
        <motion.div
          initial={false}
          animate={{ opacity: answered ? 1 : 0, y: answered ? 0 : -4 }}
          transition={{ duration: 0.2, ease: "easeOut" }}
          aria-hidden={!answered}
          className={cn("mt-4 w-full max-w-[16rem]", CARD_CLASS)}
        >
          <div lang="es" className="text-muted-foreground/70 italic">
            cómo estás
          </div>
          <p lang="en" className="mt-1.5 leading-relaxed">
            how are you
          </p>
        </motion.div>
      </FeatureTile>
    </motion.div>
  )
}

/**
 * Ask anything — one exchange from the Ask thread. The question is the tile's
 * base text, there from the start like the sentences in the other two tiles
 * (a tile that is empty while its neighbours already show something read as
 * a gap in the row — Yash, 2026-09-14). The answer streams in word by word
 * once the other tiles' second beats are landing, the way the thread's own
 * answer arrives.
 */
const ASK_ANSWER =
  "Estar is for how you feel right now; ser is for what you are."
const ASK_WORDS = ASK_ANSWER.split(" ")
const ASK_WORD_MS = 55

export function AskFragment() {
  const { phase, start } = useBeats([1300])
  const answering = phase >= 1
  const reducedMotion = useReducedMotion()
  const [shown, setShown] = useState(
    reducedMotion === true ? ASK_WORDS.length : 0
  )

  useEffect(() => {
    if (!answering || shown >= ASK_WORDS.length) return
    const id = setTimeout(() => setShown((n) => n + 1), ASK_WORD_MS)
    return () => clearTimeout(id)
  }, [answering, shown])

  return (
    <motion.div
      onViewportEnter={start}
      viewport={{ once: true, amount: 0.6 }}
      className="h-full"
    >
      <FeatureTile align="start">
        <div className="flex justify-end">
          <p className="max-w-[85%] rounded-2xl rounded-br-md bg-foreground/[0.05] px-3.5 py-2 text-sm leading-6 tracking-[-0.011em] text-foreground dark:bg-white/[0.08]">
            Why estoy and not soy?
          </p>
        </div>
        {/* The full answer for assistive tech; the streamed words are the
            visual only. The box keeps the answer's two lines reserved so the
            tile does not grow as the words land. */}
        <p
          aria-label={ASK_ANSWER}
          className="mt-3 min-h-12 pr-8 text-sm leading-6 text-pretty text-foreground"
        >
          <span aria-hidden>{ASK_WORDS.slice(0, shown).join(" ")}</span>
        </p>
      </FeatureTile>
    </motion.div>
  )
}
