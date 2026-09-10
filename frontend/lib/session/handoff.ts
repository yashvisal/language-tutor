import type { SessionPlan } from "./contract"

/**
 * The `/home` → `/session` hand-off.
 *
 * It used to be `?start=1`. In the App Router a page's search params are part
 * of its segment key, so `router.replace("/session")` to spend the flag
 * REMOUNTED the page — a new `useSession`, a new Room — while the old one was
 * still minting its token. The token arrived (a session row opened) for a
 * Room nobody rendered, and the fresh mount showed the pre-flight again:
 * "another form", and an "already open in another tab" behind it
 * (live, 2026-09-08).
 *
 * So the hand-off is in memory instead: the dashboard hands over the PLAN it
 * was just given, immediately before it navigates, and `/session` takes it
 * once on mount. A reload or a shared link has nothing waiting and opens on
 * the pre-flight, which is exactly the guard the URL version was trying to
 * keep. The plan travels here rather than through storage because storage
 * remembers only the language and the level (`plan.ts`): what the learner
 * wants to talk about today is today's, and must not be pre-filled tomorrow.
 */

let pending: SessionPlan | null = null

/** The dashboard's Start: connect with this plan as soon as `/session` mounts. */
export function requestStart(plan: SessionPlan): void {
  pending = plan
}

/** Whether a start is waiting, without spending it — for the first render. */
export function startRequested(): boolean {
  return pending !== null
}

/** Spend the request: the plan to connect with, or `null` if none is waiting. */
export function takeStartRequest(): SessionPlan | null {
  const plan = pending
  pending = null
  return plan
}
