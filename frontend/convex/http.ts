import { httpRouter } from "convex/server"

import { httpAction } from "./_generated/server"
import { internal } from "./_generated/api"
import { SESSION_END_REASONS, SUMMARY_LIMITS } from "./validators"
import { DELTA_CAP_PREFIX, MAX_DELTA_PER_CALL_S } from "../lib/billing"
import { verifyWorkerToken } from "./m2m"

/**
 * The worker's seam into the ledger — and the wire contract the Python worker
 * (`backend/src/billing.py`) is written against. Change nothing here without
 * changing that; the two halves are deployed separately and there is no
 * shared type between them, so this comment IS the schema.
 *
 * ## Transport
 *
 * Base URL: the Convex **site** URL (`CONVEX_SITE_URL` on the worker), not the
 * cloud/API URL. All three routes are `POST`, all take and return
 * `application/json`, all require:
 *
 *     Authorization: Bearer <a Clerk M2M JWT>
 *
 * The bearer is a **Clerk machine-to-machine token in JWT format**, minted by
 * the worker's machine (`tutor-worker`) once per job with a 3 h expiry and
 * scoped to the ledger's machine (`tutor-ledger`). Convex verifies it
 * **offline** against `CLERK_JWT_KEY` — the instance's JWKS public key as PEM,
 * set on the Convex deployment (`npx convex env set`) — and then checks both
 * ends: `subject === TUTOR_WORKER_MACHINE_ID` **and** `scopes` contains
 * `TUTOR_LEDGER_MACHINE_ID`. Subject alone would let any machine scoped to the
 * ledger debit; scope alone would let any token the worker minted for another
 * audience through. See `convex/m2m.ts`. There is no shared secret any more:
 * `TUTOR_DEBIT_SECRET` is gone from both halves.
 *
 * Nothing here is in `.env.local`: the browser must never be able to spend or
 * read someone else's balance. Every route verifies the token *before* reading
 * the body, so an unauthenticated caller cannot probe for a valid user id or
 * room, and every failure is the same `401 {"error":"unauthorized"}` — the
 * reason is logged server-side only.
 *
 * **Rotation.** JWTs cannot be revoked one at a time; the 3 h expiry is the
 * blast radius, and revoking the worker wholesale means rotating its machine
 * secret key at Clerk. Rotating the *instance's* signing key means updating
 * `CLERK_JWT_KEY` here — because verification is offline there is no JWKS
 * fetch and therefore no cache that expires on its own: until that env var is
 * updated, every worker token fails closed.
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
 *   "final": true,
 *   "reason": "ended" }
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
 * | `reason`  | string | **optional**, and only meaningful with `final: true`. One of `ended`, `out_of_minutes_idle`, `hold_idle`, `learner_left`, `model_error`, `ledger_failure`, `tutor_silent`. Anything else is a `400`, on every report — including the periodic ones that ignore it, so a wrong value is learned early rather than at teardown. |
 *
 * `reason` is why the conversation stopped, and the worker is the only half
 * that knows: the browser sees a room close and cannot tell a model failure
 * from a goodbye. It is written **only when `final` is true** and **only if
 * the row does not already carry one** — never overwritten, because the first
 * teardown report is the one that was actually there when it stopped. Note it
 * is written on its own condition, NOT with `endedAt`: a session the client's
 * `sessions.finish` already closed still gets its explanation.
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
 * | `400`  | `{ "error": "<why>" }` | Malformed body, oversized body, a field outside the constraints above, or a report that would add more than `MAX_DELTA_PER_CALL_S` (3600 s) to `secondsBilled` — nothing billed, the mark unmoved. Never retry unchanged. |
 * | `401`  | `{ "error": "unauthorized" }` | Missing, malformed, expired, or wrongly-scoped bearer token. |
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
 * ## `POST /tutor/summary`
 *
 * The after-session record: what the conversation was about, what was said,
 * and the Review material — written at teardown, from the one half of the
 * system that survives a closed laptop. Without it the transcript and the
 * Review die with the tab, and `out-of-minutes.tsx` promises they do not.
 *
 * Request:
 *
 * ```json
 * { "room": "lesson-learner-ab12cd34-1756000000000-9f8e7d6c",
 *   "userId": "user_2abcDEF...",
 *   "jobId": "AJ_9xKq...",
 *   "about": "Ordering at a cafe and asking about the neighbourhood.",
 *   "goal": { "text": "Order food and drinks confidently in a cafe.",
 *             "forms": ["present", "conditional"], "source": "tool" },
 *   "turns": 34,
 *   "anchorRatio": 0.12,
 *   "asks": ["why is it 'me gustaria' and not 'yo gustaria'?"],
 *   "lookups": [{ "source": "la cuenta", "translation": "the bill" }],
 *   "transcript": [{ "role": "learner", "text": "hola, quiero un cafe" },
 *                  { "role": "tutor",   "text": "claro, con leche?" }],
 *   "review": { "vocab":   [{ "target": "la cuenta", "anchor": "the bill" }],
 *               "phrases": [{ "target": "para llevar", "anchor": "to go" }],
 *               "tables":  [{ "verb": "querer", "tense": "present",
 *                             "rows": [{ "person": "yo", "form": "quiero" }] }] } }
 * ```
 *
 * | field        | type   | constraint                                       |
 * |--------------|--------|--------------------------------------------------|
 * | `room`       | string | **required**, non-empty, <= 256 chars. The LiveKit room name — the record is keyed on it, like the debit's. |
 * | `userId`     | string | **required**, non-empty, <= 256 chars. The learner's **Clerk id** (`SessionDispatchMetadata.user_id`), not a Convex id. |
 * | `jobId`      | string | **required**, non-empty, <= 128 chars. The LiveKit job id. Validated and logged, not stored: this write is a patch, not a ledger entry, so it needs no idempotency key. |
 * | `about`      | string | **optional**, <= 200 chars. One line, in the learner's anchor language, describing what the conversation was actually about — read off the TRANSCRIPT, not off the plan. The plan is what they intended; this is what happened. |
 * | `transcript` | array  | **optional**, <= 200 entries. Each `{ "role": "learner" or "tutor", "text": string }`, `text` <= 500 chars. Any other `role` is a `400`, not a silent drop. |
 * | `corrections` | array | **optional**, <= 200 entries of `{ id, original, replacement, category, severity, explanation }`, every string <= 500 chars. The analyzer's findings as the WORKER saw them. See the backstop note below. |
 * | `goal`       | object | **optional**, `{ text, forms, source }` — the goal confirmed at the top of the conversation, the session's spine. `text` non-empty after trimming and <= 200 chars (an empty one is a `400`, not an absent goal — a goal object with no line in it is a bug); `forms` <= 8 strings of <= 60 chars; `source` exactly one of `"plan"` / `"tool"` / `"extracted"`, anything else a `400`. `source` is how much to trust it: an `"extracted"` goal was never said back to the learner. |
 * | `turns`      | number | **optional**, integer `0..100000`. Learner turns committed by the turn detector — how much the learner actually spoke, which seconds are not. |
 * | `anchorRatio`| number | **optional**, `0..1`. The share of those turns spoken mostly in the ANCHOR language. High means the learner is falling back to English; it is the input support-on-evidence reads. |
 * | `asks`       | array  | **optional**, <= 25 strings of <= 400 chars — the questions asked in the Ask tab, in order. Questions only; the answers are not stored, because what the learner did not know is the study record. |
 * | `lookups`    | array  | **optional**, <= 100 entries of `{ source, translation }`, both strings <= 200 chars — every select-to-translate lookup, in order. |
 * | `review`     | object | **optional**, `{ vocab, phrases, tables }` — the `tutor.review` payload minus `ready` (`backend/src/review.py`). `vocab`/`phrases` are `{ target, anchor }`, <= 40 each; `tables` are `{ verb, tense, rows: [{ person, form }] }`, <= 8 tables of <= 12 rows; every string <= 200 chars. All three keys required when `review` is present. |
 *
 * Body ceiling: **256 KB** (its own bound; the other two routes stay at 4 KB).
 *
 * **Every payload field is independent and last-write-wins.** A field absent
 * from the body leaves that column untouched, so a worker that has the goal at
 * the top of the conversation and the transcript at teardown, and whose Review
 * generation is still in flight, can send each one as it has it. Sending a
 * field again replaces it wholesale — there is no merge. That is why the goal
 * can be sent the moment it is confirmed rather than held until the end: a
 * session that dies mid-way still records what it was set up to be.
 *
 * **Worker corrections are the backstop for a tab that never finished.** The
 * corrections normally reach Convex from the browser (`sessions.finish`), which
 * is the only half that knows the exact `secondsTalked` and whether the clock
 * ended the session — and which a closed laptop, a crashed tab or a killed
 * process never reaches, losing every correction the learner earned. So send
 * `corrections` here too. They are written into `outcome` **only if the row has
 * no outcome yet**: if the client's `finish` already ran, or runs later, its
 * record wins outright. A worker-written outcome carries
 * `secondsTalked = secondsBilled` (or `null` if this arrives before the final
 * debit and nothing has been billed yet) and `endedByClock: false`, which is
 * what "we do not know" looks like from out here.
 *
 * **Order-independent with the final debit.** Send this before or after the
 * `final: true` debit; either may be the call that creates the `sessions` row
 * (a manual dispatch, a token route that failed after minting). This route
 * never touches `secondsBilled` or `endedAt`: the meter is `/tutor/debit`'s
 * alone, and recording what was said is not the same as ending a session.
 *
 * Responses:
 *
 * | status | body | meaning |
 * |--------|------|---------|
 * | `200`  | `{ "ok": true }` | Recorded. |
 * | `400`  | `{ "error": "<why>" }` | Malformed or oversized body, an unknown `role`, or a field over its bound. Never retry unchanged. |
 * | `401`  | `{ "error": "unauthorized" }` | Missing, malformed, expired, or wrongly-scoped bearer token. |
 * | `500`  | Convex error text | An unknown `userId`, or a `room` belonging to a different learner. Not retryable as-is. |
 *
 * Over a bound is a `400` here, at the wire, where the worker can read the
 * reason — the mutation behind it also clamps rather than throws, so a bound
 * raised on one side never turns a whole teardown report into a `500` on the
 * other. An `about` that is empty or whitespace is treated as absent (the
 * column is left alone) rather than stored as `""`.
 *
 * The mutations and queries these call are `internal*`: they take a learner id
 * as an argument rather than from `ctx.auth`, which is only safe behind the
 * token check above.
 */

