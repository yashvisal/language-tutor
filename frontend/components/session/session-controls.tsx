"use client"

/**
 * The control bar. Everything here is one tap from the stage and nothing here
 * is labelled with state text — the surface itself says whether the session is
 * held.
 */

import {
  History,
  Languages,
  Mic,
  MicOff,
  Pause,
  PhoneOff,
  Play,
} from "lucide-react"

import { Button } from "@/components/ui/button"
import { Separator } from "@/components/ui/separator"
import { Switch } from "@/components/ui/switch"
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip"
import { cn } from "@/lib/utils"

export function SessionControls({
  paused,
  muted,
  showEn,
  onReview,
  onToggleMute,
  onToggleEn,
  onTogglePause,
  onEnd,
}: {
  paused: boolean
  muted: boolean
  showEn: boolean
  onReview: () => void
  onToggleMute: () => void
  onToggleEn: () => void
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
                className="rounded-full text-muted-foreground/70 hover:text-foreground"
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

        <label className="flex cursor-pointer items-center gap-2 px-2 select-none">
          <Languages className="size-3.5 text-muted-foreground" />
          <Switch size="sm" checked={showEn} onCheckedChange={onToggleEn} />
        </label>

        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                variant="ghost"
                size="icon-lg"
                onClick={onTogglePause}
                className={cn(
                  "rounded-full text-muted-foreground hover:text-foreground",
                  paused && "bg-primary/10 text-primary hover:text-primary"
                )}
              >
                {paused ? <Play /> : <Pause />}
              </Button>
            }
          />
          <TooltipContent>{paused ? "Resume" : "Hold"} · space</TooltipContent>
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
