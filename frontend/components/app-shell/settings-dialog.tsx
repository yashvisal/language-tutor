"use client"

/** Account details. Language and level belong to each session. */

import { useUser } from "@clerk/nextjs"

import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { useViewer } from "@/lib/use-authed-query"

export function SettingsDialog({
  open,
  onOpenChange,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const { user } = useUser()
  const viewer = useViewer()

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="gap-0 overflow-hidden p-0 sm:max-w-md">
        <DialogHeader className="px-6 pt-6 pb-4 text-left">
          <DialogTitle className="text-lg font-semibold tracking-tight">
            Settings
          </DialogTitle>
          <DialogDescription>Your account.</DialogDescription>
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
