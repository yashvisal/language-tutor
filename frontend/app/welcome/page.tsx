import { redirect } from "next/navigation"

import { viewerOnServer } from "@/lib/viewer-server"
import { WelcomeForm } from "./welcome-form"

/**
 * Onboarding, once. One question — the level the tutor should pitch at — and
 * the only promise we make about money, in the learner's units: minutes.
 *
 * Outside the app shell on purpose. A sidebar with two links the learner
 * hasn't earned yet is chrome around a single question.
 *
 * Decided on the server: an account that already answered goes straight to
 * /home, without a frame of the form.
 */
export default async function WelcomePage() {
  const viewer = await viewerOnServer()
  if (viewer?.level) redirect("/home")
  return <WelcomeForm />
}
