import { redirect } from "next/navigation"

import { AppHeader } from "@/components/app-shell/app-header"
import { viewerOnServer } from "@/lib/viewer-server"

/**
 * The chrome every signed-in page shares: one header, and the page under it.
 *
 * There was a sidebar here. It navigated between the dashboard and a settings
 * page with two fields in it — chrome for a product that doesn't exist yet —
 * so both are gone and settings is a popover on the avatar.
 *
 * The onboarding gate lives here, on the server, so an account that has never
 * been through /welcome is sent there before this shell exists — not after a
 * frame of it. Middleware has already guaranteed a Clerk session.
 *
 * `/session` is outside this group on purpose: the conversation surface owns
 * the whole viewport.
 */
export default async function AppLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  const viewer = await viewerOnServer()
  if (!viewer?.level) redirect("/welcome")

  return (
    <div className="flex min-h-svh flex-col bg-background">
      <AppHeader />
      <main className="flex-1">{children}</main>
    </div>
  )
}
