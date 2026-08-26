import { redirect } from "next/navigation"

import { viewerOnServer } from "@/lib/viewer-server"

/**
 * The onboarding gate, for the one signed-in page that is not in `(app)`.
 *
 * `/session` owns the whole viewport, so it deliberately sits outside the app
 * shell's route group — and it therefore sat outside the level check that
 * group's layout performs. An account that never saw `/welcome` could open
 * `/session`, be dispatched a tutor with `DEFAULT_LEVEL`, and be billed for a
 * conversation pitched at a level it never declared (audit §4.4).
 *
 * A server layout rather than a rule in `proxy.ts`: middleware knows the Clerk
 * session and nothing about the Convex row, so the decision cannot be made
 * there — and made on the client it would show the learner a pre-flight before
 * swapping it for `/welcome`. This redirects before anything renders, so there
 * is no flash. Middleware has already guaranteed a Clerk session.
 *
 * No chrome: the layout is the gate and nothing else.
 */
export default async function SessionLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  const viewer = await viewerOnServer()
  if (!viewer?.level) redirect("/welcome")

  return children
}