/** Largest body either route will read. Both payloads are five short fields;
 * 4 KB is generous by two orders of magnitude and it is checked before the
 * JSON parser ever sees the bytes, so an unbounded body cannot be turned into
 * unbounded parse work. */
const MAX_BODY_BYTES = 4096

/** Ceiling on a single report. A day of continuous conversation is not a
 * conversation, and an unbounded `seconds` behind a leaked secret is an
 * arbitrarily large debit against a known Clerk id. */
/** `/tutor/summary`'s own ceiling — the one payload that is not five short
 * fields. 256 KB holds 200 turns of 500 characters, the Review material and
 * the about line with room to spare, and it is still checked before the JSON
 * parser sees a byte. The two routes do NOT share a bound: raising the debit
 * route's 4 KB to fit a transcript would widen the smaller, more valuable
 * seam for nothing. */
const MAX_SUMMARY_BODY_BYTES = 262144

const MAX_SECONDS = 86400

/** Ceiling on the reported learner-turn count. A day of conversation at one
 * turn every three seconds is nowhere near this; anything above it is a
 * counter that ran away, and it is printed on the History card. */
const MAX_TURNS = 100000

const MAX_ROOM_CHARS = 256
const MAX_USER_ID_CHARS = 256
const MAX_JOB_ID_CHARS = 128

