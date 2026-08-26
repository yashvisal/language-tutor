"use client"

/**
 * The conversation, verbatim, after it is over.
 *
 * Collapsed by default and quiet when collapsed, because it is the least
 * useful thing on either screen that shows it: a learner looking back wants
 * what it was about, then the fixes, then the material — and only sometimes
 * the whole thing. A native `<details>` rather than a disclosure widget, so it
 * opens without JavaScript, animates nothing, and is already announced
 * correctly.
 *
 * Shared by the post-session summary and the History modal for the same reason
 * `review-material.tsx` is: they render one record, and one record should have
 * one appearance.
 */

import { ChevronRight } from "lucide-react"

import { TARGET_LANGUAGE } from "@/lib/session/protocol"
import { cn } from "@/lib/utils"

/** One line of the stored transcript — `transcriptTurnValidator`'s shape. */
export interface TranscriptTurn {
  role: "learner" | "tutor"
  text: string
}

export function TranscriptRecord({
  turns,
  className,
}: {
  turns: readonly TranscriptTurn[]
  className?: string
}) {
  if (turns.length === 0) return null

  return (
    <details className={cn("group", className)}>
      <summary className="flex cursor-pointer list-none items-center gap-1.5 rounded-md text-sm text-muted-foreground transition-colors duration-200 outline-none hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50 [&::-webkit-details-marker]:hidden">
        <ChevronRight
          aria-hidden
          className="size-3.5 shrink-0 transition-transform duration-200 group-open:rotate-90 motion-reduce:transition-none"
        />
        Transcript
        <span className="text-xs text-muted-foreground tabular-nums">
          · {turns.length} {turns.length === 1 ? "turn" : "turns"}
        </span>
      </summary>

      {/* Both sides are speaking the target language — that is the point of
          the session — so both lines carry the same `lang`. */}
      <ol className="mt-3 space-y-2.5">
        {turns.map((turn, index) => (
          <li key={index} className="flex gap-3 text-sm">
            <span className="w-14 shrink-0 pt-px text-xs text-muted-foreground">
              {turn.role === "learner" ? "You" : "Tutor"}
            </span>
            <span
              lang={TARGET_LANGUAGE}
              className="min-w-0 flex-1 leading-relaxed text-foreground"
            >
              {turn.text}
            </span>
          </li>
        ))}
      </ol>
    </details>
  )
}
