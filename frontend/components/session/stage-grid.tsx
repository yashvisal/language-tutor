"use client"

/**
 * The stage's one honest grid: a fixed-width target-language column plus a
 * collapsible anchor-language column.
 *
 * Every text row on the surface — pinned context, hero, and the history peek —
 * is a row of this grid, so all three share a left edge and a column structure
 * in both toggle states and throughout the transition. The Aura is deliberately
 * NOT part of it: it stays viewport-centered while the grid re-centers beneath.
 */

import type { ReactNode } from "react"
import { motion } from "motion/react"

import type { Turn } from "@/lib/session/contract"
import { cn } from "@/lib/utils"

export const ES_COL_W = 460
/** Anchor column width incl. its gutter, so the gap collapses with it. */
export const EN_COL_W = 264
export const EN_COL_GUTTER = 36

/** Line box shared by both columns on the body rows. */
export const ROW_LEADING = "leading-7"
/** Line box shared by both columns on the hero row. */
export const HERO_LEADING = "leading-[2.15rem]"

/** Shared tween so the column collapse and the grid re-center in sync. */
export const COL_TRANSITION = {
  duration: 0.5,
  ease: [0.32, 0.72, 0, 1] as const,
}

/**
 * The grid container: exactly as wide as its columns and centered, so the
 * target column never floats inside a wider box.
 */
export function StageGrid({
  showEn,
  children,
  className,
}: {
  showEn: boolean
  children: ReactNode
  className?: string
}) {
  return (
    <motion.div
      initial={false}
      animate={{ width: showEn ? ES_COL_W + EN_COL_W : ES_COL_W }}
      transition={COL_TRANSITION}
      className={cn("mx-auto", className)}
    >
      {children}
    </motion.div>
  )
}

/**
 * One row of the grid: speaker label, then target and anchor side by side.
 * The label is mirrored (invisibly) into the anchor cell so both columns open
 * with the same line box — otherwise `items-baseline` would pair the anchor's
 * first line with the *label*, not with the text it translates.
 */
export function StageRow({
  showEn,
  speaker,
  labelClassName,
  en,
  enClassName,
  children,
  className,
}: {
  showEn: boolean
  speaker?: Turn["speaker"]
  labelClassName?: string
  en?: ReactNode
  enClassName?: string
  children: ReactNode
  className?: string
}) {
  const label = speaker ? (
    <SpeakerLabel speaker={speaker} className={labelClassName} />
  ) : null

  return (
    <div className={cn("flex items-baseline", className)}>
      <div style={{ width: ES_COL_W }} className="shrink-0">
        {label}
        {children}
      </div>
      <EnCell showEn={showEn} className={enClassName}>
        {label && (
          <div aria-hidden className="invisible">
            {label}
          </div>
        )}
        {en}
      </EnCell>
    </div>
  )
}

/**
 * The collapsible anchor cell. Inner content keeps a fixed width so text never
 * reflows mid-animation — the column simply slides shut while the stage
 * re-centers around the target language.
 */
export function EnCell({
  showEn,
  children,
  className,
}: {
  showEn: boolean
  children?: ReactNode
  className?: string
}) {
  return (
    <motion.div
      initial={false}
      animate={{ width: showEn ? EN_COL_W : 0, opacity: showEn ? 1 : 0 }}
      transition={COL_TRANSITION}
      aria-hidden={!showEn}
      className="shrink-0 overflow-hidden"
    >
      <div
        style={{ width: EN_COL_W, paddingLeft: EN_COL_GUTTER }}
        className={cn("text-sm text-muted-foreground", ROW_LEADING, className)}
      >
        {children}
      </div>
    </motion.div>
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
        // Explicit leading: the mirrored copy lives inside the anchor cell,
        // which sets its own line-height, and the two must match exactly.
        "mb-1 text-[10px] leading-4 font-medium tracking-[0.2em] text-muted-foreground/55 uppercase",
        className
      )}
    >
      {speaker === "learner" ? "You" : "Tutor"}
    </div>
  )
}
