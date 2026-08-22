import type { ReactNode } from "react"

import { cn } from "@/lib/utils"

/**
 * The one section label in the product: small, spaced, uppercase, quiet enough
 * to be furniture. Shared because the pre-flight and the settings page had
 * identical copies of it, and a label that drifts between two screens is the
 * cheapest kind of inconsistency to avoid.
 */
export function Overline({
  children,
  className,
}: {
  children: ReactNode
  className?: string
}) {
  return (
    <p
      className={cn(
        "text-[10px] tracking-[0.14em] text-muted-foreground/50 uppercase",
        className
      )}
    >
      {children}
    </p>
  )
}
