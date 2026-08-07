"use client"

import Link from "next/link"
import { usePathname } from "next/navigation"
import { Sparkles } from "lucide-react"

import {
  Sidebar,
  SidebarContent,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
} from "@/components/ui/sidebar"
import { DESIGN_TASKS } from "@/app/design-inspo/registry"

export function DesignSidebar() {
  const pathname = usePathname()

  return (
    <Sidebar collapsible="offcanvas">
      <SidebarHeader>
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton
              isActive={pathname === "/design-inspo"}
              render={
                <Link href="/design-inspo">
                  <Sparkles className="size-4" />
                  <span className="font-medium">Design inspo</span>
                </Link>
              }
            />
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarHeader>
      <SidebarContent>
        {DESIGN_TASKS.map((task) => (
          <SidebarGroup key={task.slug}>
            <SidebarGroupLabel>{task.title}</SidebarGroupLabel>
            <SidebarGroupContent>
              <SidebarMenu>
                {task.variants.map((variant) => {
                  const href = `/design-inspo/${task.slug}/${variant.slug}`
                  return (
                    <SidebarMenuItem key={variant.slug}>
                      <SidebarMenuButton
                        isActive={pathname === href}
                        render={<Link href={href}>{variant.title}</Link>}
                      />
                    </SidebarMenuItem>
                  )
                })}
              </SidebarMenu>
            </SidebarGroupContent>
          </SidebarGroup>
        ))}
      </SidebarContent>
    </Sidebar>
  )
}
