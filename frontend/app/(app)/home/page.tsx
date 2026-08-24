import { currentUser } from "@clerk/nextjs/server"
import { Captions, Mic, Sparkles } from "lucide-react"

import { StartSession } from "@/components/home/start-session"
import { CARD_CLASS, IconBadge } from "@/components/surface"

/**
 * The dashboard. Three things, in the order they matter: who you are, how much
 * talking you have left, and the way into a session. Everything else that used
 * to live here — the whole plan picker — moved into the modal behind the
 * button, because a learner opening `/home` is not here to fill in a form.
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
  { icon: Mic, line: "You speak." },
  { icon: Captions, line: "The tutor answers, and waits." },
  { icon: Sparkles, line: "The fix appears after your turn." },
]

export default async function HomePage() {
  const user = await currentUser()
  const firstName = user?.firstName?.trim()

  return (
    <div className="mx-auto w-full max-w-3xl px-6 py-10 sm:py-14">
      <h1 className="text-3xl font-semibold tracking-tight text-foreground">
        {firstName ? `Hola, ${firstName}` : "Welcome back."}
      </h1>
      <p className="mt-3 text-sm leading-relaxed text-muted-foreground">
        Ten minutes of Spanish, out loud. Pause any time to study — that’s free.
      </p>

      <div className="mt-10 flex flex-col gap-6">
        <StartSession />

        <section className={CARD_CLASS}>
          <h2 className="text-sm font-medium text-foreground">
            How a session goes
          </h2>
          <ul className="mt-5 flex flex-col gap-4">
            {HOW_IT_GOES.map((step) => (
              <li key={step.line} className="flex items-center gap-3">
                <IconBadge icon={step.icon} />
                <span className="text-sm text-muted-foreground">
                  {step.line}
                </span>
              </li>
            ))}
          </ul>
        </section>
      </div>
    </div>
  )
}
