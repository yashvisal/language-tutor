"use client"

/**
 * The Review material, as a picture of itself.
 *
 * Three surfaces render the same three lists now — the Review tab inside a
 * live hold, the post-session summary, and the History modal — and before this
 * file existed only the first one did. The other two showed a record the
 * learner had been told was "saved" and which, in fact, died with the tab.
 *
 * So the typesetting lives here and the three callers own only where it sits.
 * They cannot drift: a change to how a conjugation table reads is one change.
 *
 * Purely presentational. No fetching, no state, no empty-state copy — each
 * caller phrases absence in its own voice ("no material for this session yet"
 * on a live tab is a different sentence from a summary that simply omits the
 * section), so this renders nothing at all when there is nothing to render.
 */

import type { ReviewItem, ReviewMaterial } from "@/lib/session/contract"
import { ANCHOR_LANGUAGE, TARGET_LANGUAGE } from "@/lib/session/protocol"

/** Whether there is anything in here worth a heading. */
export function hasReviewMaterial(
  material: ReviewMaterial | null | undefined
): material is ReviewMaterial {
  if (!material) return false
  return (
    material.vocab.length > 0 ||
    material.phrases.length > 0 ||
    material.tables.length > 0
  )
}

export function ReviewMaterialView({
  material,
  /** Plan focus forms, hoisted to the top of the tables. */
  focusTenses = [],
  className,
}: {
  material: ReviewMaterial
  focusTenses?: readonly string[]
  className?: string
}) {
  return (
    <div className={className}>
      <div className="space-y-10">
        {material.vocab.length > 0 && (
          <Section label="Vocabulary">
            <PairList items={material.vocab} />
          </Section>
        )}
        {material.phrases.length > 0 && (
          <Section label="Phrases">
            <PairList items={material.phrases} />
          </Section>
        )}
        {material.tables.length > 0 && (
          <Section label="Conjugations">
            <div className="space-y-7">
              {orderTables(material.tables, focusTenses).map((table) => (
                <div key={`${table.verb} ${table.tense}`}>
                  <div className="mb-2 flex items-baseline gap-2">
                    <span
                      lang={TARGET_LANGUAGE}
                      className="text-sm font-medium tracking-[-0.011em]"
                    >
                      {table.verb}
                    </span>
                    <span className="text-xs text-muted-foreground">
                      {table.tense}
                    </span>
                  </div>
                  <table className="w-full border-separate border-spacing-0 text-sm">
                    <tbody>
                      {table.rows.map((row) => (
                        <tr key={row.person}>
                          <th
                            scope="row"
                            className="w-40 border-t border-border/40 py-1.5 pr-4 text-left font-normal text-muted-foreground"
                          >
                            {row.person}
                          </th>
                          <td
                            lang={TARGET_LANGUAGE}
                            className="border-t border-border/40 py-1.5 text-foreground"
                          >
                            {row.form}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ))}
            </div>
          </Section>
        )}
      </div>
    </div>
  )
}

function Section({
  label,
  children,
}: {
  label: string
  children: React.ReactNode
}) {
  return (
    <section>
      <h3 className="mb-3 text-[10px] leading-4 font-medium tracking-[0.2em] text-muted-foreground uppercase">
        {label}
      </h3>
      {children}
    </section>
  )
}

/** Target left, anchor muted right — the gloss is available, not competing. */
function PairList({ items }: { items: readonly ReviewItem[] }) {
  return (
    <dl className="text-sm">
      {items.map((item) => (
        <div
          key={`${item.target} ${item.anchor}`}
          className="flex gap-6 border-t border-border/40 py-1.5 first:border-t-0"
        >
          <dt
            lang={TARGET_LANGUAGE}
            className="flex-1 tracking-[-0.011em] text-foreground"
          >
            {item.target}
          </dt>
          <dd lang={ANCHOR_LANGUAGE} className="flex-1 text-muted-foreground">
            {item.anchor}
          </dd>
        </div>
      ))}
    </dl>
  )
}

/**
 * The plan's focus forms first. A learner who chose to practice the preterite
 * opens this looking for the preterite, and everything else is reference they
 * may never scroll to. Matching is loose (the plan's value is a phrase —
 * "preterite", "present tense" — and the table names a tense) and the order is
 * otherwise left exactly as the worker sent it.
 */
export function orderTables<T extends { tense: string }>(
  tables: readonly T[],
  focusTenses: readonly string[]
): T[] {
  if (focusTenses.length === 0) return [...tables]
  const focus = focusTenses.map((t) => t.toLowerCase())
  const rank = (table: T) => {
    const tense = table.tense.toLowerCase()
    const index = focus.findIndex((f) => f.includes(tense) || tense.includes(f))
    return index < 0 ? focus.length : index
  }
  return [...tables]
    .map((table, i) => ({ table, i, rank: rank(table) }))
    .sort((a, b) => a.rank - b.rank || a.i - b.i)
    .map(({ table }) => table)
}
