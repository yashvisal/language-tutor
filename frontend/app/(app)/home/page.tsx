import { currentUser } from "@clerk/nextjs/server"
import { Captions, Mic, Sparkles } from "lucide-react"

import { ActivityCalendar } from "@/components/home/activity-calendar"
import { StartSession } from "@/components/home/start-session"

/**
 * The dashboard. Three things, in the order they matter: who you are, how much
 * talking you have left, and the way into a session. The whole plan picker
 * lives in the modal behind the button, because a learner opening `/home` is
 * not here to fill in a form.
 *
 * Server-rendered around one client island: the greeting is Clerk's, on the
 * server, so it never flashes; the balance is Convex's, reactive, in
 * `StartSession`.
 *
 * Recent sessions belong under this. There is no writer for them yet, and an
 * empty card promising a list is worse than no card.
 */

/** What actually happens in there, for someone who has never done it. */
const HOW_IT_GOES = [
  { icon: Mic, line: "You speak" },
  { icon: Captions, line: "The tutor answers, and waits" },
  { icon: Sparkles, line: "The fix appears after your turn" },
]

export default async function HomePage() {
  const user = await currentUser()
  const firstName = user?.firstName?.trim()

  return (
    <div className="mx-auto w-full max-w-2xl px-6 py-12 sm:py-16">
      <h1 className="text-2xl font-semibold tracking-tight text-foreground">
        {firstName ? `Hola, ${firstName}.` : "Welcome back."}
      </h1>
      <p className="mt-2 text-sm text-muted-foreground">
        Spanish, out loud — for as long as you like. Pausing to study is free.
      </p>

      <div className="mt-8">
        <StartSession />
      </div>

      {/* Under the panel, not beside it: the balance is the decision, this is
          the record. Client island — the day boundaries are the learner's. */}
      <div className="mt-10">
        <ActivityCalendar />
      </div>

      {/* Not a card: three quiet facts, so the panel above stays the only
          object on the page. */}
      <ul className="mt-8 flex flex-col gap-2.5 sm:flex-row sm:gap-8">
        {HOW_IT_GOES.map((step) => (
          <li
            key={step.line}
            className="flex items-center gap-2 text-sm text-muted-foreground"
          >
            <step.icon className="size-3.5 text-primary" aria-hidden />
            {step.line}
          </li>
        ))}
      </ul>
    </div>
  )
}
