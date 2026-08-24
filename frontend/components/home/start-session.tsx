"use client"

/**
 * The dashboard's one live region: the balance, and the door into a session.
 *
 * They are one component because they are one decision — the button's label and
 * whether it works at all are functions of the balance, and splitting them
 * would mean two subscriptions to the same query disagreeing for a frame.
 *
 * The plan picker used to be the page. It is a modal now: a learner arriving at
 * `/home` is not here to fill in a form, and the questions are optional anyway.
 * Start persists the plan and hands off to `/session?start=1`, which connects
 * immediately — connecting here would put the conversation surface inside the
 * app shell, and the conversation owns the whole viewport.
 */

import { useState, useSyncExternalStore } from "react"
import { useRouter } from "next/navigation"
import { useQuery } from "convex/react"
import { Timer } from "lucide-react"

import { PlanFields } from "@/components/session/session-preflight"
import { CARD_CLASS, IconBadge } from "@/components/surface"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip"
import { api } from "@/convex/_generated/api"
import type { SessionPlan } from "@/lib/session/contract"
import {
  planSnapshot,
  savePlan,
  serverPlanSnapshot,
  subscribeToPlan,
} from "@/lib/session/plan"
import { cn } from "@/lib/utils"

/** The balance below which a session is short rather than full. One credit. */
const FULL_SESSION_MINUTES = 10

export function StartSession() {
  const router = useRouter()
  const viewer = useQuery(api.users.viewer)

  const stored = useSyncExternalStore(
    subscribeToPlan,
    planSnapshot,
    serverPlanSnapshot
  )
  const [edited, setEdited] = useState<SessionPlan | null>(null)
  const [open, setOpen] = useState(false)

  // The level the learner already declared wins over whatever last session's
  // stored plan carried — the profile is the answer they gave on purpose.
  const plan = edited ?? { ...stored, level: viewer?.level ?? stored.level }

  const minutes = viewer?.minutes
  const empty = minutes === 0
  const low = minutes !== undefined && minutes > 0 && minutes < FULL_SESSION_MINUTES

  return (
    <>
      <section className={CARD_CLASS}>
        <IconBadge icon={Timer} />
        {/* Nothing until the balance is known: a flash of "0 minutes left" is a
            lie about the one number this card exists to say. */}
        <div className="mt-5 min-h-16">
          {minutes !== undefined && (
            <>
              {empty ? (
                <p className="text-2xl font-semibold tracking-tight text-foreground">
                  No minutes left
                </p>
              ) : (
                <p className="flex items-baseline gap-2">
                  <span
                    className={cn(
                      "text-4xl font-semibold tracking-tight tabular-nums",
                      low ? "text-primary" : "text-foreground"
                    )}
                  >
                    {minutes}
                  </span>
                  <span className="text-sm text-muted-foreground">
                    {minutes === 1 ? "minute left" : "minutes left"}
                  </span>
                </p>
              )}
              <p className="mt-2 text-sm text-muted-foreground">
                {empty
                  ? "Minutes are for talking. Studying is free."
                  : low
                    ? "Enough for a shorter session."
                    : "Minutes count only while you're talking."}
              </p>
            </>
          )}
        </div>
      </section>

      {empty ? (
        // Payments are not built, so the empty state has nowhere to send
        // anyone. The affordance is here so the shape is the real one.
        <Tooltip>
          {/* A span, not the button: a disabled button takes no pointer
              events, so it can never be its own tooltip trigger. */}
          <TooltipTrigger render={<span className="self-start" />}>
            <Button size="lg" disabled className="h-11 px-6 text-base">
              Get minutes
            </Button>
          </TooltipTrigger>
          <TooltipContent>Coming soon</TooltipContent>
        </Tooltip>
      ) : (
        <Button
          size="lg"
          disabled={minutes === undefined}
          onClick={() => setOpen(true)}
          className="h-11 self-start px-6 text-base transition-[transform,box-shadow,background-color] duration-200 hover:shadow-md"
        >
          Start a conversation
        </Button>
      )}

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-h-[85svh] gap-0 overflow-y-auto p-6 sm:max-w-lg">
          <DialogHeader>
            <DialogTitle className="text-lg">
              What do you want to talk about?
            </DialogTitle>
            <DialogDescription>
              Everything here is optional — the tutor will ask if you skip it.
            </DialogDescription>
          </DialogHeader>

          <PlanFields
            plan={plan}
            onChange={setEdited}
            levelHint="from your profile"
            className="mt-7"
          />

          <div className="mt-8 border-t border-foreground/[0.08] pt-5">
            <Button
              size="lg"
              onClick={() => {
                savePlan(plan)
                router.push("/session?start=1")
              }}
            >
              Start
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </>
  )
}
