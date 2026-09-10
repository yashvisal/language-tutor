"use client"

/**
 * The two choices the preflight asks before its questions: the language, and
 * the learner's self-reported level in it. Both are the account menu's
 * dropdown — same primitive, same item height, same check on the right — so
 * the preflight reads as one product with the header above it, not a second
 * design. A plain outline button is the trigger; the list is only the names.
 */

import { ChevronDown } from "lucide-react"

import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import {
  LANGUAGE_NAMES,
  LEVELS,
  TARGET_LANGUAGES,
  type LevelValue,
} from "@/lib/session/plan"

const TRIGGER_CLASS = "min-w-36 justify-between gap-2 px-3 font-normal"
const CHEVRON_CLASS = "size-4 text-muted-foreground"

export function LanguagePicker({
  value,
  onChange,
  disabled = false,
}: {
  value: string
  onChange: (language: string) => void
  disabled?: boolean
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        disabled={disabled}
        aria-label={`Language: ${LANGUAGE_NAMES[value]}`}
        render={<Button variant="outline" className={TRIGGER_CLASS} />}
      >
        {LANGUAGE_NAMES[value]}
        <ChevronDown className={CHEVRON_CLASS} />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" sideOffset={6} className="min-w-40">
        <DropdownMenuRadioGroup
          value={value}
          onValueChange={(next) => onChange(String(next))}
        >
          {TARGET_LANGUAGES.map(({ code }) => (
            <DropdownMenuRadioItem key={code} value={code}>
              {LANGUAGE_NAMES[code]}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

export function LevelPicker({
  value,
  language,
  onChange,
  disabled = false,
}: {
  value: string | null
  language: string
  onChange: (level: LevelValue) => void
  disabled?: boolean
}) {
  const selected = LEVELS.find((level) => level.value === value)
  const label = selected?.label ?? "Your level"
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        disabled={disabled}
        aria-label={`Level in ${LANGUAGE_NAMES[language]}: ${label}`}
        render={<Button variant="outline" className={TRIGGER_CLASS} />}
      >
        {label}
        <ChevronDown className={CHEVRON_CLASS} />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" sideOffset={6} className="min-w-56">
        <DropdownMenuRadioGroup
          value={value ?? ""}
          onValueChange={(next) => {
            const level = LEVELS.find((option) => option.value === next)
            if (level) onChange(level.value)
          }}
        >
          {LEVELS.map((level) => (
            <DropdownMenuRadioItem key={level.value} value={level.value}>
              {level.label}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