const encoder = new TextEncoder()

/**
 * The worker's identity, checked before anything else on every route.
 *
 * Env is read per request rather than at module load so a rotated
 * `CLERK_JWT_KEY` or a re-created machine takes effect without a redeploy, and
 * so a deployment missing any of the three fails closed on every call rather
 * than only on the one that happened to boot the isolate.
 */
async function authorized(request: Request): Promise<boolean> {
  const result = await verifyWorkerToken(request.headers.get("Authorization"), {
    jwtKey: process.env.CLERK_JWT_KEY,
    workerMachineId: process.env.TUTOR_WORKER_MACHINE_ID,
    ledgerMachineId: process.env.TUTOR_LEDGER_MACHINE_ID,
  })
  return result.ok
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
  request: Request,
  maxBytes: number = MAX_BODY_BYTES
): Promise<Record<string, unknown> | Response> {
  const declared = Number(request.headers.get("Content-Length") ?? "")
  if (Number.isFinite(declared) && declared > maxBytes) {
    return badRequest("body too large")
  }
  let text: string
  try {
    text = await request.text()
  } catch {
    return badRequest("unreadable body")
  }
  if (encoder.encode(text).length > maxBytes) {
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
  if (!(await authorized(request))) return unauthorized()

  const body = await readBody(request)
  if (body instanceof Response) return body

  const room = boundedString(body.room, MAX_ROOM_CHARS)
  const userId = boundedString(body.userId, MAX_USER_ID_CHARS)
  const jobId = boundedString(body.jobId, MAX_JOB_ID_CHARS)
  const seconds: unknown = body.seconds
  const seq: unknown = body.seq
  const final: unknown = body.final
  const reason: unknown = body.reason

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
  // Validated whenever it is present, even on a periodic report that will
  // ignore it: a worker sending a reason the schema does not know is a worker
  // whose teardown report is about to 500, and it should learn that from the
  // first one it sends rather than from the last.
  if (
    reason !== undefined &&
    !(SESSION_END_REASONS as readonly unknown[]).includes(reason)
  ) {
    return badRequest(`reason must be one of ${SESSION_END_REASONS.join(", ")}`)
  }

  let result
  try {
    result = await ctx.runMutation(internal.sessions.debit, {
      room,
      clerkId: userId,
      seconds,
      jobId,
      seq,
      final,
      reason: reason as (typeof SESSION_END_REASONS)[number] | undefined,
    })
  } catch (error) {
    // A report that would add more than `MAX_DELTA_PER_CALL_S` is refused as
    // a bad request, not a fault: the worker must never retry it unchanged.
    if (String(error).includes(DELTA_CAP_PREFIX)) {
      return badRequest(
        `one report may add at most ${MAX_DELTA_PER_CALL_S} seconds`
      )
    }
    throw error
  }
  return ok(result)
})

