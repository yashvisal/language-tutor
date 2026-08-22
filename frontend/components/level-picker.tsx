"use client"

import { useRef, type KeyboardEvent } from "react"

import { LEVELS, type LevelValue } from "@/lib/session/plan"
import { cn } from "@/lib/utils"

/**
 * The self-declared level, asked in two places — once during onboarding and
 * again, editable, in settings. One component, two shapes.
 *
 * It implements the ARIA radio-group pattern properly, which the two hand-rolled
 * copies did not: the group is a single tab stop, and the arrow keys move *and*
 * select within it. That is the behaviour a screen-reader user expects from
 * `role="radiogroup"`, and three separate tab stops that only respond to Enter
 * is the thing that reads as broken.
 */
export type LevelPickerVariant = "stacked" | "inline"

const VARIANTS: Record<
  LevelPickerVariant,
  { group: string; option: string }
> = {
  /** Onboarding: full-width rows, one question on the screen. */
  stacked: {
    group: "flex flex-col gap-2",
    option: "rounded-md px-4 py-3 text-left text-sm",
  },
  /** Settings: chips on a line, one field among others. */
  inline: {
    group: "flex flex-wrap gap-1.5",
    option: "rounded-full px-3 py-1 text-sm",
  },
}

export function LevelPicker({
  value,
  onChange,
  variant = "stacked",
  label = "Your level",
  className,
}: {
  value: string | null
  onChange: (value: LevelValue) => void
  variant?: LevelPickerVariant
  label?: string
  className?: string
}) {
  const buttons = useRef<(HTMLButtonElement | null)[]>([])
  const styles = VARIANTS[variant]

  const selected = LEVELS.findIndex((option) => option.value === value)
  // The single tab stop: the selection, or the first option when there is none
  // yet — an empty radio group must still be reachable from the keyboard.
  const stop = selected === -1 ? 0 : selected

  const select = (index: number) => {
    const option = LEVELS[index]
    if (!option) return
    onChange(option.value)
    buttons.current[index]?.focus()
  }

  const onKeyDown = (event: KeyboardEvent, index: number) => {
    const last = LEVELS.length - 1
    let next: number | null = null
    switch (event.key) {
      case "ArrowDown":
      case "ArrowRight":
        next = index === last ? 0 : index + 1
        break
      case "ArrowUp":
      case "ArrowLeft":
        next = index === 0 ? last : index - 1
        break
      case "Home":
        next = 0
        break
      case "End":
        next = last
        break
      default:
        return
    }
    event.preventDefault()
    select(next)
  }

  return (
    <div
      role="radiogroup"
      aria-label={label}
      className={cn(styles.group, className)}
    >
      {LEVELS.map((option, index) => {
        const checked = value === option.value
        return (
          <button
            key={option.value}
            ref={(node) => {
              buttons.current[index] = node
            }}
            type="button"
            role="radio"
            aria-checked={checked}
            tabIndex={index === stop ? 0 : -1}
            onClick={() => onChange(option.value)}
            onKeyDown={(event) => onKeyDown(event, index)}
            className={cn(
              "border transition-colors outline-none focus-visible:ring-3 focus-visible:ring-ring/50",
              styles.option,
              checked
                ? "border-primary/40 bg-primary/10 text-foreground"
                : "border-border/70 text-muted-foreground hover:border-border hover:text-foreground"
            )}
          >
            {option.label}
          </button>
        )
      })}
    </div>
  )
}
