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
 * So the hand-off is in memory instead (mirrored to `sessionStorage`, see
 * below): the dashboard hands over the PLAN it was just given, immediately
 * before it navigates, and `/session` takes it once on mount. A reload or a shared link has nothing waiting and opens on
 * the pre-flight, which is exactly the guard the URL version was trying to
 * keep. The plan travels here rather than through storage because storage
 * remembers only the language and the level (`plan.ts`): what the learner
 * wants to talk about today is today's, and must not be pre-filled tomorrow.
 */

let pending: SessionPlan | null = null

/**
 * The same request, mirrored into `sessionStorage` so it survives a FULL page
 * load between `/home` and `/session`. Memory alone was not enough: when the
 * site has been redeployed since the dashboard tab loaded, Next turns the
 * client-side transition into a hard navigation, the module state dies with
 * the old page, and `/session` found nothing to start and bounced back to
 * `/home` (live, 2026-09-15, the first Start after PR #20 deployed).
 *
 * Still one-shot: `takeStartRequest` clears both copies, so a reload after
 * the session page has taken it opens on the pre-flight exactly as before.
 * Per-tab by nature of `sessionStorage`, so a second tab never inherits a
 * start it did not ask for. Storage is best-effort — private mode, quota —
 * and memory remains the primary copy.
 */
const STORAGE_KEY = "lengua.start-request"

function readStored(): SessionPlan | null {
  if (typeof window === "undefined") return null
  try {
    const raw = window.sessionStorage.getItem(STORAGE_KEY)
    return raw === null ? null : (JSON.parse(raw) as SessionPlan)
  } catch {
    return null
  }
}

function writeStored(plan: SessionPlan | null): void {
  if (typeof window === "undefined") return
  try {
    if (plan === null) window.sessionStorage.removeItem(STORAGE_KEY)
    else window.sessionStorage.setItem(STORAGE_KEY, JSON.stringify(plan))
  } catch {
    // Best-effort; memory still carries it within a client-side transition.
  }
}

/** The dashboard's Start: connect with this plan as soon as `/session` mounts. */
export function requestStart(plan: SessionPlan): void {
  pending = plan
  writeStored(plan)
}

/** Whether a start is waiting, without spending it — for the first render. */
export function startRequested(): boolean {
  return pending !== null || readStored() !== null
}

/** Spend the request: the plan to connect with, or `null` if none is waiting. */
export function takeStartRequest(): SessionPlan | null {
  const plan = pending ?? readStored()
  pending = null
  writeStored(null)
  return plan
}
