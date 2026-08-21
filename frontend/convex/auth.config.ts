/**
 * Convex validates Clerk-issued JWTs against this issuer. The domain lives in
 * the deployment's environment (`npx convex env set CLERK_JWT_ISSUER_DOMAIN`),
 * not here, so dev and prod deployments can point at different Clerk
 * instances. `applicationID` names the Clerk JWT template, which must be
 * called exactly "convex".
 */
const authConfig = {
  providers: [
    {
      domain: process.env.CLERK_JWT_ISSUER_DOMAIN,
      applicationID: "convex",
    },
  ],
}

export default authConfig
