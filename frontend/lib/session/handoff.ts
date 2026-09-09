/**
 * The `/home` → `/session` hand-off.
 *
 * It used to be `?start=1`. In the App Router a page's search params are part
 * of its segment key, so `router.replace("/session")` to spend the flag
 * REMOUNTED the page — a new `useSession`, a new Room — while the old one was
 * still minting its token. The token arrived (a session row opened) for a
 * Room nobody rendered, and the fresh mount showed the pre-flight again:
 * "another form", and a 15-minute "already open in another tab" behind it
 * (live, 2026-09-08).
 *
 * So the flag is in memory instead: set by the dashboard immediately before
 * it navigates, read once by `/session` on mount. A reload or a shared link
 * has no flag and opens on the pre-flight, which is exactly the guard the
 * URL version was trying to keep.
 */

let requested = false

/** The dashboard's Start: connect as soon as `/session` mounts. */
export function requestStart(): void {
  requested = true
}

/** Whether a start is waiting, without spending it — for the first render. */
export function startRequested(): boolean {
  return requested
}

/** Spend the request. Returns whether there was one. */
export function takeStartRequest(): boolean {
  const was = requested
  requested = false
  return was
}