const balance = httpAction(async (ctx, request) => {
  if (!(await authorized(request))) return unauthorized()

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

/* -------------------------------------------------------------------------- */
/*  /tutor/summary — the after-session record                                 */
/* -------------------------------------------------------------------------- */

/** A study pair or a table row: exactly two string fields, each bounded. The
 * key names differ (`target`/`anchor`, `person`/`form`) but the shape does
 * not, so one checker does both. Returns the coerced pair or `null`. */
function pair<A extends string, B extends string>(
  value: unknown,
  first: A,
  second: B,
  max: number = SUMMARY_LIMITS.reviewItemChars
): { [K in A | B]: string } | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return null
  }
  const record = value as Record<string, unknown>
  const a = record[first]
  const b = record[second]
  if (typeof a !== "string" || typeof b !== "string") return null
  if (a.length > max || b.length > max) return null
  return { [first]: a, [second]: b } as { [K in A | B]: string }
}

/** An array field, or `null` if it is not an array or is over its count.
 * Absent is `undefined` — the caller must be able to tell "not sent" (leave
 * the column alone) from "sent something wrong" (400). */
function boundedArray(value: unknown, max: number): unknown[] | null {
  if (!Array.isArray(value) || value.length > max) return null
  return value
}

const summary = httpAction(async (ctx, request) => {
  if (!(await authorized(request))) return unauthorized()

  const body = await readBody(request, MAX_SUMMARY_BODY_BYTES)
  if (body instanceof Response) return body

  const room = boundedString(body.room, MAX_ROOM_CHARS)
  const userId = boundedString(body.userId, MAX_USER_ID_CHARS)
  const jobId = boundedString(body.jobId, MAX_JOB_ID_CHARS)
  if (room === null || userId === null || jobId === null) {
    return badRequest(
      "expected { room, userId, jobId, about?, goal?, transcript?, review?, " +
        "corrections?, turns?, anchorRatio?, asks?, lookups? }"
    )
  }

  // Each of the three is optional and independently written. Absent means
  // "leave the column alone", which is what lets the worker send the
  // transcript at teardown and the Review whenever it finished generating.
  let about: string | undefined
  if (body.about !== undefined) {
    if (
      typeof body.about !== "string" ||
      body.about.length > SUMMARY_LIMITS.aboutChars
    ) {
      return badRequest(
        `about must be a string of at most ${SUMMARY_LIMITS.aboutChars} chars`
      )
    }
    // Trimmed, and an empty line is "we did not write one" rather than a
    // stored `""` every surface would have to special-case — the same rule
    // `users.email` follows.
    const trimmed = body.about.trim()
    if (trimmed.length > 0) about = trimmed
  }

  let transcript: Array<{ role: "learner" | "tutor"; text: string }> | undefined
  if (body.transcript !== undefined) {
    const raw = boundedArray(body.transcript, SUMMARY_LIMITS.transcriptTurns)
    if (raw === null) {
      return badRequest(
        `transcript must be an array of at most ${SUMMARY_LIMITS.transcriptTurns} turns`
      )
    }
    const turns: Array<{ role: "learner" | "tutor"; text: string }> = []
    for (const entry of raw) {
      if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
        return badRequest("transcript turns must be { role, text }")
      }
      const { role, text } = entry as Record<string, unknown>
      // A role the schema does not know would fail the mutation's validator
      // and turn a whole teardown report into a 500. Rejected by name here,
      // where the answer is a 400 the worker can read.
      if (role !== "learner" && role !== "tutor") {
        return badRequest('transcript role must be "learner" or "tutor"')
      }
      if (typeof text !== "string" || text.length > SUMMARY_LIMITS.turnChars) {
        return badRequest(
          `transcript text must be a string of at most ${SUMMARY_LIMITS.turnChars} chars`
        )
      }
      turns.push({ role, text })
    }
    transcript = turns
  }

  let review:
    | {
        vocab: Array<{ target: string; anchor: string }>
        phrases: Array<{ target: string; anchor: string }>
        tables: Array<{
          verb: string
          tense: string
          rows: Array<{ person: string; form: string }>
        }>
      }
    | undefined
  if (body.review !== undefined) {
    const material = body.review
    if (
      material === null ||
      typeof material !== "object" ||
      Array.isArray(material)
    ) {
      return badRequest("review must be { vocab, phrases, tables }")
    }
    const {
      vocab: rawVocab,
      phrases: rawPhrases,
      tables: rawTables,
    } = material as Record<string, unknown>
    const vocabRaw = boundedArray(rawVocab, SUMMARY_LIMITS.reviewVocab)
    const phrasesRaw = boundedArray(rawPhrases, SUMMARY_LIMITS.reviewPhrases)
    const tablesRaw = boundedArray(rawTables, SUMMARY_LIMITS.reviewTables)
    if (vocabRaw === null || phrasesRaw === null || tablesRaw === null) {
      return badRequest(
        `review must be { vocab, phrases, tables } with at most ` +
          `${SUMMARY_LIMITS.reviewVocab} / ${SUMMARY_LIMITS.reviewPhrases} / ` +
          `${SUMMARY_LIMITS.reviewTables} entries`
      )
    }
    const vocab: Array<{ target: string; anchor: string }> = []
    for (const entry of vocabRaw) {
      const item = pair(entry, "target", "anchor")
      if (item === null)
        return badRequest("review vocab items must be { target, anchor }")
      vocab.push(item)
    }
    const phrases: Array<{ target: string; anchor: string }> = []
    for (const entry of phrasesRaw) {
      const item = pair(entry, "target", "anchor")
      if (item === null)
        return badRequest("review phrases must be { target, anchor }")
      phrases.push(item)
    }
    const tables: Array<{
      verb: string
      tense: string
      rows: Array<{ person: string; form: string }>
    }> = []
    for (const entry of tablesRaw) {
      const head = pair(entry, "verb", "tense")
      if (head === null) {
        return badRequest("review tables must be { verb, tense, rows }")
      }
      const rowsRaw = boundedArray(
        (entry as Record<string, unknown>).rows,
        SUMMARY_LIMITS.tableRows
      )
      if (rowsRaw === null) {
        return badRequest(
          `review table rows must be an array of at most ${SUMMARY_LIMITS.tableRows}`
        )
      }
      const rows: Array<{ person: string; form: string }> = []
      for (const row of rowsRaw) {
        const cell = pair(row, "person", "form")
        if (cell === null) {
          return badRequest("review table rows must be { person, form }")
        }
        rows.push(cell)
      }
      tables.push({ verb: head.verb, tense: head.tense, rows })
    }
    review = { vocab, phrases, tables }
  }

  // The corrections the worker's analyzer produced. Same element shape as the
  // client's `SessionOutcome.corrections`, and the same bounds `sessions.finish`
  // clamps to, because it lands in the same column.
  let corrections:
    | Array<{
        id: string
        original: string
        replacement: string
        category: string
        severity: string
        explanation: string
      }>
    | undefined
  if (body.corrections !== undefined) {
    const raw = boundedArray(body.corrections, SUMMARY_LIMITS.corrections)
    if (raw === null) {
      return badRequest(
        `corrections must be an array of at most ${SUMMARY_LIMITS.corrections}`
      )
    }
    const found: NonNullable<typeof corrections> = []
    for (const entry of raw) {
      if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
        return badRequest(
          "corrections must be { id, original, replacement, category, severity, explanation }"
        )
      }
      const record = entry as Record<string, unknown>
      const fields = [
        "id",
        "original",
        "replacement",
        "category",
        "severity",
        "explanation",
      ] as const
      for (const field of fields) {
        const value = record[field]
        if (
          typeof value !== "string" ||
          value.length > SUMMARY_LIMITS.correctionChars
        ) {
          return badRequest(
            `corrections.${field} must be a string of at most ${SUMMARY_LIMITS.correctionChars} chars`
          )
        }
      }
      found.push({
        id: record.id as string,
        original: record.original as string,
        replacement: record.replacement as string,
        category: record.category as string,
        severity: record.severity as string,
        explanation: record.explanation as string,
      })
    }
    corrections = found
  }

  /* -- step 3: the goal, the counts, and the study residue ---------------- */

  // The goal is the only new field that is an OBJECT, and the only one whose
  // shape a wrong worker could get subtly wrong. `source` is checked by name
  // because it is what the surfaces branch on — an unknown source is a 400
  // here rather than a 500 out of the mutation's closed union.
  let goal:
    | { text: string; forms: string[]; source: "plan" | "tool" | "extracted" }
    | undefined
  if (body.goal !== undefined) {
    const raw = body.goal
    if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
      return badRequest("goal must be { text, forms, source }")
    }
    const {
      text: rawText,
      forms: rawForms,
      source: rawSource,
    } = raw as Record<string, unknown>
    if (typeof rawText !== "string") {
      return badRequest("goal.text must be a string")
    }
    // Trimmed and required non-empty, unlike `about`: an absent `about` is an
    // ordinary state (nobody summarized), but a goal object with no line in
    // it is not a goal — it is a bug that would render as an empty "you set
    // up" on the History card.
    const text = rawText.trim()
    if (text.length === 0 || text.length > SUMMARY_LIMITS.goalChars) {
      return badRequest(
        `goal.text must be a non-empty string of at most ${SUMMARY_LIMITS.goalChars} chars`
      )
    }
    const formsRaw = boundedArray(rawForms, SUMMARY_LIMITS.goalForms)
    if (formsRaw === null) {
      return badRequest(
        `goal.forms must be an array of at most ${SUMMARY_LIMITS.goalForms} strings`
      )
    }
    const forms: string[] = []
    for (const form of formsRaw) {
      if (
        typeof form !== "string" ||
        form.length > SUMMARY_LIMITS.goalFormChars
      ) {
        return badRequest(
          `goal.forms entries must be strings of at most ${SUMMARY_LIMITS.goalFormChars} chars`
        )
      }
      forms.push(form)
    }
    if (
      rawSource !== "plan" &&
      rawSource !== "tool" &&
      rawSource !== "extracted"
    ) {
      return badRequest('goal.source must be "plan", "tool" or "extracted"')
    }
    goal = { text, forms, source: rawSource }
  }

  // A count and a ratio. Both are checked at their real bounds rather than
  // merely "is a number", because both are printed: a negative turn count or
  // a ratio of 4 reads as a broken product, and NaN passes `typeof number`.
  let turns: number | undefined
  if (body.turns !== undefined) {
    if (
      typeof body.turns !== "number" ||
      !Number.isSafeInteger(body.turns) ||
      body.turns < 0 ||
      body.turns > MAX_TURNS
    ) {
      return badRequest(`turns must be an integer between 0 and ${MAX_TURNS}`)
    }
    turns = body.turns
  }

  let anchorRatio: number | undefined
  if (body.anchorRatio !== undefined) {
    if (
      typeof body.anchorRatio !== "number" ||
      !Number.isFinite(body.anchorRatio) ||
      body.anchorRatio < 0 ||
      body.anchorRatio > 1
    ) {
      return badRequest("anchorRatio must be a number between 0 and 1")
    }
    anchorRatio = body.anchorRatio
  }

  // The questions, not the answers: what the learner did not know is the
  // study record, and the answer is already in the transcript of the pause.
  let asks: string[] | undefined
  if (body.asks !== undefined) {
    const raw = boundedArray(body.asks, SUMMARY_LIMITS.asks)
    if (raw === null) {
      return badRequest(
        `asks must be an array of at most ${SUMMARY_LIMITS.asks} questions`
      )
    }
    const questions: string[] = []
    for (const question of raw) {
      if (
        typeof question !== "string" ||
        question.length > SUMMARY_LIMITS.askChars
      ) {
        return badRequest(
          `asks entries must be strings of at most ${SUMMARY_LIMITS.askChars} chars`
        )
      }
      questions.push(question)
    }
    asks = questions
  }

  let lookups: Array<{ source: string; translation: string }> | undefined
  if (body.lookups !== undefined) {
    const raw = boundedArray(body.lookups, SUMMARY_LIMITS.lookups)
    if (raw === null) {
      return badRequest(
        `lookups must be an array of at most ${SUMMARY_LIMITS.lookups} entries`
      )
    }
    const found: Array<{ source: string; translation: string }> = []
    for (const entry of raw) {
      const item = pair(
        entry,
        "source",
        "translation",
        SUMMARY_LIMITS.lookupChars
      )
      if (item === null) {
        return badRequest(
          `lookups must be { source, translation } with strings of at most ${SUMMARY_LIMITS.lookupChars} chars`
        )
      }
      found.push(item)
    }
    lookups = found
  }

  // `jobId` is validated but not passed on: this write has no idempotency key
  // because it does not need one — it is a last-write-wins patch, not a
  // ledger entry. It is required on the wire so every worker report carries
  // the same three identifiers and the logs on both sides join up.
  await ctx.runMutation(internal.sessions.recordSummary, {
    room,
    clerkId: userId,
    about,
    transcript,
    review,
    corrections,
    goal,
    turns,
    anchorRatio,
    asks,
    lookups,
  })
  return ok({ ok: true })
})

const http = httpRouter()
http.route({ path: "/tutor/debit", method: "POST", handler: debit })
http.route({ path: "/tutor/balance", method: "POST", handler: balance })
http.route({ path: "/tutor/summary", method: "POST", handler: summary })

export default http
