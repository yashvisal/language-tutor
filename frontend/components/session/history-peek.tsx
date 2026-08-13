"use client"

/**
 * History — the escape hatch, not a surface. The stage carries only what the
 * current moment needs; everything older lives behind this overlay, which holds
 * the session for as long as it is open.
 */

import { useEffect, useRef } from "react"
import { X } from "lucide-react"
import { motion } from "motion/react"

import { SettledText } from "@/components/session/correction-mark"
import {
  ROW_LEADING,
  StageGrid,
  StageRow,
} from "@/components/session/stage-grid"
import { OVERLAY_ATTR } from "@/components/session/translate-overlay"
import { Button } from "@/components/ui/button"
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip"
import type { Turn } from "@/lib/session/contract"
import { cn } from "@/lib/utils"

export function HistoryPeek({
  turns,
  onClose,
}: {
  turns: Turn[]
  onClose: () => void
}) {
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return
      // One Escape, one layer: a translation open over the peek dismisses first.
      if (document.querySelector(`[${OVERLAY_ATTR}]`)) return
      onClose()
    }
    window.addEventListener("keydown", onKeyDown)
    return () => window.removeEventListener("keydown", onKeyDown)
  }, [onClose])

  /**
   * Dialog focus, both directions. The panel covers the stage (which the stage
   * marks `inert` while this is up), so focus must move into it on open or the
   * next Tab lands on nothing; and it must go back where it came from on close,
   * or a learner who opened this from the control bar loses their place.
   *
   * Two things the guards are for. The peek also opens from a wheel gesture,
   * where there is no trigger to return to. And the trigger is remembered in a
   * ref that ignores anything inside the panel: the stage is inert while this is
   * open, so a re-entrant mount (StrictMode's double-invoke, in dev) would read
   * `activeElement` as this dialog's own close button and hand focus nowhere.
   */
  const panelRef = useRef<HTMLDivElement>(null)
  const closeRef = useRef<HTMLButtonElement>(null)
  const trigger = useRef<HTMLElement | null>(null)
  useEffect(() => {
    const active = document.activeElement
    if (active instanceof HTMLElement && !panelRef.current?.contains(active)) {
      trigger.current = active
    }
    closeRef.current?.focus()
    return () => {
      if (trigger.current?.isConnected) trigger.current.focus()
    }
  }, [])

  return (
    <motion.div
      ref={panelRef}
      role="dialog"
      aria-modal="true"
      aria-label="Conversation history"
      initial={{ opacity: 0, y: -12 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: -12 }}
      transition={{ duration: 0.3, ease: [0.32, 0.72, 0, 1] }}
      className="absolute inset-0 z-20 bg-background/92 backdrop-blur-xl"
    >
      <div className="flex h-full flex-col">
        <div className="flex shrink-0 items-center justify-end px-4 pt-3">
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  ref={closeRef}
                  variant="ghost"
                  size="icon-sm"
                  onClick={onClose}
                  className="rounded-full text-muted-foreground/60 hover:text-foreground"
                >
                  <X />
                </Button>
              }
            />
            <TooltipContent side="left">Close and resume</TooltipContent>
          </Tooltip>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto px-6 pb-16">
          {/* Same grid as the stage, so history reads as the same document. */}
          <StageGrid className="space-y-7 pt-2">
            {turns.length === 0 && (
              <p className="pt-16 text-sm text-muted-foreground/60">
                Nothing to review yet.
              </p>
            )}
            {turns.map((turn) => (
              <StageRow key={turn.id} speaker={turn.speaker}>
                <p
                  className={cn(
                    "text-base tracking-[-0.011em]",
                    ROW_LEADING,
                    turn.speaker === "tutor"
                      ? "text-foreground/55"
                      : "text-foreground/90"
                  )}
                >
                  <SettledText turn={turn} />
                </p>
              </StageRow>
            ))}
          </StageGrid>
        </div>
      </div>
    </motion.div>
  )
}
