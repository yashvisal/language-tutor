import { httpRouter } from "convex/server"

import { httpAction } from "./_generated/server"
import { internal } from "./_generated/api"

/**
 * The worker's seam into the ledger — and the wire contract the Python worker
 * (`backend/src/billing.py`) is written against. Change nothing here without
 * changing that; the two halves are deployed separately and there is no
 * shared type between them, so this comment IS the schema.
 *
 * ## Transport
 *
 * Base URL: the Convex **site** URL (`CONVEX_SITE_URL` on the worker), not the
 * cloud/API URL. Both routes are `POST`, both take and return
 * `application/json`, both require:
 *
 *     Authorization: Bearer <TUTOR_DEBIT_SECRET>
 *
 * The secret lives on the Convex deployment (`npx convex env set`), never in
 * `.env.local`: the browser must never be able to spend or read someone else's
 * balance. Both routes check it *before* reading the body, so an
 * unauthenticated caller cannot probe for a valid user id or room, and the
 * comparison is constant-time so it cannot be probed a byte at a time either.
 *
 * These routes are deliberately **machine-to-machine**: no CORS headers, no
 * `OPTIONS` handler, no preflight. A browser cannot call them, and that is the
 * point — the only legitimate caller is the worker, which is not a browser and
 * does not need CORS. If a browser ever needs one of these, it needs a
 * different route with a Clerk identity on it, not a CORS header here.
 *
 * ## `POST /tutor/debit`
 *
 * Request (all fields required except `final`):
 *
 * ```json
 * { "room": "lesson-learner-ab12cd34-1756000000000-9f8e7d6c",
 *   "userId": "user_2abcDEF...",
 *   "jobId": "AJ_9xKq...",
 *   "seconds": 137,
 *   "seq": 3,
 *   "final": true }
 * ```
 *
 * | field     | type   | constraint                                          |
 * |-----------|--------|-----------------------------------------------------|
 * | `room`    | string | non-empty, <= 256 chars. The LiveKit room name.      |
 * | `userId`  | string | non-empty, <= 256 chars. The learner's **Clerk id**, as signed into the dispatch metadata by `/api/token` (`SessionDispatchMetadata.user_id`). Not a Convex id. |
 * | `jobId`   | string | non-empty, <= 128 chars. The LiveKit **job** id (`ctx.job.id`). Stable for one job, different for a redispatch. |
 * | `seconds` | number | finite, `>= 0`, `<= 86400`. Rounded to an integer here. See below — this is ROOM-cumulative. |
 * | `seq`     | number | non-negative safe integer. The worker's per-job counter. |
 * | `final`   | bool   | **optional**. Absent or `false` on every periodic report and on the debit at a hold on zero. `true` on the teardown report only — the worker's last word on this room. |
 *
 * `final: true` sets `sessions.endedAt` if it is not already set, and never
 * overwrites one. It exists because `endedAt` is otherwise written only by the
 * client's `sessions.finish`, which a killed worker or a closed tab never
 * reaches — and an open row is what the one-open-session guard refuses on, so
 * a crash would lock the learner out of their own account for fifteen minutes.
 * Send it exactly once, at teardown; sending it on a periodic report would end
 * a conversation that is still happening.
 *
 * `seconds` is the **room's** cumulative billed seconds, not the job's: at job
 * start the worker reads `secondsBilled` from `/tutor/balance` and reports
 * `billedBefore + activeThisJob`. A redispatched job therefore neither
 * double-bills (the delta logic ignores what is already billed) nor bills zero
 * (its numbers are above the high-water mark, not below it).
 *
 * The ledger ref is `<room>:<jobId>:<seq>`, and it is the idempotency key.
 * `jobId` is in it because `seq` restarts at 1 for every job: without it, a
 * second job for the same room replays `room:1`, `room:2`, ... and every debit
 * is silently dropped as a duplicate.
 *
 * Responses:
 *
 * | status | body | meaning |
 * |--------|------|---------|
 * | `200`  | `{ "balanceSeconds": 463 }` | Debited (or already debited — same body). `balanceSeconds` is the learner's balance **after** this debit, in seconds, and may be negative. |
 * | `400`  | `{ "error": "<why>" }` | Malformed body, oversized body, or a field outside the constraints above. Never retry unchanged. |
 * | `401`  | `{ "error": "unauthorized" }` | Missing/incorrect bearer secret. |
 * | `500`  | Convex error text | The mutation threw: an unknown `userId`, or a `room` belonging to a different learner. Not retryable as-is. |
 *
 * ## `POST /tutor/balance`
 *
 * Request:
 *
 * ```json
 * { "userId": "user_2abcDEF...", "room": "lesson-..." }
 * ```
 *
 * | field    | type   | constraint |
 * |----------|--------|------------|
 * | `userId` | string | required, non-empty, <= 256 chars. Clerk id. |
 * | `room`   | string | **optional**, <= 256 chars. Omit it and `secondsBilled` comes back `0`. |
 *
 * Response `200`:
 *
 * ```json
 * { "balanceSeconds": 463, "secondsBilled": 137 }
 * ```
 *
 * - `balanceSeconds` — the learner's balance in seconds, `0` for an unknown
 *   Clerk id (never an error: an id with no row has no minutes).
 * - `secondsBilled` — what the given `room` has already been billed, `0` when
 *   `room` is omitted or has no row. This is what a starting job seeds its
 *   report base with, so its debits stay room-cumulative.
 *
 * Same `400` / `401` shapes as above.
 *
 * Called twice in a session's life: at job start (for `secondsBilled`, and to
 * confirm the ledger is reachable at all) and on resume from a hold at zero,
 * which is how a purchase mid-session continues the same conversation.
 *
 * The mutations and queries these call are `internal*`: they take a learner id
 * as an argument rather than from `ctx.auth`, which is only safe behind the
 * secret check above.
 */

