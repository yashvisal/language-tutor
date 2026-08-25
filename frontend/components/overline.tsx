import type { ReactNode } from "react"

import { cn } from "@/lib/utils"

/**
 * The one section label in the product: small, spaced, uppercase. Shared
 * because the pre-flight and the settings page had identical copies of it,
 * and a label that drifts between two screens is the cheapest kind of
 * inconsistency to avoid.
 *
 * Deliberately the landing's eyebrow, character for character — there was one
 * idea and four styles for it, and the muted/50 copy was under 3:1 on white.
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
        "text-xs font-medium tracking-[0.18em] text-muted-foreground uppercase",
        className
      )}
    >
      {children}
    </p>
  )
}
