/**
 * One convention for reading required environment variables.
 *
 * A missing var must say its own name — `process.env.FOO!` fails later with
 * something unrelated ("Invalid URL", "undefined is not a function"), which
 * costs far more to debug than the two seconds it takes to read
 * `Missing env var NEXT_PUBLIC_CONVEX_URL`.
 *
 * Public vs server is a real distinction, not decoration:
 *   - `requirePublicEnv` reads a `NEXT_PUBLIC_*` var that is inlined into the
 *     client bundle. Next.js only inlines *literal* `process.env.NEXT_PUBLIC_X`
 *     references, so the values are spelled out in `publicEnv` below — a
 *     dynamic `process.env[name]` lookup would be `undefined` in the browser.
 *     Adding a public var means adding a line to that record.
 *   - `requireServerEnv` reads secrets that must never reach the client. It
 *     looks vars up dynamically, which is fine on the server, and throws if it
 *     is ever reached in the browser.
 */

/** Thrown when a required variable is unset or empty. Carries the names. */
export class MissingEnvVarError extends Error {
  readonly names: string[]

  constructor(names: string[]) {
    super(
      names.length === 1
        ? `Missing env var ${names[0]}`
        : `Missing env vars ${names.join(", ")}`
    )
    this.name = "MissingEnvVarError"
    this.names = names
  }
}

/**
 * Every public var the app reads, as literal references so Next.js can inline
 * them. Values here are already public — they ship in the client bundle.
 */
const publicEnv = {
  NEXT_PUBLIC_CONVEX_URL: process.env.NEXT_PUBLIC_CONVEX_URL,
  NEXT_PUBLIC_CONVEX_SITE_URL: process.env.NEXT_PUBLIC_CONVEX_SITE_URL,
} as const

export type PublicEnvVar = keyof typeof publicEnv

/** Reads a `NEXT_PUBLIC_*` var. Safe on the client. */
export function requirePublicEnv(name: PublicEnvVar): string {
  const value = publicEnv[name]

  if (!value) {
    throw new MissingEnvVarError([name])
  }

  return value
}

/**
 * Reads one or more server-only vars, reporting *all* the missing ones at once
 * so a misconfigured deploy is fixed in one pass rather than one restart per
 * variable. Returns the values in the order asked for.
 */
export function requireServerEnv<Names extends readonly [string, ...string[]]>(
  ...names: Names
): { [Index in keyof Names]: string } {
  if (typeof window !== "undefined") {
    throw new Error(
      `requireServerEnv(${names.join(", ")}) was called in the browser; server env vars are not available there`
    )
  }

  const values = names.map((name) => process.env[name])
  const missing = names.filter((_, index) => !values[index])

  if (missing.length > 0) {
    throw new MissingEnvVarError(missing)
  }

  return values as { [Index in keyof Names]: string }
}
