"use client"

/**
 * The hero utterance and its caret — the only part of the surface that renders
 * at word resolution.
 *
 * Transcript deltas are cumulative snapshots, so "word by word" is a diff: a
 * word that was not in the previous snapshot animates in, and everything
 * already on screen stays put. That matters when corrections land and re-split
 * the line into new segments, which remounts the words inside them.
 */

import { useMemo, type ReactNode } from "react"
import { motion, useReducedMotion } from "motion/react"

import {
  CorrectionMark,
  segmentTurn,
} from "@/components/session/correction-mark"
import type { Correction, Turn } from "@/lib/session/contract"
import { wordsOf } from "@/lib/session/reducer"
import { cn } from "@/lib/utils"

export function HeroWords({
  turn,
  live,
  marksActive,
  reducedMotion = false,
  onCorrectionOpenChange,
}: {
  turn: Turn
  /** Still being transcribed — only then is the trailing word "new". */
  live: boolean
  marksActive: boolean
  /**
   * `prefers-reduced-motion`, resolved by the stage. A word that blurs and
   * rises into place is the surface's smallest animation and the one that
   * repeats most often; under the setting the word simply appears.
   */
  reducedMotion?: boolean | null
  /** The correction is passed through so a hold can name what is being read. */
  onCorrectionOpenChange: (open: boolean, correction: Correction) => void
}) {
  const segments = useMemo(() => segmentTurn(turn), [turn])
  const wordCount = wordsOf(turn.target).length
  const arriving = live && !reducedMotion ? wordCount - 1 : -1

  let index = 0
  const nodes: ReactNode[] = []

  for (const seg of segments) {
    const words = wordsOf(seg.text)
    const start = index
    index += words.length
    if (words.length === 0) continue

    const wordNodes = words.map((word, i) => (
      <motion.span
        key={`${turn.id}-${start + i}`}
        // Once marks are active the words sit inline so the parent's underline
        // can run through them (it doesn't reach inline-blocks).
        className={cn(
          seg.correction && marksActive ? "inline" : "inline-block"
        )}
        initial={
          start + i === arriving
            ? { opacity: 0, y: 6, filter: "blur(5px)" }
            : false
        }
        animate={{ opacity: 1, y: 0, filter: "blur(0px)" }}
        transition={{
          duration: reducedMotion ? 0 : 0.35,
          ease: "easeOut",
        }}
      >
        {word}
      </motion.span>
    ))

    const interleaved: ReactNode[] = []
    wordNodes.forEach((node, i) => {
      interleaved.push(node)
      if (i < wordNodes.length - 1) interleaved.push(" ")
    })

    nodes.push(
      seg.correction ? (
        <CorrectionMark
          key={seg.key}
          correction={seg.correction}
          active={marksActive}
          onOpenChange={onCorrectionOpenChange}
        >
          {interleaved}
        </CorrectionMark>
      ) : (
        <span key={seg.key}>{interleaved}</span>
      )
    )
    nodes.push(" ")
  }

  return <>{nodes}</>
}

/**
 * The caret. Live: a soft pulsing bar. Held: the same bar, steady.
 *
 * The phase-1 design turned it into a two-bar pause glyph while held; live
 * testing read that as a rendering glitch ("two typing cursors"), not a
 * state. The dimmed surface and the Aura's breathing ring already carry
 * "held" — the caret just stops breathing.
 */
export function Caret({ paused }: { paused?: boolean }) {
  // Read here rather than passed in: the caret renders on the stage, in the
  // landing demo and in the design playground, and a blinking bar that never
  // stops is exactly what the setting is for on every one of them.
  const reducedMotion = useReducedMotion()
  const blink = !paused && !reducedMotion
  return (
    <span className="ml-1.5 inline-flex h-[1.05em] translate-y-[0.16em] items-stretch align-baseline">
      <motion.span
        animate={{ opacity: blink ? [0.15, 0.7, 0.15] : 0.55 }}
        transition={
          blink
            ? { duration: 1.4, repeat: Infinity, ease: "easeInOut" }
            : { duration: reducedMotion ? 0 : 0.4 }
        }
        className="block w-[3px] rounded-full bg-primary"
      />
    </span>
  )
}
