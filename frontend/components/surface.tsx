import type { LucideIcon } from "lucide-react"

import { cn } from "@/lib/utils"

/**
 * The two surface primitives the signed-in shell is built from.
 *
 * Depth comes from a shadow and a very faint ring, not from a hairline border
 * at half opacity — that grammar was tuned on the dark session stage and turned
 * into grey mush on white. Radii are 16px; one accent hue, the Aura blue,
 * carried by `--primary`.
 */
export const CARD_CLASS =
  "rounded-2xl bg-card p-6 shadow-sm ring-1 ring-foreground/[0.06] dark:ring-white/10"

/** A tinted rounded square holding one small icon. The only decoration on the
 * dashboard, and the only place color appears without meaning something. */
export function IconBadge({
  icon: Icon,
  className,
}: {
  icon: LucideIcon
  className?: string
}) {
  return (
    <span
      aria-hidden
      className={cn(
        "flex size-9 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary dark:bg-primary/15",
        className
      )}
    >
      <Icon className="size-4" />
    </span>
  )
}
