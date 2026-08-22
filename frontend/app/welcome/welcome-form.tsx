"use client"

import { useState } from "react"
import { useRouter } from "next/navigation"
import { useMutation } from "convex/react"

import { LevelPicker } from "@/components/level-picker"
import { Button } from "@/components/ui/button"
import { api } from "@/convex/_generated/api"
import { SIGNUP_GRANT_MINUTES } from "@/lib/billing"
import { DEFAULT_LEVEL } from "@/lib/session/plan"

/**
 * The one onboarding question. The page around this has already decided, on
 * the server, that this account needs asking — so the form never has to check
 * and never has to redirect itself away.
 */
export function WelcomeForm() {
  const router = useRouter()
  const ensureUser = useMutation(api.users.ensureUser)

  const [level, setLevel] = useState(DEFAULT_LEVEL)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

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
