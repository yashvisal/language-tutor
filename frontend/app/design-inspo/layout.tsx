import { DesignSidebar } from "@/components/design/design-sidebar"
import { ThemeToggle } from "@/components/design/theme-toggle"
import { VariantSwitcher } from "@/components/design/variant-switcher"
import { Separator } from "@/components/ui/separator"
import { SidebarInset, SidebarProvider, SidebarTrigger } from "@/components/ui/sidebar"
import { TooltipProvider } from "@/components/ui/tooltip"

export default function DesignInspoLayout({
  children,
}: {
  children: React.ReactNode
}) {
  return (
    <TooltipProvider>
      <SidebarProvider>
        <DesignSidebar />
        <SidebarInset className="h-svh overflow-hidden">
          <header className="flex h-14 shrink-0 items-center gap-2 border-b px-4">
            <SidebarTrigger className="-ml-1" />
            <Separator orientation="vertical" className="mr-2 h-4" />
            <span className="text-sm font-medium">Language Tutor</span>
            <span className="text-muted-foreground text-sm">
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
