"use client"

import { useSyncExternalStore } from "react"
import { useTheme } from "next-themes"
import { Moon, Sun } from "lucide-react"

import { Button } from "@/components/ui/button"

const noopSubscribe = () => () => {}

export function ThemeToggle() {
  const { resolvedTheme, setTheme } = useTheme()
  // False on the server, true after hydration — the icon can't be chosen
  // until the client theme is known.
  const mounted = useSyncExternalStore(
    noopSubscribe,
    () => true,
    () => false
  )

  return (
    <Button
      variant="ghost"
      size="icon"
      aria-label="Toggle theme"
      onClick={() => setTheme(resolvedTheme === "dark" ? "light" : "dark")}
    >
      {mounted && resolvedTheme === "dark" ? (
        <Sun className="size-4" />
      ) : (
        <Moon className="size-4" />
      )}
    </Button>
  )
}
