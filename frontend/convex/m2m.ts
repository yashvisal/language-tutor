import { verifyMachineAuthToken } from "@clerk/backend/internal"

/**
 * Who is allowed to spend a learner's minutes.
 *
 * The worker and the ledger are two separate deployments with no shared
 * runtime, so the only thing that can travel between them is a bearer token.
 * That used to be a shared secret; it is now a Clerk **machine-to-machine**
 * JWT, which is better in the two ways that matter here: it expires on its own
 * (3 h), and it names *both* ends — the machine that minted it and the machine
 * it was minted to talk to — so a leaked token is a window, not a key.
 *
 * ## What is checked, and why both ends
 *
 * 1. **Signature**, against `CLERK_JWT_KEY` — the instance's JWKS public key in
 *    PEM form, held in the Convex deployment's env. Offline: `@clerk/backend`
 *    builds a local JWK from the PEM and verifies with WebCrypto, so there is
 *    no network call on the hot path of every debit, no per-request Clerk API
 *    cost, and no outage in the ledger when Clerk has one.
 * 2. **`subject === TUTOR_WORKER_MACHINE_ID`** — the token was minted by the
 *    tutor worker's machine, not by some other machine in the same instance.
 * 3. **`scopes` includes `TUTOR_LEDGER_MACHINE_ID`** — the token was minted
 *    *for* this ledger. Without this, a token the worker minted for any other
 *    audience would open the debit route; without check 2, any machine scoped
 *    to the ledger could. Neither check subsumes the other, which is why both
 *    are here.
 *
 * ## Fail closed
 *
 * Any of the three env values missing is `unauthorized`, not "skip the check".
 * A ledger that authenticates nobody is the correct behaviour for a
 * misconfigured deploy; a ledger that authenticates everybody is not. The same
 * goes for a token the SDK cannot parse, an opaque (`mt_…`) token that would
 * otherwise cost a network round-trip to Clerk, and any throw out of the SDK.
 *
 * The caller (`http.ts`) turns every failure into the same
 * `401 {"error":"unauthorized"}`; the *reason* is logged here, server-side
 * only, so an operator can tell "worker minted against the wrong instance"
 * from "token expired" without the caller learning which check it failed.
 */

/** Prefix of an opaque M2M token. Clerk can verify these, but only over the
 * network with a machine secret key — which this deployment deliberately does
 * not hold. The worker mints `token_format: "jwt"`; anything else is a
 * misconfigured worker, and saying so is more useful than a round-trip. */
const OPAQUE_TOKEN_PREFIX = "mt_"

/** `header.payload.signature`, base64url. Cheap shape check so a bare string
 * is rejected here rather than inside the SDK's decoder. */
const JWT_SHAPE = /^[a-zA-Z0-9\-_]+\.[a-zA-Z0-9\-_]+\.[a-zA-Z0-9\-_]+$/

export type WorkerTokenEnv = {
  /** `CLERK_JWT_KEY` — the instance's public signing key, PEM. */
  jwtKey?: string
  /** `TUTOR_WORKER_MACHINE_ID` — `mch_…`, the expected `sub`. */
  workerMachineId?: string
  /** `TUTOR_LEDGER_MACHINE_ID` — `mch_…`, expected in `scopes`. */
  ledgerMachineId?: string
}

export type WorkerTokenResult =
  { ok: true; subject: string } | { ok: false; reason: string }

/** The shape of `verifyMachineAuthToken`'s result that this module uses: an
 * M2M token has a `subject` and `scopes`. Narrower than the SDK's union (which
 * also covers API keys and OAuth tokens) on purpose — those carry neither
 * field, and a token that is one of them fails the subject check anyway. */
type MachineVerify = (
  token: string,
  options: { jwtKey: string }
) => Promise<{
  data?: { subject?: string; scopes?: string[] } | unknown
  errors?: Array<{ message?: string }> | unknown
}>

/**
 * Verifies a bearer from the worker.
 *
 * `verify` is a parameter so the tests can drive every branch without minting
 * real Clerk tokens; production always uses the SDK default. Reads nothing
 * from `process.env` itself — the caller passes `env` per request, so a
 * rotated key takes effect without a redeploy.
 */
export async function verifyWorkerToken(
  bearer: string | null,
  env: WorkerTokenEnv,
  verify: MachineVerify = verifyMachineAuthToken as MachineVerify
): Promise<WorkerTokenResult> {
  const { jwtKey, workerMachineId, ledgerMachineId } = env

  // Configuration first: a deployment missing any of these cannot make a
  // correct decision, and "cannot decide" is a closed door.
  if (!jwtKey || !workerMachineId || !ledgerMachineId) {
    const missing = [
      jwtKey ? null : "CLERK_JWT_KEY",
      workerMachineId ? null : "TUTOR_WORKER_MACHINE_ID",
      ledgerMachineId ? null : "TUTOR_LEDGER_MACHINE_ID",
    ].filter((name): name is string => name !== null)
    return reject(
      `ledger is not configured for M2M auth: ${missing.join(", ")}`
    )
  }

  const prefix = "Bearer "
  if (bearer === null || !bearer.startsWith(prefix)) {
    return reject("missing or malformed Authorization header")
  }
  const token = bearer.slice(prefix.length).trim()
  if (token.length === 0) return reject("empty bearer token")

  if (token.startsWith(OPAQUE_TOKEN_PREFIX)) {
    return reject(
      'opaque M2M token; the worker must mint with token_format: "jwt"'
    )
  }
  if (!JWT_SHAPE.test(token)) {
    return reject("bearer is not a JWT")
  }

  let result: Awaited<ReturnType<MachineVerify>>
  try {
    result = await verify(token, { jwtKey })
  } catch (error) {
    // The SDK throws rather than returning on some malformed input, and a
    // throw here would be a 500 — which tells an attacker more than a 401.
    return reject(`token verification threw: ${String(error)}`)
  }

  const errors = result.errors as Array<{ message?: string }> | undefined
  if (errors && errors.length > 0) {
    return reject(`token rejected: ${errors[0]?.message ?? "unknown error"}`)
  }

  const data = result.data as
    { subject?: unknown; scopes?: unknown } | undefined
  if (!data) return reject("token verification returned no token")

  const subject = data.subject
  if (typeof subject !== "string" || subject !== workerMachineId) {
    return reject("token subject is not the tutor worker machine")
  }

  const scopes = data.scopes
  if (!Array.isArray(scopes) || !scopes.includes(ledgerMachineId)) {
    return reject("token is not scoped to the ledger machine")
  }

  return { ok: true, subject }
}

/** One place that logs the reason and returns the closed door, so no branch
 * above can return a failure without leaving a trace an operator can read.
 * `console.warn` is what Convex surfaces as a warn-level log line. */
function reject(reason: string): WorkerTokenResult {
  console.warn(`[m2m] rejected worker token: ${reason}`)
  return { ok: false, reason }
}
