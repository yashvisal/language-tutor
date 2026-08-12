"use client"

/**
 * History — the escape hatch, not a surface. The stage carries only what the
 * current moment needs; everything older lives behind this overlay, which holds
 * the session for as long as it is open.
 */

import { useEffect } from "react"
import { X } from "lucide-react"
import { motion } from "motion/react"

import { SettledText } from "@/components/session/correction-mark"
import {
  ROW_LEADING,
  StageGrid,
  StageRow,
} from "@/components/session/stage-grid"
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
      if (e.key === "Escape") onClose()
    }
    window.addEventListener("keydown", onKeyDown)
    return () => window.removeEventListener("keydown", onKeyDown)
  }, [onClose])

  return (
    <motion.div
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
