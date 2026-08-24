import { redirect } from "next/navigation"

import { viewerOnServer } from "@/lib/viewer-server"

/**
 * Where Clerk lands every sign-in and sign-up. At that moment only Convex
 * knows whether this account has been through onboarding, so a fixed redirect
 * URL is always a guess — and a wrong guess shows up as a hop through the
 * wrong route (Yash, 2026-08-23). This route exists to make the guess right:
 * it asks and forwards, rendering nothing.
 */
export default async function GoPage() {
  const viewer = await viewerOnServer()
  if (!viewer) redirect("/")
  redirect(viewer.level ? "/home" : "/welcome")
}
