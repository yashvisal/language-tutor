"use client"

import { useEffect, useRef, useState } from "react"
import { motion, useReducedMotion } from "motion/react"

import { FeatureTile } from "@/components/marketing/demo-conversation"

/**
 * The two features the landing page had no way of telling anyone about:
 * select-to-translate and the Ask tab.
 *
 * Both are miniatures of the real surface rather than illustrations of it —
 * the translate card borrows the overlay's own surface
 * (`components/session/translate-overlay.tsx`: popover, rounded-lg, the span
 * in small italic muted type above the English), and the Ask exchange borrows
 * the thread's own shape (`components/session/study-ask.tsx`: the question in
 * a quiet right-aligned bubble, the answer full width as prose). Neither
 * needs an orb: the fix tile keeps the stage, and these two are about text,
 * so a third and fourth orb in a row read as decoration (Yash, 2026-09-14).
 *
 * They play once, on scroll into view, then stay resolved — the same contract
 * as `CorrectionFragment`. Reduced motion gets the resolved frame outright.
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
 * Highlight to translate — the tutor's sentence with a span selected and the
 * English sitting under it.
 */
export function TranslateFragment() {
  const { phase, start } = useBeats([600, 1250])
  const selected = phase >= 1
  const answered = phase >= 2

  return (
    <motion.div
      onViewportEnter={start}
      viewport={{ once: true, amount: 0.6 }}
      className="h-full"
    >
      <FeatureTile label="Tutor">
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
          className="mt-4 w-full max-w-[16rem] rounded-lg bg-popover p-3 text-left text-sm text-popover-foreground shadow-md ring-1 ring-foreground/10"
        >
          <div lang="es" className="text-xs text-muted-foreground/70 italic">
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
 * Ask anything — one exchange from the Ask thread, typed in.
 */
export function AskFragment() {
  const { phase, start } = useBeats([500, 1100])
  const asked = phase >= 1
  const answered = phase >= 2

  return (
    <motion.div
      onViewportEnter={start}
      viewport={{ once: true, amount: 0.6 }}
      className="h-full"
    >
      <FeatureTile label="Ask" align="start">
        <motion.div
          initial={false}
          animate={{ opacity: asked ? 1 : 0, y: asked ? 0 : 6 }}
          transition={{ duration: 0.3, ease: "easeOut" }}
          className="flex justify-end"
        >
          <p className="max-w-[85%] rounded-2xl rounded-br-md bg-foreground/[0.05] px-3.5 py-2 text-sm leading-6 tracking-[-0.011em] text-foreground dark:bg-white/[0.08]">
            Why estoy and not soy?
          </p>
        </motion.div>
        <motion.p
          initial={false}
          animate={{ opacity: answered ? 1 : 0, y: answered ? 0 : 6 }}
          transition={{ duration: 0.35, ease: "easeOut" }}
          aria-hidden={!answered}
          className="mt-3 pr-8 text-sm leading-6 text-pretty text-foreground"
        >
          Estar is for how you feel right now; ser is for what you are.
        </motion.p>
      </FeatureTile>
    </motion.div>
  )
}
