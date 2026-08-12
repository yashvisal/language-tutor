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
import { MoveRight } from "lucide-react"
import { motion } from "motion/react"

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

const CATEGORY_STYLES: Record<
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
  onOpenChange: (open: boolean) => void
  children: ReactNode
}) {
  const style = CATEGORY_STYLES[correction.category]
  return (
    <Popover onOpenChange={onOpenChange}>
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
        <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-sm">
          <span className="text-muted-foreground line-through decoration-muted-foreground/40">
            {correction.original}
          </span>
          <MoveRight className="size-3.5 shrink-0 text-muted-foreground/50" />
          <span className={cn("font-medium", style.accent)}>
            {correction.replacement}
          </span>
        </div>
        <div className="mt-1.5 text-[10px] tracking-[0.14em] text-muted-foreground/60 uppercase">
          {CATEGORY_LABELS[correction.category]}
        </div>
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

/** Settled target-language text with its marks live (no reveal animation). */
export function SettledText({ turn }: { turn: Turn }) {
  const segments = useMemo(() => segmentTurn(turn), [turn])
  return (
    <>
      {segments.map((seg) =>
        seg.correction ? (
          <CorrectionMark
            key={seg.key}
            correction={seg.correction}
            active
            onOpenChange={() => {}}
          >
            {seg.text}
          </CorrectionMark>
        ) : (
          <span key={seg.key}>{seg.text}</span>
        )
      )}
    </>
  )
}
