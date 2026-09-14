import { cn } from "@/lib/utils"

/**
 * The one spinner: a ring with a heavier stroke than the usual hairline
 * (Yash, 2026-09-13), in the foreground colour so it reads on either theme.
 */
export function Spinner({ className }: { className?: string }) {
  return (
    <div
      role="status"
      aria-label="Loading"
      className={cn(
        "size-8 animate-spin rounded-full border-[3px] border-muted-foreground/25 border-t-foreground",
        className
      )}
    />
  )
}
