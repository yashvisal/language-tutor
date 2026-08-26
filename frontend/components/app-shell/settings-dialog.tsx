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

import { LevelPicker } from "@/components/level-picker"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { api } from "@/convex/_generated/api"
import type { LevelValue } from "@/lib/session/plan"

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

        <div className="max-h-[55svh] [scrollbar-width:thin] [scrollbar-color:var(--border)_transparent] space-y-6 overflow-y-auto px-6 py-1">
          <div className="space-y-3">
            <Field label="Name" value={user?.fullName || "—"} />
            <Field
              label="Email"
              value={
                viewer?.email ?? user?.primaryEmailAddress?.emailAddress ?? "—"
              }
            />
          </div>

          <div>
            <p className="text-sm font-medium text-foreground">Your level</p>
            <p className="mt-1 text-sm text-muted-foreground">
              Changes how much the tutor helps. You can move it any time.
            </p>
            {/* The same component onboarding asks with, so the level is asked
                once in one shape — and, more to the point, under one a11y
                contract: a real `radiogroup` with a single tab stop and arrow
                keys that move and select. The hand-rolled copy that used to
                live here was three tab stops of `aria-pressed` buttons. */}
            <LevelPicker
              value={level}
              onChange={(next: LevelValue) => {
                setError(null)
                setLevel({ level: next }).catch(() =>
                  setError("Couldn’t save. Try again.")
                )
              }}
              label="Your level"
              className="mt-3"
            />
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
