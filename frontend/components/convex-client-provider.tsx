"use client"

/**
 * Convex client bound to Clerk's session: `ConvexProviderWithClerk` fetches
 * the "convex" JWT template token from Clerk and hands it to Convex, so
 * `ctx.auth.getUserIdentity()` works in every query and mutation. Must mount
 * inside `ClerkProvider` (it calls `useAuth`).
 *
 * The client is module-level on purpose — one websocket for the app, not one
 * per render tree.
 */
import { useAuth } from "@clerk/nextjs"
import { ConvexReactClient } from "convex/react"
import { ConvexProviderWithClerk } from "convex/react-clerk"

import { requirePublicEnv } from "@/lib/env"

const convex = new ConvexReactClient(requirePublicEnv("NEXT_PUBLIC_CONVEX_URL"))

export function ConvexClientProvider({
  children,
}: {
  children: React.ReactNode
}) {
  return (
    <ConvexProviderWithClerk client={convex} useAuth={useAuth}>
      {children}
    </ConvexProviderWithClerk>
  )
}
