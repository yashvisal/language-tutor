import { PACKS, PACKS_NOTE } from "@/components/marketing/brand"

/**
 * Pricing, quietly. Minutes first, price second, no comparison table, no
 * highlighted "best value" — three rows separated by hairlines.
 */
export function PricingPacks() {
  return (
    <section aria-labelledby="pricing-heading" className="space-y-5">
      <div className="space-y-1.5">
        <h2
          id="pricing-heading"
          className="text-xs font-medium tracking-[0.18em] text-muted-foreground uppercase"
        >
          Minutes
        </h2>
        <p className="text-sm text-muted-foreground">{PACKS_NOTE}</p>
      </div>

      <dl className="divide-y divide-border/70 border-y border-border/70">
        {PACKS.map((pack) => (
          <div
            key={pack.minutes}
            className="flex items-baseline justify-between gap-4 py-3.5"
          >
            <dt className="text-base">
              {pack.minutes} minutes
              <span className="ml-2 text-xs text-muted-foreground">
                {pack.per}
              </span>
            </dt>
            <dd className="text-base tabular-nums">{pack.price}</dd>
          </div>
        ))}
      </dl>
    </section>
  )
}

/** One-line version for a page that has already said enough. */
export function PricingLine() {
  return (
    <div className="space-y-2 text-sm text-muted-foreground">
      <p className="tabular-nums">
        {PACKS.map((pack) => `${pack.minutes} minutes ${pack.price}`).join(
          "  ·  "
        )}
      </p>
      <p>{PACKS_NOTE}</p>
    </div>
  )
}