/** Largest body either route will read. Both payloads are five short fields;
 * 4 KB is generous by two orders of magnitude and it is checked before the
 * JSON parser ever sees the bytes, so an unbounded body cannot be turned into
 * unbounded parse work. */
const MAX_BODY_BYTES = 4096

/** Ceiling on a single report. A day of continuous conversation is not a
 * conversation, and an unbounded `seconds` behind a leaked secret is an
 * arbitrarily large debit against a known Clerk id. */
const MAX_SECONDS = 86400

const MAX_ROOM_CHARS = 256
const MAX_USER_ID_CHARS = 256
const MAX_JOB_ID_CHARS = 128

const encoder = new TextEncoder()

/**
 * Constant-time string comparison.
 *
 * Convex functions run on a V8 runtime with WebCrypto but no Node `crypto`, so
 * there is no `timingSafeEqual` to reach for. `===` on a secret returns as soon
 * as two bytes differ, which over enough requests leaks the secret one byte at
 * a time; this always walks every byte of the expected value and accumulates
 * the difference instead of branching on it.
 *
 * The length comparison is not constant-time and does not need to be: the
 * length of a shared secret is not the secret.
 */
function secretsMatch(provided: string, expected: string): boolean {
  const a = encoder.encode(provided)
  const b = encoder.encode(expected)
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < b.length; i++) diff |= a[i] ^ b[i]
  return diff === 0
}

/** The shared secret, read per request so a rotated value takes effect without
 * a redeploy. Missing means the seam is closed, not open. */
function authorized(request: Request): boolean {
  const expected = process.env.TUTOR_DEBIT_SECRET
  if (!expected) return false
  const header = request.headers.get("Authorization") ?? ""
  const prefix = "Bearer "
  if (!header.startsWith(prefix)) return false
  return secretsMatch(header.slice(prefix.length), expected)
}

const unauthorized = () =>
  new Response(JSON.stringify({ error: "unauthorized" }), {
    status: 401,
    headers: { "Content-Type": "application/json" },
  })

const badRequest = (message: string) =>
  new Response(JSON.stringify({ error: message }), {
    status: 400,
    headers: { "Content-Type": "application/json" },
  })

const ok = (body: unknown) =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  })

