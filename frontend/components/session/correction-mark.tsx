"use client"

/**
 * Correction marks: the one place the tutor's judgement touches the learner's
 * own words, so the treatment is deliberately quiet. Hue distinguishes *kind*,
 * never severity, and there is no destructive red anywhere — a correction is an
 * invitation, not a failure.
 *
 * Opening a mark holds the session (the caller wires `onOpenChange`); a learner
 * reading an explanation must never be talked over.
 */

import { useMemo, useReducer, type ReactNode } from "react"
import { motion } from "motion/react"

import { CorrectionDiff } from "@/components/session/session-record"
import { Overline } from "@/components/overline"
import { translatableProps } from "@/components/session/translate-overlay"
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover"
import {
  CATEGORY_LABELS,
  type Correction,
  type CorrectionCategory,
  type Turn,
} from "@/lib/session/contract"
import { cn } from "@/lib/utils"

/** Exported so the post-session summary reads corrections in the same colors
 * the stage marked them in. One palette, two surfaces. */
export const CATEGORY_STYLES: Record<
  CorrectionCategory,
  { mark: string; accent: string }
> = {
  tense: {
    mark: "decoration-violet-500/60 hover:bg-violet-500/10 data-popup-open:bg-violet-500/10",
    accent: "text-violet-700 dark:text-violet-300",
  },
  agreement: {
    mark: "decoration-sky-500/60 hover:bg-sky-500/10 data-popup-open:bg-sky-500/10",
    accent: "text-sky-700 dark:text-sky-300",
  },
  "word-order": {
    mark: "decoration-amber-500/70 hover:bg-amber-500/10 data-popup-open:bg-amber-500/10",
    accent: "text-amber-700 dark:text-amber-300",
  },
  vocabulary: {
    mark: "decoration-emerald-500/60 hover:bg-emerald-500/10 data-popup-open:bg-emerald-500/10",
    accent: "text-emerald-700 dark:text-emerald-300",
  },
  naturalness: {
    mark: "decoration-cyan-500/60 hover:bg-cyan-500/10 data-popup-open:bg-cyan-500/10",
    accent: "text-cyan-700 dark:text-cyan-300",
  },
}

export interface Segment {
  key: string
  text: string
  correction?: Correction
}

/**
 * Split a turn's target-language text into plain / marked segments. Corrections
 * whose span is no longer present in the text are dropped: the live transcript
 * can be revised after the analyzer has looked at it.
 */
export function segmentTurn(turn: Turn): Segment[] {
  const text = turn.target
  // Case-insensitive: the analyzer sees the raw transcript, but the display
  // text re-cases fragment boundaries when coalescing ("Ahora" -> "ahora"), so
  // an exact match would silently drop those marks. The mark renders the
  // display text at the found position, not the analyzer's copy.
  const lower = text.toLowerCase()
  const found = (turn.corrections ?? [])
    .map((c) => ({ c, at: lower.indexOf(c.original.toLowerCase()) }))
    .filter((x) => x.at >= 0)
    .sort((a, b) => a.at - b.at)

  const segments: Segment[] = []
  let cursor = 0
  for (const { c, at } of found) {
    // Overlapping spans would produce a negative slice; first match wins.
    if (at < cursor) continue
    if (at > cursor) {
      segments.push({ key: `plain-${cursor}`, text: text.slice(cursor, at) })
    }
    // The DISPLAY slice, not the analyzer's copy — casing can differ.
    segments.push({
      key: c.id,
      text: text.slice(at, at + c.original.length),
      correction: c,
    })
    cursor = at + c.original.length
  }
  if (cursor < text.length) {
    segments.push({ key: `plain-${cursor}`, text: text.slice(cursor) })
  }
  return segments
}

export function CorrectionMark({
  correction,
  active,
  onOpenChange,
  children,
}: {
  correction: Correction
  /** Marks only surface once the turn has settled. */
  active: boolean
  /** The correction is echoed back so the caller's hold can name it. */
  onOpenChange: (open: boolean, correction: Correction) => void
  children: ReactNode
}) {
  const style = CATEGORY_STYLES[correction.category]
  return (
    <Popover onOpenChange={(open) => onOpenChange(open, correction)}>
      <PopoverTrigger
        nativeButton={false}
        render={
          <span
            className={cn(
              "rounded-[3px] px-px align-baseline underline decoration-[0.06em] underline-offset-[0.22em] transition-all duration-700",
              correction.severity !== "error" && "decoration-dotted",
              active
                ? cn("cursor-pointer", style.mark)
                : "pointer-events-none decoration-transparent"
            )}
          />
        }
      >
        {children}
      </PopoverTrigger>
      <PopoverContent
        side="bottom"
        align="start"
        sideOffset={10}
        className="w-auto max-w-72 min-w-52 gap-0 p-3.5"
      >
        <CorrectionDiff
          original={correction.original}
          replacement={correction.replacement}
          accentClassName={style.accent}
        />
        <Overline className="mt-1.5">
          {CATEGORY_LABELS[correction.category]}
        </Overline>
        <ExplanationDisclosure text={correction.explanation} />
      </PopoverContent>
    </Popover>
  )
}

function ExplanationDisclosure({ text }: { text: string }) {
  const [open, toggle] = useReducer(() => true, false)
  return open ? (
    <motion.p
      initial={{ opacity: 0, height: 0 }}
      animate={{ opacity: 1, height: "auto" }}
      transition={{ duration: 0.25 }}
      className="mt-2 overflow-hidden text-xs leading-relaxed text-muted-foreground"
    >
      {text}
    </motion.p>
  ) : (
    <button
      type="button"
      onClick={toggle}
      className="mt-2 self-start text-xs text-muted-foreground/70 transition-colors hover:text-foreground"
    >
      Why?
    </button>
  )
}

/** Stable, so a defaulted `SettledText` never remounts its marks. */
const NO_OP = () => {}

/**
 * Settled target-language text with its marks live (no reveal animation).
 *
 * The wrapper span is what makes the text selectable-to-translate: it is the
 * marker `SelectionTranslator` resolves a selection against, so every place
 * settled text renders gets the overlay without knowing it exists.
 */
export function SettledText({
  turn,
  onCorrectionOpenChange = NO_OP,
}: {
  turn: Turn
  /**
   * Hold the session while one of these marks is open, exactly as the hero
   * does. Optional because not every host needs it: the history peek already
   * holds for `"history"` the whole time it is up, so its rows can keep the
   * no-op. The pinned context row has no such cover and must wire this.
   */
  onCorrectionOpenChange?: (open: boolean, correction: Correction) => void
}) {
  const segments = useMemo(() => segmentTurn(turn), [turn])
  return (
    <span {...translatableProps(turn)}>
      {segments.map((seg) =>
        seg.correction ? (
          <CorrectionMark
            key={seg.key}
            correction={seg.correction}
            active
            onOpenChange={onCorrectionOpenChange}
          >
            {seg.text}
          </CorrectionMark>
        ) : (
          <span key={seg.key}>{seg.text}</span>
        )
      )}
    </span>
  )
}
