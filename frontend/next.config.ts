import { withSentryConfig } from "@sentry/nextjs/config"
import type { NextConfig } from "next"

/**
 * Response headers every route carries.
 *
 * All five are one-liners that close a class of attack outright, which is the
 * only kind of hardening worth putting in a config file rather than a plan:
 *
 * - `Referrer-Policy` keeps the path of a session URL off third-party origins.
 * - `X-Content-Type-Options` stops a browser guessing a type we didn't send.
 * - `X-Frame-Options` — nothing here is meant to be embedded, and a framed
 *   sign-in is a clickjacked sign-in.
 * - `Strict-Transport-Security` pins the site to HTTPS for two years.
 * - `Permissions-Policy` narrows the one device permission this product asks
 *   for to our own origin, and denies the two it never asks for. The
 *   microphone must stay `self`: the live session records nothing, but it
 *   cannot happen without a mic.
 *
 * NO Content-Security-Policy, deliberately. Clerk loads its own scripts and
 * frames, LiveKit opens WebSocket and WebRTC connections to a signalling host
 * that varies by deployment, and Next's own inline bootstrap needs a nonce
 * threaded through middleware. A CSP for this stack is a project with its own
 * testing pass, not a line in a config; a wrong one breaks sign-in and audio
 * silently. When it is written, it goes here.
 */
const nextConfig: NextConfig = {
  // Advertising the framework and its version helps nobody but a scanner.
  poweredByHeader: false,

  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          {
            key: "Referrer-Policy",
            value: "strict-origin-when-cross-origin",
          },
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "X-Frame-Options", value: "DENY" },
          // Two years, every subdomain, preload-list eligible. Vercel adds this
          // on a custom domain; having it here makes it the repo's contract too.
          {
            key: "Strict-Transport-Security",
            value: "max-age=63072000; includeSubDomains; preload",
          },
          {
            key: "Permissions-Policy",
            value: "microphone=(self), camera=(), geolocation=()",
          },
        ],
      },
    ]
  },
}

/**
 * Sentry wraps the config last so every header above survives it.
 *
 * Source maps are uploaded only when `SENTRY_AUTH_TOKEN` is set: a build
 * without one (every local build, and any preview whose env is incomplete)
 * must still succeed, just without readable stack traces. `SENTRY_ORG` and
 * `SENTRY_PROJECT` come from the environment for the same reason.
 */
export default withSentryConfig(nextConfig, {
  org: process.env.SENTRY_ORG,
  project: process.env.SENTRY_PROJECT,
  silent: !process.env.CI,
  authToken: process.env.SENTRY_AUTH_TOKEN,
  sourcemaps: { disable: !process.env.SENTRY_AUTH_TOKEN },
})