/**
 * Reads the body with a hard ceiling on its size, then parses it.
 *
 * `Content-Length` is checked first because it is free and rejects the common
 * case without transferring anything; the byte length of what actually arrived
 * is checked second because `Content-Length` is a claim, not a fact (a chunked
 * body has none at all). Only then is anything handed to `JSON.parse`.
 *
 * Returns the parsed object, or a `Response` to send back as-is.
 */
async function readBody(
  request: Request
): Promise<Record<string, unknown> | Response> {
  const declared = Number(request.headers.get("Content-Length") ?? "")
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
    return badRequest("body too large")
  }
  let text: string
  try {
    text = await request.text()
  } catch {
    return badRequest("unreadable body")
  }
  if (encoder.encode(text).length > MAX_BODY_BYTES) {
    return badRequest("body too large")
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return badRequest("invalid json")
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return badRequest("expected a json object")
  }
  return parsed as Record<string, unknown>
}

/** A required, non-empty, bounded string field. `null` when it is none of
 * those — the caller turns that into one 400 naming the whole expected shape,
 * rather than confirming field by field which one a prober got right. */
function boundedString(value: unknown, max: number): string | null {
  if (typeof value !== "string") return null
  const trimmed = value.trim()
  if (trimmed.length === 0 || trimmed.length > max) return null
  return trimmed
}

const debit = httpAction(async (ctx, request) => {
  if (!authorized(request)) return unauthorized()

  const body = await readBody(request)
  if (body instanceof Response) return body

  const room = boundedString(body.room, MAX_ROOM_CHARS)
  const userId = boundedString(body.userId, MAX_USER_ID_CHARS)
  const jobId = boundedString(body.jobId, MAX_JOB_ID_CHARS)
  const seconds: unknown = body.seconds
  const seq: unknown = body.seq
  const final: unknown = body.final

  if (room === null || userId === null || jobId === null) {
    return badRequest("expected { room, userId, jobId, seconds, seq }")
  }
  if (
    typeof seconds !== "number" ||
    !Number.isFinite(seconds) ||
    seconds < 0 ||
    seconds > MAX_SECONDS
  ) {
    return badRequest(`seconds must be a number between 0 and ${MAX_SECONDS}`)
  }
  // An integer, not merely finite: a float `seq` would stringify into the ref
  // as `1.0000000000000002` and quietly defeat the idempotency check.
  if (typeof seq !== "number" || !Number.isSafeInteger(seq) || seq < 0) {
    return badRequest("seq must be a non-negative integer")
  }
  // Absent or a real boolean. A truthy string ("false", say) must not end a
  // conversation, so this is checked rather than coerced.
  if (final !== undefined && typeof final !== "boolean") {
    return badRequest("final must be a boolean")
  }

  const result = await ctx.runMutation(internal.sessions.debit, {
    room,
    clerkId: userId,
    seconds,
    jobId,
    seq,
    final,
  })
  return ok(result)
})

const balance = httpAction(async (ctx, request) => {
  if (!authorized(request)) return unauthorized()

  const body = await readBody(request)
  if (body instanceof Response) return body

  const userId = boundedString(body.userId, MAX_USER_ID_CHARS)
  if (userId === null) return badRequest("expected { userId, room? }")

  // Optional: a resume already knows its room's total from its own clock, and
  // only a *starting* job needs to be told. Absent is 0, not an error.
  const room =
    body.room === undefined ? null : boundedString(body.room, MAX_ROOM_CHARS)
  if (body.room !== undefined && room === null) {
    return badRequest("room must be a non-empty string")
  }

  const { balanceSeconds } = await ctx.runQuery(
    internal.users.balanceByClerkId,
    { clerkId: userId }
  )
  const secondsBilled =
    room === null
      ? 0
      : await ctx.runQuery(internal.sessions.billedSecondsForRoom, { room })

  return ok({ balanceSeconds, secondsBilled })
})

const http = httpRouter()
http.route({ path: "/tutor/debit", method: "POST", handler: debit })
http.route({ path: "/tutor/balance", method: "POST", handler: balance })

export default http
