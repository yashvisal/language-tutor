import { clerkMiddleware, createRouteMatcher } from "@clerk/nextjs/server"

/**
 * Public-first: the landing and the design playground are open, everything a
 * learner does with an account is not. Auth only — the balance gate on
 * `/session` and `/api/token` lands with the minutes step; middleware has no
 * Convex read, so a balance check here would be a second source of truth.
 */
const isProtectedRoute = createRouteMatcher([
  "/go(.*)",
  "/home(.*)",
  "/welcome(.*)",
  "/session(.*)",
  "/api/token(.*)",
])

export default clerkMiddleware(async (auth, req) => {
  if (isProtectedRoute(req)) await auth.protect()
})

export const config = {
  matcher: [
    "/((?!_next|[^?]*\\.(?:html?|css|js(?!on)|jpe?g|webp|png|gif|svg|ttf|woff2?|ico|csv|docx?|xlsx?|zip|webmanifest)).*)",
    "/(api|trpc)(.*)",
    "/__clerk/:path*",
  ],
}
