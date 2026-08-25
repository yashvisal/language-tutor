import { currentUser } from "@clerk/nextjs/server"
import { History } from "@/components/home/history"
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
 * Under the panel: History — the conversations already had, each one a door
 * into what was said and what the tutor caught.
 */

export default async function HomePage() {
  const user = await currentUser()
  const firstName = user?.firstName?.trim()

  return (
    <div className="mx-auto w-full max-w-3xl px-6 py-12 sm:py-16">
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
          the record. Client island — the list is a reactive Convex read. */}
      <div className="mt-10">
        <History />
      </div>
    </div>
  )
}
