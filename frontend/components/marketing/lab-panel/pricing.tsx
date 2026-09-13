/**
 * Landing-lab copy of `components/marketing/pricing.tsx`, quieter.
 *
 * Same data and same order — minutes big, price second, per-minute small —
 * but the tiles drop the "Most popular" badge and the filled card surface.
 * Nothing on this page is for sale yet, so the tiles inform and the only mark
 * left on the middle pack is a slightly warmer border.
 */

import { PACKS } from "@/components/marketing/brand"
import { cn } from "@/lib/utils"

export function PanelPricingPacks({ className }: { className?: string }) {
  return (
    <div className={cn("grid gap-4 sm:grid-cols-3", className)}>
      {PACKS.map((pack, i) => (
        <div
          key={pack.minutes}
          className={cn(
            "rounded-2xl border px-6 py-7",
            i === 1 ? "border-primary/40" : "border-border/60"
          )}
        >
          <div className="text-3xl font-medium tracking-tight tabular-nums">
            {pack.minutes}
            <span className="ml-1.5 text-sm font-normal text-muted-foreground">
              minutes
            </span>
          </div>
          <div className="mt-3 text-base tabular-nums">{pack.price}</div>
          <div className="mt-1 text-xs text-muted-foreground">{pack.per}</div>
        </div>
      ))}
    </div>
  )
}
