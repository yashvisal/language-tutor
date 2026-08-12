"use client"

import { useEffect } from "react"
import Link from "next/link"
import { usePathname, useRouter } from "next/navigation"
import { ChevronLeft, ChevronRight } from "lucide-react"

import { cn } from "@/lib/utils"
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip"
import { DESIGN_TASKS } from "@/app/design-inspo/registry"

/**
 * Bottom bar for flipping between variants of the current exploration task.
 * Renders nothing outside variant pages. Keyboard: ←/→ steps, 1–9 jumps.
 */
export function VariantSwitcher() {
  const pathname = usePathname()
  const router = useRouter()

  const match = pathname.match(/^\/design-inspo\/([^/]+)\/([^/]+)/)
  const task = match ? DESIGN_TASKS.find((t) => t.slug === match[1]) : undefined
  const index = task
    ? task.variants.findIndex((v) => v.slug === match![2])
    : -1

  const hrefFor = (i: number) =>
    task ? `/design-inspo/${task.slug}/${task.variants[i].slug}` : "#"

  useEffect(() => {
    if (!task || index < 0) return
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return
      const target = e.target as HTMLElement | null
      if (
        target &&
        (target.tagName === "INPUT" ||
          target.tagName === "TEXTAREA" ||
          target.isContentEditable)
      )
        return

      const count = task.variants.length
      if (e.key === "ArrowLeft") {
        router.push(hrefFor((index - 1 + count) % count))
      } else if (e.key === "ArrowRight") {
        router.push(hrefFor((index + 1) % count))
      } else if (/^[1-9]$/.test(e.key)) {
        const i = Number(e.key) - 1
        if (i < count) router.push(hrefFor(i))
      }
    }
    window.addEventListener("keydown", onKeyDown)
    return () => window.removeEventListener("keydown", onKeyDown)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pathname])

  if (!task || index < 0) return null

  const count = task.variants.length

  return (
    <div className="flex shrink-0 justify-center py-1.5">
      <div className="bg-background/80 flex items-center gap-1 rounded-full border px-1.5 py-1 shadow-sm backdrop-blur">
        <Link
          href={hrefFor((index - 1 + count) % count)}
          aria-label="Previous variant"
          className="text-muted-foreground hover:text-foreground flex size-6 items-center justify-center rounded-full transition-colors"
        >
          <ChevronLeft className="size-3.5" />
        </Link>

        {task.variants.map((variant, i) => (
          <Tooltip key={variant.slug}>
            <TooltipTrigger
              render={
                <Link
                  href={hrefFor(i)}
                  aria-label={variant.title}
                  className={cn(
                    "flex size-6 items-center justify-center rounded-full font-mono text-[11px] tabular-nums transition-colors",
                    i === index
                      ? "bg-primary text-primary-foreground"
                      : "text-muted-foreground hover:text-foreground hover:bg-muted"
                  )}
                >
                  {i + 1}
                </Link>
              }
            />
            <TooltipContent side="top" sideOffset={6}>
              {variant.title}
            </TooltipContent>
          </Tooltip>
        ))}

        <Link
          href={hrefFor((index + 1) % count)}
          aria-label="Next variant"
          className="text-muted-foreground hover:text-foreground flex size-6 items-center justify-center rounded-full transition-colors"
        >
          <ChevronRight className="size-3.5" />
        </Link>

        <span className="text-muted-foreground/70 hidden pr-2 pl-1 text-[10px] sm:block">
          {task.variants[index].title} · ←→
        </span>
      </div>
    </div>
  )
}
