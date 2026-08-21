"use client"

/**
 * The control bar. Everything here is one tap from the stage and nothing here
 * is labelled with state text — the surface itself says whether the session is
 * held.
 */

import { History, Mic, MicOff, Pause, PhoneOff, Play } from "lucide-react"

import { Button } from "@/components/ui/button"
import { Separator } from "@/components/ui/separator"
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip"
import { cn } from "@/lib/utils"

export function SessionControls({
  paused,
  studyOpen,
  muted,
  onReview,
  onToggleMute,
  onTogglePause,
  onEnd,
}: {
  paused: boolean
  /**
   * Whether the study surface is up. Both stopping gestures open it, so both
   * buttons read as pressed while it is — the hold button is not the only one
   * that did something.
   */
  studyOpen: boolean
  muted: boolean
  onReview: () => void
  onToggleMute: () => void
  onTogglePause: () => void
  /** Absent in replay mode: there is nothing to hang up on. */
  onEnd?: () => void
}) {
  return (
    <div className="absolute bottom-6 left-1/2 z-10 -translate-x-1/2">
      <div className="flex items-center gap-1 rounded-full border border-border/60 bg-background/70 p-1.5 shadow-sm backdrop-blur-md">
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                variant="ghost"
                size="icon-lg"
                onClick={onReview}
                aria-label="Review — holds the session"
                aria-pressed={studyOpen}
                className={cn(
                  "rounded-full text-muted-foreground/70 hover:text-foreground",
                  studyOpen && "bg-primary/10 text-primary hover:text-primary"
                )}
              >
                <History />
              </Button>
            }
          />
          <TooltipContent>Review — holds the session</TooltipContent>
        </Tooltip>

        <Separator orientation="vertical" className="mx-0.5 h-4" />

        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                variant="ghost"
                size="icon-lg"
                onClick={onToggleMute}
                aria-label={muted ? "Unmute" : "Mute"}
                className={cn(
                  "rounded-full text-muted-foreground hover:text-foreground",
                  muted && "bg-muted text-foreground"
                )}
              >
                {muted ? <MicOff /> : <Mic />}
              </Button>
            }
          />
          <TooltipContent>{muted ? "Unmute" : "Mute"}</TooltipContent>
        </Tooltip>

        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                variant="ghost"
                size="icon-lg"
                onClick={onTogglePause}
                aria-label={paused ? "Resume" : "Hold — opens the study surface"}
                aria-pressed={paused}
                className={cn(
                  "rounded-full text-muted-foreground hover:text-foreground",
                  paused && "bg-primary/10 text-primary hover:text-primary"
                )}
              >
                {paused ? <Play /> : <Pause />}
              </Button>
            }
          />
          <TooltipContent>
            {paused ? "Resume" : "Hold · study"} · space
          </TooltipContent>
        </Tooltip>

        {onEnd && (
          <>
            <Separator orientation="vertical" className="mx-0.5 h-4" />
            <Tooltip>
              <TooltipTrigger
                render={
                  <Button
                    variant="ghost"
                    size="icon-lg"
                    onClick={onEnd}
                    aria-label="End session"
                    className="rounded-full text-muted-foreground hover:text-destructive"
                  >
                    <PhoneOff />
                  </Button>
                }
              />
              <TooltipContent>End session</TooltipContent>
            </Tooltip>
          </>
        )}
      </div>
    </div>
  )
}
