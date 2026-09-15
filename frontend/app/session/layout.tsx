import type { Metadata } from "next"
import { redirect } from "next/navigation"

import { ensureViewerOnServer } from "@/lib/viewer-server"

/**
 * The account gate, for the one signed-in page that is not in `(app)`.
 *
 * `/session` owns the whole viewport, so it deliberately sits outside the app
 * shell's route group — and it therefore sat outside the check that group's
 * layout performs. An account with no row yet could open `/session` and be
 * billed before its row and free grant existed (audit §4.4). The row is made
 * here, on the server, before anything renders.
 *
 * A server layout rather than a rule in `proxy.ts`: middleware knows the Clerk
 * session and nothing about the Convex row. Middleware has already guaranteed
 * a Clerk session.
 *
 * No chrome: the layout is the gate and nothing else.
 */
// The page itself is a client component and cannot export metadata; this
// layout is the nearest server file, so the tab name lives here.

export const metadata: Metadata = {
  title: "Session",
}

export default async function SessionLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  const viewer = await ensureViewerOnServer()
  if (viewer === null) redirect("/")

  return children
}
