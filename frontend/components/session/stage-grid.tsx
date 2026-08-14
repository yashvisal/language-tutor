"use client"

/**
 * The stage's one honest column.
 *
 * Every text row on the surface — pinned context, hero, and the history peek —
 * is a row of this grid, so all three share a left edge and a measure. The Aura
 * is deliberately NOT part of it: it stays viewport-centered and the column
 * centers beneath it.
 *
 * Live translation is gone (phase 3), so there is no second column and nothing
 * to collapse; what remains is a readable measure, not an edge-to-edge line.
 */

import type { ReactNode } from "react"

import type { Turn } from "@/lib/session/contract"
import { cn } from "@/lib/utils"

/**
 * The single text column. A touch wider than the old target column (460px) now
 * that it no longer shares the stage with an anchor column — wide enough that
 * tutor turns stop wrapping into a narrow ribbon, narrow enough to stay a
 * comfortable measure at the hero's 1.6rem type.
 */
export const STAGE_COL_W = 580

/**
 * …but a fixed width clips inside the stage's `overflow-hidden` on a narrow
 * window (the surface is desktop-first, not desktop-only). The column is
 * therefore a ceiling, not a measurement.
 */
const STAGE_COL_WIDTH = `min(${STAGE_COL_W}px, 100%)`

/** Line box shared by the body rows. */
export const ROW_LEADING = "leading-7"
/** Line box for the hero row. */
export const HERO_LEADING = "leading-[2.15rem]"

/**
 * The grid container: exactly as wide as its column and centered, so the text
 * never floats inside a wider box.
 */
export function StageGrid({
  children,
  className,
}: {
  children: ReactNode
  className?: string
}) {
  return (
    <div
      style={{ width: STAGE_COL_WIDTH }}
      className={cn("mx-auto", className)}
    >
      {children}
    </div>
  )
}

/** One row of the grid: an optional speaker label above the text. */
export function StageRow({
  speaker,
  labelClassName,
  children,
  className,
}: {
  speaker?: Turn["speaker"]
  labelClassName?: string
  children: ReactNode
  className?: string
}) {
  return (
    <div className={className}>
      {speaker && <SpeakerLabel speaker={speaker} className={labelClassName} />}
      {children}
    </div>
  )
}

export function SpeakerLabel({
  speaker,
  className,
}: {
  speaker: Turn["speaker"]
  className?: string
}) {
  return (
    <div
      className={cn(
        "mb-1 text-[10px] leading-4 font-medium tracking-[0.2em] text-muted-foreground/55 uppercase",
        className
      )}
    >
      {speaker === "learner" ? "You" : "Tutor"}
    </div>
  )
}
