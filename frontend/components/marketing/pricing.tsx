import { PACKS, PACKS_NOTE } from "@/components/marketing/brand"
import { Overline } from "@/components/overline"
import { cn } from "@/lib/utils"

/**
 * Pricing as three tiles. Minutes are the big number — it is what the learner
 * is buying — price second, per-minute small. The middle pack is the one
 * most people should pick, so it is the one with the accent border; nothing
 * else competes for attention. No buttons: payments are not live yet, and a
 * tile that pretends to sell is worse than one that simply informs.
 */
export function PricingPacks({ className }: { className?: string }) {
  return (
    <div className={cn("grid gap-4 sm:grid-cols-3", className)}>
      {PACKS.map((pack, i) => {
        const featured = i === 1
        return (
          <div
            key={pack.minutes}
            className={cn(
              "relative rounded-2xl border bg-card p-6 transition-colors",
              featured ? "border-primary/50" : "border-border/70"
            )}
          >
            {featured && (
              <Overline className="absolute -top-2.5 left-6 rounded-full border border-primary/40 bg-background px-2 py-0.5 text-primary">
                Most popular
              </Overline>
            )}
            <div className="text-4xl font-semibold tracking-tight tabular-nums">
              {pack.minutes}
              <span className="ml-1.5 text-base font-normal text-muted-foreground">
                minutes
              </span>
            </div>
            <div className="mt-4 text-xl tabular-nums">{pack.price}</div>
            <div className="mt-1 text-xs text-muted-foreground">{pack.per}</div>
          </div>
        )
      })}
    </div>
  )
}

export function PricingNote({ className }: { className?: string }) {
  return (
    <p className={cn("text-sm text-muted-foreground", className)}>
      {PACKS_NOTE}
    </p>
  )
}
