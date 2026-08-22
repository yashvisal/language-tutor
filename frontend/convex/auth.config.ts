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
const authConfig = {
  providers: [
    {
      domain: process.env.CLERK_FRONTEND_API_URL,
      applicationID: "convex",
    },
  ],
}

export default authConfig
