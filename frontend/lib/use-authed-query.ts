"use client"

/**
 * `useQuery`, but not before Convex knows who is asking.
 *
 * On a reload, Clerk loads first and Convex attaches its token a beat later.
 * In that beat the Convex client is unauthenticated, and a query that runs
 * then answers as it would for a stranger: `users.viewer` says `null` ("no
 * account"), `sessions.history` says `[]` ("nothing yet"). Every surface
 * that read those flashed its signed-out state on every reload — "Finish
 * setup", "We haven't finished setting up your account", an empty History —
 * and then corrected itself (live, 2026-09-09).
 *
 * So: skip until the client is authenticated, and report the wait as
 * `undefined`, which every caller already renders as "in flight". A learner
 * who really is signed out never reaches these surfaces — the server layouts
 * redirect first — so "not authenticated" here is only ever "not yet".
 */

import { useConvexAuth, useQuery } from "convex/react"
import type { FunctionReference } from "convex/server"

import { api } from "@/convex/_generated/api"

export function useAuthedQuery<Query extends FunctionReference<"query">>(
  query: Query,
  args: Query["_args"] | "skip"
): Query["_returnType"] | undefined {
  const { isAuthenticated } = useConvexAuth()
  const result = useQuery(query, isAuthenticated ? args : "skip")
  return isAuthenticated ? result : undefined
}

/** The signed-in learner, or `undefined` while either half is still loading. */
export function useViewer() {
  return useAuthedQuery(api.users.viewer, {})
}
