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
import Link from "next/link"
import { useClerk, useUser } from "@clerk/nextjs"
import { useQuery } from "convex/react"
import { CreditCard, LogOut, Settings } from "lucide-react"

import { BillingDialog } from "@/components/app-shell/billing-dialog"
import { SettingsDialog } from "@/components/app-shell/settings-dialog"
import { Wordmark } from "@/components/app-shell/wordmark"
import { ThemeToggle } from "@/components/theme-toggle"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { api } from "@/convex/_generated/api"
import { formatClock } from "@/lib/billing"

export function AppHeader() {
  const viewer = useQuery(api.users.viewer)

  return (
    <header className="flex h-14 w-full shrink-0 items-center justify-between px-6 sm:px-8">
      <Wordmark />
      <div className="flex items-center gap-1">
        {/* Three states. In flight: nothing, because a flash of "0:00 left"
            would be a lie about the one number in the header. No row at all
            (`null`): say so and offer the door, rather than silently omitting
            the balance forever (audit §4.13). Otherwise: the number. */}
        {viewer === null ? (
          <Link
            href="/welcome"
            className="mr-2 text-sm text-muted-foreground underline decoration-muted-foreground/30 underline-offset-4 transition-colors duration-200 hover:text-foreground"
          >
            Finish setup
          </Link>
        ) : (
          viewer?.seconds !== undefined && (
            <span className="mr-2 text-sm text-muted-foreground tabular-nums">
              {formatClock(viewer.seconds)} left
            </span>
          )
        )}
        <ThemeToggle />
        <AccountMenu email={viewer?.email ?? null} />
      </div>
    </header>
  )
}

/** Who you are, the two rooms where the account is changed, and the way out.
 * A menu rather than a page: none of this is navigation, and the two rooms are
 * modal by design — a learner opens them, changes one thing, and is back.
 *
 * The dialogs are siblings of the menu, not children of it. Rendered inside,
 * choosing the item would close the menu and unmount the dialog in the same
 * commit, and nothing would open. */
function AccountMenu({ email }: { email: string | null }) {
  const { user } = useUser()
  const { signOut } = useClerk()
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [billingOpen, setBillingOpen] = useState(false)

  const name = user?.fullName || ""

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger
          aria-label="Account"
          className="ml-1 size-8 shrink-0 overflow-hidden rounded-full transition-[box-shadow] duration-200 outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
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

          <DropdownMenuGroup>
            <DropdownMenuItem onClick={() => setSettingsOpen(true)}>
              <Settings />
              Settings
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => setBillingOpen(true)}>
              <CreditCard />
              Billing
            </DropdownMenuItem>
          </DropdownMenuGroup>

          <DropdownMenuSeparator />

          <DropdownMenuItem onClick={() => signOut({ redirectUrl: "/" })}>
            <LogOut />
            Sign out
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      <SettingsDialog open={settingsOpen} onOpenChange={setSettingsOpen} />
      <BillingDialog open={billingOpen} onOpenChange={setBillingOpen} />
    </>
  )
}

/** Two letters from whatever we have — a name, or the email's local part. */
function initials(name: string) {
  const parts = name
    .replace(/@.*$/, "")
    .split(/[\s._-]+/)
    .filter(Boolean)
  if (parts.length === 0) return "?"
  return (parts[0][0] + (parts[1]?.[0] ?? "")).toUpperCase()
}
