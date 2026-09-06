"use client"

import { useState } from "react"
import { Check, ChevronDown } from "lucide-react"

import { Button } from "@/components/ui/button"
import {
  Popover,
  PopoverContent,
  PopoverTitle,
  PopoverTrigger,
} from "@/components/ui/popover"
import { LANGUAGE_NAMES, TARGET_LANGUAGES } from "@/lib/session/plan"

export function LanguagePicker({
  value,
  onChange,
  disabled = false,
}: {
  value: string
  onChange: (language: string) => void
  disabled?: boolean
}) {
  const [open, setOpen] = useState(false)

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        render={
          <Button
            variant="outline"
            disabled={disabled}
            aria-label={`Practice language: ${LANGUAGE_NAMES[value]}`}
          />
        }
      >
        {LANGUAGE_NAMES[value]}
        <ChevronDown className="size-4 text-muted-foreground" />
      </PopoverTrigger>
      <PopoverContent align="start" className="w-72">
        <PopoverTitle className="px-2 pt-1">
          What language would you like to speak?
        </PopoverTitle>
        <div
          className="grid max-h-72 gap-1 overflow-y-auto"
          role="group"
          aria-label="Practice language"
        >
          {TARGET_LANGUAGES.map(({ code, native }) => (
            <button
              key={code}
              type="button"
              aria-pressed={value === code}
              onClick={() => {
                onChange(code)
                setOpen(false)
              }}
              className="flex items-center gap-3 rounded-md px-2 py-2 text-left outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring aria-pressed:bg-primary/10 aria-pressed:text-primary"
            >
              <span className="flex-1">{LANGUAGE_NAMES[code]}</span>
              <span lang={code} className="text-xs text-muted-foreground">
                {native}
              </span>
              <Check
                aria-hidden="true"
                className={`size-4 ${value === code ? "opacity-100" : "opacity-0"}`}
              />
            </button>
          ))}
        </div>
        <p className="px-2 pb-1 text-xs text-muted-foreground">
          Explanations in English. Talk about anything.
        </p>
      </PopoverContent>
    </Popover>
  )
}
