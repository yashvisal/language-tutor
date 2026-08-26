"use client"

/**
 * The dashboard's one live region: the time left, and the door into a
 * session. One panel, two halves — the number on the left, the button on the
 * right — because they are one decision: the button's label and whether it
 * works at all are functions of the balance.
 *
 * The number is exact (`m:ss`), not a rounded minute count: the meter counts
 * seconds, so the balance is shown in seconds. It does not tick here — the
 * balance only changes when a session debits it, and Convex pushes that.
 *
 * The plan picker lives in a modal behind the button: a learner arriving at
 * `/home` is not here to fill in a form, and the questions are optional
 * anyway. Start persists the plan and hands off to `/session?start=1`, which
 * connects immediately.
 */

import { useState, useSyncExternalStore } from "react"
import Link from "next/link"
import { useRouter } from "next/navigation"
import { useQuery } from "convex/react"

import { PlanCards } from "@/components/session/session-preflight"
import { CARD_CLASS } from "@/components/surface"
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
import { LOW_BALANCE_SECONDS, formatClock } from "@/lib/billing"
import type { SessionPlan } from "@/lib/session/contract"
import {
  planSnapshot,
  savePlan,
  serverPlanSnapshot,
  subscribeToPlan,
} from "@/lib/session/plan"
import { cn } from "@/lib/utils"

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

  /**
   * Three states, and the middle one used to be invisible. `undefined` is the
   * query in flight; `null` is a signed-in Clerk session with no `users` row
   * behind it — a webhook that never fired, a half-finished sign-up — and it
   * left Start permanently disabled with nothing on screen explaining why
   * (audit §4.13). `/welcome` is where a row gets made, so that is the offer.
   */
  const loading = viewer === undefined
  const missing = viewer === null
  const seconds = viewer?.seconds
  const known = seconds !== undefined
  const empty = known && seconds <= 0
  const low = known && !empty && seconds < LOW_BALANCE_SECONDS

  return (
    <>
      <section
        className={cn(
          CARD_CLASS,
          "flex flex-col gap-6 sm:flex-row sm:items-center sm:justify-between"
        )}
      >
        <div>
          <p className="text-sm text-muted-foreground">Time left</p>
          {/* Reserved height so nothing renders until the balance is known —
              a flash of "0:00" is a lie about the one number on this page. */}
          <p
            className={cn(
              "mt-1 min-h-10 text-4xl font-semibold tracking-tight tabular-nums",
              low || empty ? "text-primary" : "text-foreground"
            )}
          >
            {known && formatClock(seconds)}
          </p>
          <p className="mt-1.5 text-sm text-muted-foreground">
            {missing ? (
              <>
                We haven&rsquo;t finished setting up your account.{" "}
                <Link
                  href="/welcome"
                  className="text-foreground underline decoration-foreground/30 underline-offset-4 transition-colors duration-200 hover:decoration-foreground"
                >
                  Finish setup
                </Link>
                .
              </>
            ) : empty ? (
              "Talking uses time. Studying never does."
            ) : low ? (
              "Enough for a short conversation."
            ) : (
              "Counts only while you talk."
            )}
          </p>
        </div>

        {empty ? (
          // Payments are not built, so the empty state has nowhere to send
          // anyone. The affordance is here so the shape is the real one.
          <Tooltip>
            {/* A span, not the button: a disabled button takes no pointer
                events, so it can never be its own tooltip trigger. */}
            <TooltipTrigger render={<span className="shrink-0" />}>
              <Button size="lg" disabled>
                Get minutes
              </Button>
            </TooltipTrigger>
            <TooltipContent>Coming soon</TooltipContent>
          </Tooltip>
        ) : (
          <Button
            size="lg"
            // Disabled while the balance is unknown — which is the query in
            // flight, and no longer "forever, because there is no row".
            disabled={loading || missing}
            onClick={() => setOpen(true)}
            className="shrink-0 transition-[transform,box-shadow,background-color] duration-200 hover:shadow-md"
          >
            Start a conversation
          </Button>
        )}
      </section>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="gap-0 overflow-hidden p-0 sm:max-w-md">
          {/* An eyebrow, not a heading: the question is the card's one
              headline, so the dialog's own title steps back to a label. */}
          <DialogHeader className="px-6 pt-5 pb-4 text-left">
            <DialogTitle className="text-xs font-medium tracking-[0.08em] text-muted-foreground uppercase">
              Start a conversation
            </DialogTitle>
            <DialogDescription className="sr-only">
              Three quick questions — skip any. Microphone required.
            </DialogDescription>
          </DialogHeader>

          {/* Keyed on `open` so a reopened modal asks the first question
              again rather than resuming a walk the learner abandoned. */}
          <PlanCards
            key={String(open)}
            plan={plan}
            onChange={setEdited}
            bodyClassName="px-6 pb-6"
            footerClassName="px-6 py-4"
            onStart={(finalPlan) => {
              savePlan(finalPlan)
              router.push("/session?start=1")
            }}
          />
        </DialogContent>
      </Dialog>
    </>
  )
}
