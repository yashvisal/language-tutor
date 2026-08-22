"use client"

/**
 * The account page. Two facts: who you are (Clerk's, read-only — its own
 * dropdown owns changing it) and how the tutor should pitch itself. No cards,
 * no danger zone; deleting an account is Clerk's job, and purchases and
 * sessions arrive here when they exist.
 */

import { useQuery, useMutation } from "convex/react"

import { api } from "@/convex/_generated/api"
import { LEVELS } from "@/lib/session/plan"
import { cn } from "@/lib/utils"

export default function SettingsPage() {
  const viewer = useQuery(api.users.viewer)
  const setLevel = useMutation(api.users.setLevel)

  if (viewer === undefined || viewer === null) return null

  return (
    <div className="flex justify-center px-8 pb-24">
      <div className="w-full max-w-xl">
        <h1 className="text-xl tracking-[-0.015em] text-foreground">
          Settings
        </h1>

        <section className="mt-10">
          <Label>Email</Label>
          <p className="mt-2 text-sm text-foreground">{viewer.email ?? "—"}</p>
        </section>

        <section className="mt-9">
          <Label>Your level</Label>
          <div
            role="radiogroup"
            aria-label="Your level"
            className="mt-3 flex flex-wrap gap-1.5"
          >
            {LEVELS.map((option) => (
              <button
                key={option.value}
                type="button"
                role="radio"
                aria-checked={viewer.level === option.value}
                // Optimistic by way of Convex: the query is reactive, so the
                // selection follows the write without local state to drift.
                onClick={() => void setLevel({ level: option.value })}
                className={cn(
                  "rounded-full border px-3 py-1 text-sm transition-colors outline-none focus-visible:ring-3 focus-visible:ring-ring/50",
                  viewer.level === option.value
                    ? "border-primary/40 bg-primary/10 text-foreground"
                    : "border-border/70 text-muted-foreground hover:border-border hover:text-foreground"
                )}
              >
                {option.label}
              </button>
            ))}
          </div>
        </section>
      </div>
    </div>
  )
}

function Label({ children }: { children: React.ReactNode }) {
  return (
    <p className="text-[10px] tracking-[0.14em] text-muted-foreground/50 uppercase">
      {children}
    </p>
  )
}
