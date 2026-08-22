"use client"

/**
 * Onboarding, once. One question — the level the tutor should pitch at — and
 * the only promise we make about money, in the learner's units: minutes.
 *
 * Outside the app shell on purpose. A sidebar with two links the learner
 * hasn't earned yet is chrome around a single question.
 */

import { useEffect, useState } from "react"
import { useRouter } from "next/navigation"
import { useMutation, useQuery } from "convex/react"

import { LevelPicker } from "@/components/level-picker"
import { Button } from "@/components/ui/button"
import { api } from "@/convex/_generated/api"
import { SIGNUP_GRANT_MINUTES } from "@/lib/billing"
import { DEFAULT_LEVEL } from "@/lib/session/plan"

export default function WelcomePage() {
  const router = useRouter()
  const viewer = useQuery(api.users.viewer)
  const ensureUser = useMutation(api.users.ensureUser)

  const [level, setLevel] = useState(DEFAULT_LEVEL)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Onboarding is a one-time screen; someone who already answered gets sent
  // on rather than asked again.
  const done = viewer !== undefined && viewer !== null && Boolean(viewer.level)
  useEffect(() => {
    if (done) router.replace("/home")
  }, [done, router])

  const submit = async () => {
    setSaving(true)
    setError(null)
    try {
      await ensureUser({ level })
      router.replace("/home")
    } catch {
      // The mutation is idempotent, so retrying is always safe.
      setError("Something went wrong. Try again.")
      setSaving(false)
    }
  }

  // `null` is signed-out *or* the brief window before Clerk's token reaches
  // Convex; middleware has already guaranteed a session, so it is the latter.
  // Asking the question during it would flash a form that then redirects.
  if (viewer === undefined || viewer === null || done) return null

  return (
    <div className="flex min-h-svh justify-center bg-background px-8 py-[clamp(4rem,16vh,9rem)]">
      <div className="w-full max-w-md">
        <h1 className="text-xl tracking-[-0.015em] text-foreground">
          Where are you with Spanish?
        </h1>
        <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
          It only steers where the tutor starts — you can change it any time.
        </p>

        <LevelPicker
          value={level}
          onChange={setLevel}
          variant="stacked"
          className="mt-8"
        />

        <p className="mt-8 text-sm text-muted-foreground">
          You have {SIGNUP_GRANT_MINUTES} free minutes. Pausing to study
          doesn’t use them.
        </p>

        <Button size="lg" onClick={submit} disabled={saving} className="mt-6">
          {saving ? "One moment…" : "Continue"}
        </Button>
        {error && (
          <p role="alert" className="mt-4 text-xs text-destructive">
            {error}
          </p>
        )}
      </div>
    </div>
  )
}
