"use client"

/**
 * The signed-in chrome, entire. A wordmark, the one number the learner is here
 * for, a theme toggle, and their avatar — which opens the settings popover
 * that replaced the `/settings` page. There is nothing to navigate to yet, so
 * there is nothing to navigate with.
 *
 * The avatar is ours rather than Clerk's `<UserButton/>`: Clerk's menu is a
 * profile manager, and the two things a learner actually changes here are the
 * level (Convex's, not Clerk's) and being signed in.
 */

import { useState } from "react"
import { useClerk, useUser } from "@clerk/nextjs"
import { useMutation, useQuery } from "convex/react"

import { Wordmark } from "@/components/app-shell/wordmark"
import { LevelPicker } from "@/components/level-picker"
import { Overline } from "@/components/overline"
import { ThemeToggle } from "@/components/theme-toggle"
import { Button } from "@/components/ui/button"
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover"
import { api } from "@/convex/_generated/api"

export function AppHeader() {
  const viewer = useQuery(api.users.viewer)

  return (
    <header className="flex h-14 shrink-0 items-center justify-between gap-4 px-6">
      <Wordmark />
      <div className="flex items-center gap-1.5">
        {/* Nothing until the balance is known: a flash of "0 minutes left"
            would be a lie about the one number in the header. */}
        {viewer?.minutes !== undefined && (
          <span className="mr-1.5 text-sm text-muted-foreground tabular-nums">
            {viewer.minutes} {viewer.minutes === 1 ? "minute" : "minutes"} left
          </span>
        )}
        <ThemeToggle />
        <AccountPopover email={viewer?.email ?? null} level={viewer?.level ?? null} />
      </div>
    </header>
  )
}

/** Settings, all of it: who you are, how the tutor should pitch itself, and the
 * way out. */
function AccountPopover({
  email,
  level,
}: {
  email: string | null
  level: string | null
}) {
  const { user } = useUser()
  const { signOut } = useClerk()
  const setLevel = useMutation(api.users.setLevel)
  const [error, setError] = useState<string | null>(null)

  const name = user?.fullName || email || ""

  return (
    <Popover>
      <PopoverTrigger
        aria-label="Account"
        className="size-8 shrink-0 overflow-hidden rounded-full outline-none transition-[transform,box-shadow] duration-200 focus-visible:ring-3 focus-visible:ring-ring/50"
      >
        {user?.imageUrl ? (
          // Clerk's CDN serves the avatar already sized; next/image would
          // add a loader and a remote-pattern config for one 32px square.
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={user.imageUrl}
            alt=""
            className="size-8 rounded-full object-cover"
          />
        ) : (
          <span className="flex size-8 items-center justify-center rounded-full bg-primary/10 text-xs font-medium text-primary">
            {initials(name)}
          </span>
        )}
      </PopoverTrigger>
      <PopoverContent align="end" sideOffset={8} className="w-72 gap-0 p-4">
        <Overline>Signed in as</Overline>
        <p className="mt-2 truncate text-sm text-foreground">{email ?? "—"}</p>

        <div className="mt-5">
          <Overline>Your level</Overline>
          {/* Optimistic by way of Convex: the query is reactive, so the
              selection follows the write without local state to drift. A
              failed write therefore shows nothing at all unless we say so. */}
          <LevelPicker
            value={level}
            onChange={(value) => {
              setError(null)
              setLevel({ level: value }).catch(() =>
                setError("Couldn’t save. Try again.")
              )
            }}
            variant="inline"
            className="mt-2.5"
          />
          {error && (
            <p role="alert" className="mt-2.5 text-xs text-destructive">
              {error}
            </p>
          )}
        </div>

        <Button
          variant="ghost"
          size="sm"
          onClick={() => signOut({ redirectUrl: "/" })}
          className="mt-5 -ml-2.5 self-start"
        >
          Sign out
        </Button>
      </PopoverContent>
    </Popover>
  )
}

/** Two letters from whatever we have — a name, or the email's local part. */
function initials(name: string) {
  const parts = name.replace(/@.*$/, "").split(/[\s._-]+/).filter(Boolean)
  if (parts.length === 0) return "?"
  return (parts[0][0] + (parts[1]?.[0] ?? "")).toUpperCase()
}
