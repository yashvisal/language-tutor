"use client"

/**
 * The signed-in chrome, entire. A wordmark, the one number the learner is here
 * for, a theme toggle, and their avatar — which opens the account menu that
 * replaced the `/settings` page. There is nothing to navigate to yet, so
 * there is nothing to navigate with.
 *
 * The avatar is ours rather than Clerk's `<UserButton/>`: Clerk's menu is a
 * profile manager, and the two things a learner actually changes here are the
 * level (Convex's, not Clerk's) and being signed in.
 */

import { useState } from "react"
import { useClerk, useUser } from "@clerk/nextjs"
import { useMutation, useQuery } from "convex/react"
import { LogOut } from "lucide-react"

import { Wordmark } from "@/components/app-shell/wordmark"
import { ThemeToggle } from "@/components/theme-toggle"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { api } from "@/convex/_generated/api"
import { formatClock } from "@/lib/billing"
import { LEVELS, type LevelValue } from "@/lib/session/plan"

export function AppHeader() {
  const viewer = useQuery(api.users.viewer)

  return (
    <header className="mx-auto flex h-14 w-full max-w-2xl shrink-0 items-center justify-between px-6">
      <Wordmark />
      <div className="flex items-center gap-1">
        {/* Nothing until the balance is known: a flash of "0:00 left" would
            be a lie about the one number in the header. */}
        {viewer?.seconds !== undefined && (
          <span className="mr-2 text-sm text-muted-foreground tabular-nums">
            {formatClock(viewer.seconds)} left
          </span>
        )}
        <ThemeToggle />
        <AccountMenu
          email={viewer?.email ?? null}
          level={viewer?.level ?? null}
        />
      </div>
    </header>
  )
}

/** Settings, all of it, as a menu: who you are, the level the tutor pitches
 * at, and the way out. A menu rather than a form because two of the three
 * are single choices and the third is an action. */
function AccountMenu({
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

  const name = user?.fullName || ""

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        aria-label="Account"
        className="ml-1 size-8 shrink-0 overflow-hidden rounded-full outline-none transition-[box-shadow] duration-200 focus-visible:ring-3 focus-visible:ring-ring/50"
      >
        {user?.imageUrl ? (
          // Clerk's CDN serves the avatar already sized; next/image would add
          // a loader and a remote-pattern config for one 32px square.
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={user.imageUrl}
            alt=""
            className="size-8 rounded-full object-cover"
          />
        ) : (
          <span className="flex size-8 items-center justify-center rounded-full bg-primary/10 text-xs font-medium text-primary">
            {initials(name || email || "")}
          </span>
        )}
      </DropdownMenuTrigger>

      <DropdownMenuContent align="end" sideOffset={8} className="w-72">
        {/* Base UI labels must sit inside a group, so each section is one. */}
        <DropdownMenuGroup>
          <DropdownMenuLabel className="flex flex-col gap-0.5 font-normal">
            {name && (
              <span className="text-sm font-medium text-foreground">
                {name}
              </span>
            )}
            <span className="truncate text-xs text-muted-foreground">
              {email ?? "—"}
            </span>
          </DropdownMenuLabel>
        </DropdownMenuGroup>

        <DropdownMenuSeparator />

        {/* Optimistic by way of Convex: the query is reactive, so the checked
            item follows the write without local state to drift. */}
        <DropdownMenuRadioGroup
          value={level ?? undefined}
          onValueChange={(value) => {
            setError(null)
            setLevel({ level: value as LevelValue }).catch(() =>
              setError("Couldn’t save. Try again.")
            )
          }}
        >
          <DropdownMenuLabel className="text-xs text-muted-foreground">
            Your level
          </DropdownMenuLabel>
          {LEVELS.map((option) => (
            <DropdownMenuRadioItem key={option.value} value={option.value}>
              {option.label}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
        {error && (
          <p role="alert" className="px-2 py-1 text-xs text-destructive">
            {error}
          </p>
        )}

        <DropdownMenuSeparator />

        <DropdownMenuItem onClick={() => signOut({ redirectUrl: "/" })}>
          <LogOut />
          Sign out
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

/** Two letters from whatever we have — a name, or the email's local part. */
function initials(name: string) {
  const parts = name.replace(/@.*$/, "").split(/[\s._-]+/).filter(Boolean)
  if (parts.length === 0) return "?"
  return (parts[0][0] + (parts[1]?.[0] ?? "")).toUpperCase()
}
