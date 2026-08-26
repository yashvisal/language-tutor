"use client"

/**
 * The money side of the account, in the order a learner asks about it: how much
 * time is left, what more costs, and where the last of it went.
 *
 * The balance is the same exact `m:ss` the dashboard prints, from the same
 * helper — a header that says 4:12 and a dialog that says "4 minutes" would be
 * two answers to one question.
 *
 * Packs are quoted from `MINUTE_PACKS`, the one home for those numbers, and are
 * disabled: checkout is not built, and an affordance that goes nowhere should
 * at least say so.
 */

import { useQuery } from "convex/react"

import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { api } from "@/convex/_generated/api"
import { MINUTE_PACKS, formatClock } from "@/lib/billing"
import { cn } from "@/lib/utils"

export function BillingDialog({
  open,
  onOpenChange,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const viewer = useQuery(api.users.viewer)
  const ledger = useQuery(api.users.ledger)

  const seconds = viewer?.seconds
  const known = seconds !== undefined

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="gap-0 overflow-hidden p-0 sm:max-w-md">
        <DialogHeader className="px-6 pt-6 pb-4 text-left">
          <DialogTitle className="text-lg font-semibold tracking-tight">
            Billing
          </DialogTitle>
        </DialogHeader>

        <div className="max-h-[60svh] [scrollbar-width:thin] [scrollbar-color:var(--border)_transparent] space-y-6 overflow-y-auto px-6 py-1">
          <div>
            <p className="text-sm text-muted-foreground">Time left</p>
            {/* Reserved height: a flash of "0:00" is a lie about the one
                number this dialog exists to show. */}
            <p className="mt-1 min-h-10 text-4xl font-semibold tracking-tight text-foreground tabular-nums">
              {known && formatClock(seconds)}
            </p>
            <p className="mt-1.5 text-sm text-muted-foreground">
              Counts only while you talk. Pausing to study is free.
            </p>
          </div>

          <div>
            <p className="text-sm font-medium text-foreground">Minute packs</p>
            <div className="mt-3 grid grid-cols-1 gap-2 sm:grid-cols-3">
              {MINUTE_PACKS.map((pack) => (
                <div
                  key={pack.minutes}
                  className="flex flex-col gap-2 rounded-xl border border-border/70 p-3"
                >
                  <div>
                    <p className="text-sm font-medium text-foreground tabular-nums">
                      {pack.minutes} min
                    </p>
                    <p className="text-sm text-muted-foreground tabular-nums">
                      {pack.price}
                    </p>
                  </div>
                  <Button
                    size="sm"
                    variant="outline"
                    disabled
                    className="mt-auto w-full text-xs"
                  >
                    Coming soon
                  </Button>
                </div>
              ))}
            </div>
          </div>

          <div>
            <p className="text-sm font-medium text-foreground">
              Recent activity
            </p>
            {ledger !== undefined && ledger.length === 0 && (
              <p className="mt-2 text-sm text-muted-foreground">Nothing yet.</p>
            )}
            {ledger !== undefined && ledger.length > 0 && (
              <ul className="mt-2 divide-y divide-foreground/[0.06] dark:divide-white/10">
                {ledger.map((entry) => {
                  const credit = entry.seconds >= 0
                  return (
                    <li
                      key={entry.id}
                      className="flex items-baseline justify-between gap-4 py-2"
                    >
                      <span className="min-w-0 truncate text-sm text-foreground">
                        {reasonFor(entry.kind, entry.seconds)}
                      </span>
                      <span className="shrink-0 text-xs text-muted-foreground tabular-nums">
                        {formatDate(entry.createdAt)}
                      </span>
                      <span
                        className={cn(
                          "w-16 shrink-0 text-right text-sm tabular-nums",
                          credit ? "text-primary" : "text-foreground"
                        )}
                      >
                        {credit ? "+" : "−"}
                        {formatClock(Math.abs(entry.seconds))}
                      </span>
                    </li>
                  )
                })}
              </ul>
            )}
          </div>
        </div>

        <div className="flex items-center justify-end gap-4 border-t border-foreground/[0.06] px-6 py-4 dark:border-white/10">
          <Button onClick={() => onOpenChange(false)}>Done</Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}

/** A ledger `kind` as the learner would describe it. An adjustment can go
 * either way, so its wording follows the sign rather than the kind. */
function reasonFor(kind: string, seconds: number): string {
  switch (kind) {
    case "signup_grant":
      return "Welcome minutes"
    case "purchase":
      return "Minutes added"
    case "debit":
      return "Conversation"
    case "adjustment":
      return seconds >= 0 ? "Minutes added" : "Adjustment"
    default:
      return "Adjustment"
  }
}

/** Short and local: "Aug 24". The year is noise for a 20-row list. */
function formatDate(ms: number): string {
  return new Date(ms).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
  })
}
