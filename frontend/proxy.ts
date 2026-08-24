import { clerkMiddleware, createRouteMatcher } from "@clerk/nextjs/server"

/**
 * Public-first: the landing and the design playground are open, everything a
 * learner does with an account is not. Auth only — the balance is checked in
 * `/api/token`, which is the one place that can read Convex; a check here would
 * be a second source of truth with no way to read the ledger.
 *
 * `/api/token` is deliberately NOT listed: `auth.protect()` answers a
 * non-document request with a 404, and a token endpoint owes its caller a 401.
 * The route does its own `await auth()` and says so.
 */
const isProtectedRoute = createRouteMatcher([
  "/go(.*)",
  "/home(.*)",
  "/welcome(.*)",
  "/session(.*)",
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
