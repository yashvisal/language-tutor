import { UserButton } from "@clerk/nextjs"

import { AppSidebar } from "@/components/app-shell/app-sidebar"
import {
  SidebarInset,
  SidebarProvider,
  SidebarTrigger,
} from "@/components/ui/sidebar"

/**
 * The chrome every signed-in page shares: a sidebar and a header, and nothing
 * else. The header is deliberately empty apart from the two controls that have
 * to live there — collapsing the sidebar, and the account menu — so the page
 * below it starts on a quiet surface.
 *
 * `/session` is outside this group on purpose: the conversation surface owns
 * the whole viewport.
 */
export default function AppLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
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
