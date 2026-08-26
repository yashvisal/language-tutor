import { notFound } from "next/navigation"

import { DesignSidebar } from "@/components/design/design-sidebar"
import { ThemeToggle } from "@/components/theme-toggle"
import { VariantSwitcher } from "@/components/design/variant-switcher"
import { Separator } from "@/components/ui/separator"
import {
  SidebarInset,
  SidebarProvider,
  SidebarTrigger,
} from "@/components/ui/sidebar"
import { TooltipProvider } from "@/components/ui/tooltip"

export default function DesignInspoLayout({
  children,
}: {
  children: React.ReactNode
}) {
  // The design playground is a working surface, not a product surface: it
  // renders a mock conversation and links to internal briefs. It exists in
  // development and does not exist in production — a 404, not a redirect,
  // because there is nothing there for a stranger to be sent away from.
  if (process.env.NODE_ENV === "production") notFound()

  return (
    <TooltipProvider>
      <SidebarProvider>
        <DesignSidebar />
        <SidebarInset className="h-svh overflow-hidden">
          <header className="flex h-14 shrink-0 items-center gap-2 border-b px-4">
            <SidebarTrigger className="-ml-1" />
            <Separator orientation="vertical" className="mr-2 h-4" />
            <span className="text-sm font-medium">Language Tutor</span>
            <span className="text-sm text-muted-foreground">
              — design exploration
            </span>
            <div className="ml-auto">
              <ThemeToggle />
            </div>
          </header>
          <main className="min-h-0 flex-1 overflow-hidden">{children}</main>
          <VariantSwitcher />
        </SidebarInset>
      </SidebarProvider>
    </TooltipProvider>
  )
}
