import { redirect } from "next/navigation"
import { UserButton } from "@clerk/nextjs"

import { AppSidebar } from "@/components/app-shell/app-sidebar"
import {
  SidebarInset,
  SidebarProvider,
  SidebarTrigger,
} from "@/components/ui/sidebar"
import { viewerOnServer } from "@/lib/viewer-server"

/**
 * The chrome every signed-in page shares: a sidebar and a header, and nothing
 * else. The header is deliberately empty apart from the two controls that have
 * to live there — collapsing the sidebar, and the account menu — so the page
 * below it starts on a quiet surface.
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
    <SidebarProvider>
      <AppSidebar />
      <SidebarInset>
        <header className="flex h-14 shrink-0 items-center justify-between gap-4 px-4 sm:px-6">
          <SidebarTrigger className="text-muted-foreground" />
          {/* Clerk's own dropdown handles account and sign-out; wrapping it in
              a second menu would just be two menus. */}
          <UserButton />
        </header>
        {children}
      </SidebarInset>
    </SidebarProvider>
  )
}
