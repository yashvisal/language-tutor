"use client"

/**
 * The account page. Two facts: who you are (Clerk's, read-only — its own
 * dropdown owns changing it) and how the tutor should pitch itself. No cards,
 * no danger zone; deleting an account is Clerk's job, and purchases and
 * sessions arrive here when they exist.
 */

import { useEffect, useState } from "react"
import { useRouter } from "next/navigation"
import { useQuery, useMutation } from "convex/react"

import { LevelPicker } from "@/components/level-picker"
import { Overline } from "@/components/overline"
import { api } from "@/convex/_generated/api"

export default function SettingsPage() {
  const router = useRouter()
  const viewer = useQuery(api.users.viewer)
  const setLevel = useMutation(api.users.setLevel)
  const [error, setError] = useState<string | null>(null)

  // `viewer` is non-null for any signed-in identity, row or no row: a learner
  // who never finished onboarding has no level and no free minutes, and Convex
  // is the only thing that knows it. Same redirect as `/home`.
  const needsWelcome = viewer !== undefined && viewer !== null && !viewer.level
  useEffect(() => {
    if (needsWelcome) router.replace("/welcome")
  }, [needsWelcome, router])

  if (viewer === undefined || viewer === null || needsWelcome) return null

  return (
    <div className="flex justify-center px-8 pb-24">
      <div className="w-full max-w-xl">
        <h1 className="text-xl tracking-[-0.015em] text-foreground">
          Settings
        </h1>

        <section className="mt-10">
          <Overline>Email</Overline>
          <p className="mt-2 text-sm text-foreground">{viewer.email ?? "—"}</p>
        </section>

        <section className="mt-9">
          <Overline>Your level</Overline>
          {/* Optimistic by way of Convex: the query is reactive, so the
              selection follows the write without local state to drift. A
              failed write therefore shows nothing at all unless we say so. */}
          <LevelPicker
            value={viewer.level}
            onChange={(value) => {
              setError(null)
              setLevel({ level: value }).catch(() => {
                setError("Couldn’t save. Try again.")
              })
            }}
            variant="inline"
            className="mt-3"
          />
          {error && (
            <p role="alert" className="mt-3 text-xs text-destructive">
              {error}
            </p>
          )}
        </section>
      </div>
    </div>
  )
}
