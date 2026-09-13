import { Overline } from "@/components/overline"
import { cn } from "@/lib/utils"

/**
 * One heading shape for every section below the hero: the small uppercase
 * label, then the sentence a size under the hero's headline. Left-aligned and
 * held to `max-w-xl` so the line breaks where it means to instead of running
 * the full six-column width.
 */
export function SectionHeading({
  overline,
  id,
  children,
  className,
}: {
  overline: string
  id?: string
  children: React.ReactNode
  className?: string
}) {
  return (
    <div className={cn("max-w-xl", className)}>
      <Overline>{overline}</Overline>
      <h2
        id={id}
        className="mt-3 text-2xl font-medium tracking-tight text-balance sm:text-3xl"
      >
        {children}
      </h2>
    </div>
  )
}
