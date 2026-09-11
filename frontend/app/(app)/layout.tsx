import { redirect } from "next/navigation"

import { AppHeader } from "@/components/app-shell/app-header"
import { ensureViewerOnServer } from "@/lib/viewer-server"

/**
 * The chrome every signed-in page shares: one header, and the page under it.
 *
 * There was a sidebar here. It navigated between the dashboard and a settings
 * page with two fields in it — chrome for a product that doesn't exist yet —
 * so both are gone and settings is a popover on the avatar.
 *
 * A first visit makes the account row and its free minutes here, on the
 * server, before this shell exists — there is no onboarding page any more, so
 * sign-up lands straight on the dashboard with the minutes the landing
 * promised. Middleware has already guaranteed a Clerk session.
 *
 * `/session` is outside this group on purpose: the conversation surface owns
 * the whole viewport.
 */
export default async function AppLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  const viewer = await ensureViewerOnServer()
  if (viewer === null) redirect("/")

  return (
    <div className="flex min-h-svh flex-col bg-background">
      <AppHeader />
      <main className="flex-1">{children}</main>
    </div>
  )
}
