"use client"

/**
 * Everything about the account that is ours to change — which, deliberately, is
 * one thing: the level the tutor pitches at.
 *
 * Name and email are read-only here. They belong to Clerk, and a second place
 * to edit them would be a second source of truth for an identity we don't own.
 *
 * The level list is not local state. The write goes to Convex and the checked
 * pill follows the reactive `users.viewer` query back — optimistic without a
 * copy that can drift, and a failed write simply never moves the selection.
 */

import { useState } from "react"
import { useUser } from "@clerk/nextjs"
import { useMutation, useQuery } from "convex/react"
import { Check } from "lucide-react"

import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { api } from "@/convex/_generated/api"
import { LEVELS, type LevelValue } from "@/lib/session/plan"
import { cn } from "@/lib/utils"

export function SettingsDialog({
  open,
  onOpenChange,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const { user } = useUser()
  const viewer = useQuery(api.users.viewer)
  const setLevel = useMutation(api.users.setLevel)
  const [error, setError] = useState<string | null>(null)

  const level = viewer?.level ?? null

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="gap-0 overflow-hidden p-0 sm:max-w-md">
        <DialogHeader className="px-6 pt-6 pb-4 text-left">
          <DialogTitle className="text-lg font-semibold tracking-tight">
            Settings
          </DialogTitle>
          <DialogDescription>
            Your account, and how the tutor pitches a conversation.
          </DialogDescription>
        </DialogHeader>

        <div className="max-h-[55svh] space-y-6 overflow-y-auto px-6 py-1 [scrollbar-width:thin] [scrollbar-color:var(--border)_transparent]">
          <div className="space-y-3">
            <Field label="Name" value={user?.fullName || "—"} />
            <Field
              label="Email"
              value={viewer?.email ?? user?.primaryEmailAddress?.emailAddress ?? "—"}
            />
          </div>

          <div>
            <p className="text-sm font-medium text-foreground">Your level</p>
            <p className="mt-1 text-sm text-muted-foreground">
              Changes how much the tutor helps. You can move it any time.
            </p>
            <div
              role="group"
              aria-label="Your level"
              className="mt-3 flex flex-col gap-2"
            >
              {LEVELS.map((option) => {
                const selected = option.value === level
                return (
                  <button
                    key={option.value}
                    type="button"
                    aria-pressed={selected}
                    onClick={() => {
                      setError(null)
                      setLevel({ level: option.value as LevelValue }).catch(() =>
                        setError("Couldn’t save. Try again.")
                      )
                    }}
                    className={cn(
                      "flex items-center justify-between gap-3 rounded-xl border px-3.5 py-2.5 text-left text-sm transition-[background-color,border-color,color] duration-200 outline-none focus-visible:ring-3 focus-visible:ring-ring/50",
                      selected
                        ? "border-primary/40 bg-primary/10 text-foreground"
                        : "border-border/70 text-muted-foreground hover:border-border hover:text-foreground"
                    )}
                  >
                    {option.label}
                    {selected && (
                      <Check aria-hidden className="size-4 shrink-0 text-primary" />
                    )}
                  </button>
                )
              })}
            </div>
            {error && (
              <p role="alert" className="mt-2 text-xs text-destructive">
                {error}
              </p>
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

/** A read-only row: what it is, and what it says. Clerk owns both values. */
function Field({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-4">
      <span className="text-sm text-muted-foreground">{label}</span>
      <span className="truncate text-sm text-foreground">{value}</span>
    </div>
  )
}
