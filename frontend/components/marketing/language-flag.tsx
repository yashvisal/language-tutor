import { cn } from "@/lib/utils"

/**
 * Small round flags for the languages section.
 *
 * The files in `public/flags/` are from HatScripts' circle-flags (MIT, notice
 * alongside them): proper flags, arms and all, drawn for exactly this size,
 * so Spain and Portugal are their real flags rather than stripped-down ones
 * (Yash, 2026-09-13). Files rather than emoji because emoji flags come out
 * as letter pairs on Windows. The country is the language's origin, a badge
 * for the name beside it rather than a claim about where it is spoken.
 */
export function LanguageFlag({
  code,
  className,
}: {
  code: string
  className?: string
}) {
  return (
    // A plain <img>: the files are tiny static SVGs, nothing for next/image
    // to optimise. Decorative — the name beside it carries the meaning.
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={`/flags/${code}.svg`}
      alt=""
      aria-hidden
      width={28}
      height={28}
      className={cn(
        "size-7 shrink-0 rounded-full ring-1 ring-black/10 ring-inset dark:ring-white/10",
        className
      )}
    />
  )
}
