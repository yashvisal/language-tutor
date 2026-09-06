"use client"

import { ChevronDown } from "lucide-react"
import { LevelPicker } from "@/components/level-picker"
import { Button } from "@/components/ui/button"
import {
  Popover,
  PopoverContent,
  PopoverTitle,
  PopoverTrigger,
} from "@/components/ui/popover"
import { LANGUAGE_NAMES, LEVELS, type LevelValue } from "@/lib/session/plan"

export function SessionLevelPicker({
  value,
  language,
  onChange,
  disabled,
}: {
  value: string | null
  language: string
  onChange: (value: LevelValue) => void
  disabled?: boolean
}) {
  const selected = LEVELS.find((level) => level.value === value)
  return (
    <Popover>
      <PopoverTrigger
        render={
          <Button
            variant="outline"
            disabled={disabled}
            aria-label={`Level in ${LANGUAGE_NAMES[language]}: ${selected?.label ?? "Choose your level"}`}
          />
        }
      >
        {selected?.label ?? "Choose your level"}
        <ChevronDown className="size-4 text-muted-foreground" />
      </PopoverTrigger>
      <PopoverContent align="start" className="w-80 max-w-[calc(100vw-2rem)]">
        <PopoverTitle>
          Where are you with {LANGUAGE_NAMES[language]}?
        </PopoverTitle>
        <p className="text-xs text-muted-foreground">
          Your best guess is enough. The tutor will start here and adapt as you
          talk.
        </p>
        <LevelPicker
          value={value}
          onChange={onChange}
          label={`Your level in ${LANGUAGE_NAMES[language]}`}
        />
      </PopoverContent>
    </Popover>
  )
}
