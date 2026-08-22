/**
 * Convex validates Clerk-issued JWTs against this issuer. The domain lives in
 * the deployment's environment (`npx convex env set CLERK_FRONTEND_API_URL`,
 * per Clerk's Convex guide), so dev and prod deployments can point at
 * different Clerk instances.
 *
 * `applicationID` must match the token's `aud` claim. Our convex version's
 * `ConvexProviderWithClerk` requests `getToken({template: "convex"})`, so the
 * Clerk instance carries a JWT template named "convex" with claims
 * `{"aud": "convex"}` — without that claim Convex rejects every token with
 * "No auth provider found matching the given token" (live, 2026-08-21).
 * Clerk's current docs pre-map `aud` on the Sessions page instead; that flow
 * applies to newer convex versions that use the default session token.
 */
const domain = process.env.CLERK_FRONTEND_API_URL

// Fail at config load, not at the first signed-in request: an unset or
// malformed domain makes Convex reject every token with the opaque "No auth
// provider found matching the given token". This file is bundled into the
// deployment, so the check stays dependency-free.
if (!domain || !domain.startsWith("https://")) {
  throw new Error(
    `CLERK_FRONTEND_API_URL must be an absolute https:// URL (got ${
      domain ? `"${domain}"` : "no value"
    }). Set it on the deployment with: npx convex env set CLERK_FRONTEND_API_URL https://<your-subdomain>.clerk.accounts.dev`
  )
}

const authConfig = {
  providers: [
    {
      domain,
      applicationID: "convex",
    },
  ],
}

export default authConfig
