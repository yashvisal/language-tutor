import { notFound } from "next/navigation"

/**
 * Two candidate landing pages, rendered full-bleed so they are judged the way
 * a visitor sees them. Development only, like `/design-inspo`.
 */
export default function LandingLabLayout({
  children,
}: {
  children: React.ReactNode
}) {
  if (process.env.NODE_ENV === "production") notFound()
  return children
}
