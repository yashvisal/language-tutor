import "server-only"

import { auth } from "@clerk/nextjs/server"
import { fetchQuery } from "convex/nextjs"

import { api } from "@/convex/_generated/api"

/**
 * `users.viewer`, read on the server with the learner's own Clerk token.
 *
 * Exists for one reason: routing decisions that depend on Convex state — "has
 * this account been through /welcome?" — must be made before anything renders.
 * Made on the client, the same decision shows the learner one page and then
 * swaps it for another (the flash Yash hit, 2026-08-22). Middleware can't make
 * it either: Clerk knows the session, only Convex knows the row.
 *
 * Same "convex" JWT template the browser client uses, so the identity the
 * query sees is identical on both sides.
 */
export async function viewerOnServer() {
  const { getToken } = await auth()
  const token = await getToken({ template: "convex" })
  if (!token) return null
  return fetchQuery(api.users.viewer, {}, { token })
}
