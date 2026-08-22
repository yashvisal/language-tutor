"use client"

/**
 * Home is the pre-flight. There is nothing else a learner comes here to do, so
 * the page is the balance line plus the same `SessionPreflight` the session
 * page uses — one component, two hosts, no second copy to drift.
 *
 * "Start talking" persists the plan and hands off to `/session?start=1`, which
 * connects immediately. The alternative — connecting here — would put the
 * conversation surface inside the sidebar shell, and the conversation owns the
 * whole viewport.
 */

import { useEffect, useState, useSyncExternalStore } from "react"
import { useRouter } from "next/navigation"
import { useQuery } from "convex/react"

import { SessionPreflight } from "@/components/session/session-preflight"
import { api } from "@/convex/_generated/api"
import type { SessionPlan } from "@/lib/session/contract"
import {
  planSnapshot,
  savePlan,
  serverPlanSnapshot,
  subscribeToPlan,
} from "@/lib/session/plan"

export default function HomePage() {
  const router = useRouter()
  const viewer = useQuery(api.users.viewer)

  const stored = useSyncExternalStore(
    subscribeToPlan,
    planSnapshot,
    serverPlanSnapshot
  )
  const [edited, setEdited] = useState<SessionPlan | null>(null)
  const plan = edited ?? stored

  // Signed in but never onboarded: no row, so no level and no free minutes.
  // Middleware can't tell — only Convex knows — so the redirect lives here.
  const needsWelcome = viewer !== undefined && viewer !== null && !viewer.level
  useEffect(() => {
    if (needsWelcome) router.replace("/welcome")
  }, [needsWelcome, router])

  // Nothing renders until the balance is known: a flash of "0 minutes left"
  // would be a lie about the one number the learner is here for. `null` is the
  // brief window before Clerk's token reaches Convex — middleware has already
  // guaranteed there is a session.
  if (viewer === undefined || viewer === null || needsWelcome) return null

  const { minutes } = viewer

  return (
    <SessionPreflight
      className="min-h-0 py-0 pb-24"
      above={
        <p className="mb-10 text-sm text-muted-foreground">
          {minutes} {minutes === 1 ? "minute" : "minutes"} left
        </p>
      }
      plan={plan}
      onChange={setEdited}
      connecting={false}
      error={null}
      onStart={() => {
        savePlan(plan)
        router.push("/session?start=1")
      }}
    />
  )
}
