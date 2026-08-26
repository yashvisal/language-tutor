import { httpRouter } from "convex/server"
import { verifyWebhook } from "@clerk/backend/webhooks"

import { httpAction } from "./_generated/server"
import { internal } from "./_generated/api"
import { DELTA_CAP_PREFIX, MAX_DELTA_PER_CALL_S } from "../lib/billing"
import { verifyWorkerToken } from "./m2m"
import { parseBalanceBody, parseDebitBody, parseSummaryBody } from "./wire"

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
 * | `reason`  | string | **optional**, and only meaningful with `final: true`. One of `ended`, `out_of_minutes_idle`, `hold_idle`, `learner_left`, `model_error`, `ledger_failure`, `tutor_silent`. Anything else is a `400`, on every report — including the periodic ones that ignore it, so a wrong value is learned early rather than at teardown. (`stale` is in the enum and therefore accepted, but it is the reconciliation cron's word for a row nobody ever closed; the worker has no reason to send it.) |
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
 *   "estCostUsd": 0.4213,
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
 * | `estCostUsd` | number | **optional**, finite, `0 <= x <= 1000`. The worker's estimated MODEL spend for this session in USD (`backend/src/usage.py`) — realtime audio plus every text call the session made. Internal only: no surface prints it, and it is not what the learner is billed (that is `secondsBilled`). Sent on the teardown report, when the number is final. |
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
 *
 * ## `POST /clerk/webhook` — a different door entirely
 *
 * Not part of the worker contract above, and it does not share a single line
 * of it. The caller is **Clerk**, not the worker; the transport is a **Svix /
 * Standard Webhooks signature**, not an M2M bearer; the body is Clerk's event
 * envelope, not ours. It lives in this file because this file is where Convex
 * HTTP routes live, and nowhere else — read the two halves separately.
 *
 * **Why it exists.** Clerk owns identity, so Clerk is the only half that knows
 * an account is gone. Without this route, deleting a learner at Clerk left
 * their `users`, `creditLedger` and `sessions` rows here forever (audit B5) —
 * including the learner speech retained in `sessions.outcome.corrections` and
 * `sessions.transcript`. The Privacy page promises deletion; this route is how
 * the promise is kept.
 *
 * | | |
 * |---|---|
 * | Method | `POST` |
 * | Auth | `svix-id` / `svix-timestamp` / `svix-signature`, verified against `CLERK_WEBHOOK_SIGNING_SECRET` on the Convex deployment (`npx convex env set`). Verification is `verifyWebhook` from `@clerk/backend/webhooks` — HMAC-SHA256 over `<id>.<timestamp>.<body>`, constant-time compare, 5-minute timestamp tolerance. |
 * | Endpoint to register | `<convex site url>/clerk/webhook`, subscribed to `user.deleted`. |
 *
 * Responses:
 *
 * | status | body | meaning |
 * |--------|------|---------|
 * | `200`  | `{ "ok": true }` | Verified. Either the deletion was scheduled, or the event was not one we act on — Clerk is told the same thing either way, because an event we ignore is not a delivery failure. |
 * | `400`  | `{ "error": "<why>" }` | Verified, but the envelope is unusable (a `user.deleted` with no `data.id`, or a body over the ceiling). |
 * | `401`  | `{ "error": "unauthorized" }` | Missing or bad signature — **or `CLERK_WEBHOOK_SIGNING_SECRET` unset**. A deployment that cannot verify accepts nothing; the same fail-closed rule as the M2M routes. |
 *
 * `user.deleted` runs `internal.users.deleteByClerkId` with `data.id` — the
 * Clerk id, which is what `users.clerkId` is keyed on. That mutation is
 * idempotent (an unknown id is a `200` and a no-op) and self-rescheduling in
 * batches, so a re-delivery is harmless and a heavy account still completes.
 * **Every other event type is a `200` and nothing else**, so subscribing the
 * endpoint to more events by accident cannot break it.
 *
 * Nothing from the payload is logged beyond the event type and the Clerk id:
 * a Clerk event envelope carries email addresses and profile data, and this
 * deployment's logs are not the place for them.
 *
 * ## Where the rules live
 *
 * This file is the contract and the runtime: the token check, the body-size
 * ceiling, the JSON parse, and the dispatch. Every *field* rule above — the
 * bounds, the enums, the shapes, and the exact `400` sentence each one
 * produces — is in `convex/wire.ts`, as pure functions over a parsed body, so
 * that they can be exercised directly (`convex/wire.test.ts`) instead of
 * through an HTTP round trip. Changing a bound means changing `wire.ts` and
 * this comment together.
 */

/** Largest body the debit and balance routes will read. Both payloads are a
 * handful of short fields; 4 KB is generous by two orders of magnitude and it
 * is checked before the JSON parser ever sees the bytes, so an unbounded body
 * cannot be turned into unbounded parse work. */
const MAX_BODY_BYTES = 4096

/** `/tutor/summary`'s own ceiling — the one payload that is not a handful of
 * short fields. 256 KB holds 200 turns of 500 characters, the Review material
 * and the about line with room to spare, and it is still checked before the
 * JSON parser sees a byte. The two routes do NOT share a bound: raising the
 * debit route's 4 KB to fit a transcript would widen the smaller, more
 * valuable seam for nothing. */
const MAX_SUMMARY_BODY_BYTES = 262144

/** `/clerk/webhook`'s ceiling. Clerk's event envelopes are a few KB and the
 * signature is over the exact bytes, so this can only be checked against the
 * declared `Content-Length` before `verifyWebhook` consumes the body — a
 * ceiling on absurdity rather than a tight bound. */
const MAX_WEBHOOK_BODY_BYTES = 65536

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

const debit = httpAction(async (ctx, request) => {
  if (!(await authorized(request))) return unauthorized()

  const body = await readBody(request)
  if (body instanceof Response) return body

  // Every field rule lives in `convex/wire.ts`, where it is unit-tested
  // without an HTTP round trip. This route is auth, bytes, and dispatch.
  const parsed = parseDebitBody(body)
  if (!parsed.ok) return badRequest(parsed.error)

  let result
  try {
    result = await ctx.runMutation(internal.sessions.debit, parsed.value)
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

  const parsed = parseBalanceBody(body)
  if (!parsed.ok) return badRequest(parsed.error)
  const { clerkId, room } = parsed.value

  const { balanceSeconds } = await ctx.runQuery(
    internal.users.balanceByClerkId,
    { clerkId }
  )
  // Absent room is 0, not an error: only a *starting* job needs to be told
  // what the room has already been billed.
  const secondsBilled =
    room === null
      ? 0
      : await ctx.runQuery(internal.sessions.billedSecondsForRoom, { room })

  return ok({ balanceSeconds, secondsBilled })
})

const summary = httpAction(async (ctx, request) => {
  if (!(await authorized(request))) return unauthorized()

  const body = await readBody(request, MAX_SUMMARY_BODY_BYTES)
  if (body instanceof Response) return body

  const parsed = parseSummaryBody(body)
  if (!parsed.ok) return badRequest(parsed.error)

  // `parsed.value.jobId` is validated and deliberately not passed on: this
  // write has no idempotency key because it does not need one — it is a
  // last-write-wins patch, not a ledger entry. It is required on the wire so
  // every worker report carries the same three identifiers and the logs on
  // both sides join up.
  await ctx.runMutation(internal.sessions.recordSummary, parsed.value.args)
  return ok({ ok: true })
})

/**
 * Clerk's `user.deleted`, and the reason the Privacy page can promise
 * deletion. See the contract section above; the two things worth repeating
 * here are that the secret is read per request (a rotated one takes effect
 * without a redeploy, and a deployment missing it fails closed on every call
 * rather than on whichever call booted the isolate), and that a verified
 * event we do not act on is still a `200` — telling Clerk "failed" for an
 * event we simply ignore would make it retry forever.
 */
const clerkWebhook = httpAction(async (ctx, request) => {
  const signingSecret = process.env.CLERK_WEBHOOK_SIGNING_SECRET
  if (!signingSecret) {
    console.error("/clerk/webhook: CLERK_WEBHOOK_SIGNING_SECRET is not set")
    return unauthorized()
  }

  // The one bound that can be checked without consuming the body — which
  // `verifyWebhook` needs whole, because the signature is over the exact
  // bytes. Clerk's envelopes are a few KB; this is only a ceiling on absurdity.
  const declared = Number(request.headers.get("Content-Length") ?? "")
  if (Number.isFinite(declared) && declared > MAX_WEBHOOK_BODY_BYTES) {
    return badRequest("body too large")
  }

  let event
  try {
    event = await verifyWebhook(request, { signingSecret })
  } catch (error) {
    // Server-side only, and deliberately just the reason: an unverified body
    // is a stranger's, and nothing in it belongs in these logs.
    console.error("/clerk/webhook: signature verification failed", error)
    return unauthorized()
  }

  if (event.type !== "user.deleted") {
    // Verified and uninteresting. Acknowledged so Clerk stops retrying it.
    console.log(`/clerk/webhook: ignoring ${event.type}`)
    return ok({ ok: true })
  }

  const clerkId = event.data.id
  if (typeof clerkId !== "string" || clerkId.length === 0) {
    // Clerk types `data.id` as optional on the deleted-object envelope. A
    // delete with nothing to delete is malformed, not something to retry.
    console.error("/clerk/webhook: user.deleted with no id")
    return badRequest("user.deleted is missing data.id")
  }

  // The type and the id, and nothing else — see the contract note on logging.
  console.log(`/clerk/webhook: user.deleted ${clerkId}`)
  await ctx.runMutation(internal.users.deleteByClerkId, { clerkId })
  return ok({ ok: true })
})

const http = httpRouter()
http.route({ path: "/tutor/debit", method: "POST", handler: debit })
http.route({ path: "/tutor/balance", method: "POST", handler: balance })
http.route({ path: "/tutor/summary", method: "POST", handler: summary })
// Not an M2M route: Svix-signed by Clerk, and the only one here whose caller
// is not the worker.
http.route({ path: "/clerk/webhook", method: "POST", handler: clerkWebhook })

export default http
