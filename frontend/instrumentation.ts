/**
 * Next's server instrumentation hook — the Sentry docs' `register()` shape.
 *
 * Both configs are guarded on a DSN of their own, so a checkout with no
 * `SENTRY_DSN` imports the SDK and initialises nothing: no network, no noise
 * in `next dev`.
 */
import * as Sentry from "@sentry/nextjs"

export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    await import("./sentry.server.config")
  }
  if (process.env.NEXT_RUNTIME === "edge") {
    await import("./sentry.edge.config")
  }
}

// Reports errors thrown in server components, route handlers and middleware.
export const onRequestError = Sentry.captureRequestError
