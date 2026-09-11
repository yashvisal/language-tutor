import "server-only"

import { auth } from "@clerk/nextjs/server"
import { fetchMutation, fetchQuery } from "convex/nextjs"

import { api } from "@/convex/_generated/api"

/**
 * `users.viewer`, read on the server with the learner's own Clerk token.
 *
 * On the server for one reason: a decision that depends on Convex state —
 * "does this account have a row yet?" — must be made before anything renders.
 * Made on the client, it shows the learner one page and then swaps it for
 * another (the flash Yash hit, 2026-08-22). Middleware can't make it either:
 * Clerk knows the session, only Convex knows the row.
 *
 * Same "convex" JWT template the browser client uses, so the identity the
 * query sees is identical on both sides.
 */
/**
 * The viewer, with the account row made if this is the first visit.
 *
 * There was a `/welcome` page between sign-up and the dashboard whose one job
 * was to call `ensureUser` behind a Continue button; it asked nothing and
 * looked like a detour (Yash, 2026-09-11). The free minutes are promised on
 * the landing, so a new account should simply arrive with them. `ensureUser`
 * is idempotent, so a race between two first requests is harmless.
 */
export async function ensureViewerOnServer() {
  const { getToken } = await auth()
  const token = await getToken({ template: "convex" })
  if (!token) return null
  const viewer = await fetchQuery(api.users.viewer, {}, { token })
  if (viewer === null || viewer.onboarded) return viewer
  await fetchMutation(api.users.ensureUser, {}, { token })
  return fetchQuery(api.users.viewer, {}, { token })
}
