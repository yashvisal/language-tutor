import Link from "next/link"

import { WORDMARK } from "@/components/marketing/brand"
import { cn } from "@/lib/utils"

/**
 * The wordmark, lowercase, the same constant the landing uses. It is a
 * component rather than a copied `<Link>` because the sidebar's capitalised
 * "Tutor" was the kind of drift that only shows up when someone screenshots
 * both halves of the product side by side.
 */
export function Wordmark({
  href = "/home",
  className,
}: {
  href?: string
  className?: string
}) {
  return (
    <Link
      href={href}
      className={cn(
        "text-sm font-medium tracking-tight lowercase text-foreground transition-opacity duration-200 hover:opacity-70",
        className
      )}
    >
      {WORDMARK}
    </Link>
  )
}
