import { NextResponse, type NextRequest } from "next/server"
import { auth } from "@clerk/nextjs/server"
import { fetchMutation, fetchQuery } from "convex/nextjs"
import {
  AccessToken,
  RoomAgentDispatch,
  RoomConfiguration,
} from "livekit-server-sdk"

import { api } from "@/convex/_generated/api"
import { OPEN_SESSION_PREFIX, RATE_LIMIT_PREFIX } from "@/lib/billing"
import { MissingEnvVarError, requireServerEnv } from "@/lib/env"
import type { SessionPlan } from "@/lib/session/contract"
import { boundPlan } from "@/lib/session/plan"
import {
  ROOM_NAME_PREFIX,
  TUTOR_AGENT_NAME,
  type SessionDispatchMetadata,
} from "@/lib/session/protocol"

/**
 * LiveKit token endpoint, shaped like the standardized one
 * (https://docs.livekit.io/frontends/build/authentication/endpoint.md) but
 * deliberately narrower: it returns `201 { server_url, participant_token }`
 * and reads exactly ONE field off the request body.
 *
 * **Nothing else in the body is honoured.** Everything the standardized shape
 * would let a client set — `room_name`, `participant_identity`,
 * `participant_name`, `participant_metadata`, `participant_attributes`,
 * `room_config` — is signed into the token, and a signed claim a stranger
 * chose is not a claim. The two that mattered:
 * - `room_name` was a free-conversation exploit. A room carries the debit's
 *   high-water mark (`sessions.secondsBilled`), so re-joining a room that had
 *   already been billed for N seconds made every report of a *fresh* worker
 *   clock fall below N and debit zero. The room is minted here, always.
 * - `participant_identity` / `participant_name` named the learner to LiveKit;
 *   they are minted here from the Clerk id instead.
 *
 * The one field read: `session_plan`, the learner's declared intent, bounded
 * by `boundPlan` before it goes anywhere near a model prompt.
 *
 * Tutor-specific behavior:
 * - a unique room per session (`lesson-<slug>-<ts>-<nonce>`)
 * - explicit agent dispatch for the `tutor` worker embedded in the token's
 *   room config, so exactly one agent joins the room
 *
 * This is also the money gate, and it is the only one: a token is minted only
 * for a signed-in learner with seconds left and no conversation already open,
 * the balance is signed into the dispatch metadata, and the `sessions` row the
 * worker will debit against is written here.
 *
 * Three refusals the surface reads as states rather than faults:
 * - **401** not signed in.
 * - **402** `{ error: "out_of_minutes" }` — no seconds left.
 * - **409** `{ error, code: "open_session" }` — this learner already has a
 *   conversation running (another tab). Two tabs would each budget the *whole*
 *   balance and the ledger would go negative; `sessions.start` is the guard.
 * - **429** `{ error, code: "rate_limited" }` — this learner has started more
 *   than `MAX_STARTS_PER_HOUR` conversations in the last hour. The free grant
 *   is per Clerk id, so this is what stands between a script and N accounts x
 *   ten free minutes (audit B12).
 */

/** Token lifetime. Only needs to outlive connect + any reconnect attempt, but
 * a lesson can run long, so keep it comfortably above session length. */
const TOKEN_TTL = "1h"

/** Every other field of the standardized request shape is accepted by the
 * parser and ignored by the handler — see the note above. */
type TokenRequestBody = {
  /** Non-standard, ours. Untrusted: normalized by `boundPlan` before use. */
  session_plan?: unknown
}

function slugify(value: string) {
  const slug = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 24)
  return slug || "guest"
}

function nonce() {
  return crypto.randomUUID().replace(/-/g, "").slice(0, 8)
}

function generateRoomName(identity: string) {
  return `${ROOM_NAME_PREFIX}-${slugify(identity)}-${Date.now()}-${nonce()}`
}

/**
 * Builds the room config carrying explicit agent dispatch, with the session's
 * marching orders as dispatch metadata.
 *
 * The room config is signed into the token, so anything read off the request
 * body here would let a caller dictate egress, participant limits or room
 * timeouts: the client's `room_config` is ignored outright and every field
 * below is constructed server-side. The plan is the one exception, and it is
 * bounded first — it is free text a learner typed, and it ends up in a model
 * prompt.
 *
 * `user_id` and `balance_s` are authoritative because they are signed, not
 * because the client asked nicely: the worker bills the id it is given here.
 */
function buildRoomConfig(
  plan: SessionPlan,
  userId: string,
  balanceSeconds: number
) {
  const metadata: SessionDispatchMetadata = {
    user_id: userId,
    balance_s: balanceSeconds,
    plan: {
      topic: plan.topic,
      scenario: plan.scenario,
      tenses: plan.tenses,
      focus_note: plan.focusNote,
      note: plan.note,
      vocab: plan.vocab,
      level: plan.level,
    },
  }
  return new RoomConfiguration({
    agents: [
      new RoomAgentDispatch({
        agentName: TUTOR_AGENT_NAME,
        metadata: JSON.stringify(metadata),
      }),
    ],
  })
}

export async function POST(request: NextRequest) {
  // Auth first: nothing below should run for a stranger, least of all a Convex
  // read or a room name minted from their identity.
  const { userId, getToken } = await auth()
  if (!userId) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 })
  }
  const convexToken = await getToken({ template: "convex" })
  if (!convexToken) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 })
  }

  let apiKey: string
  let apiSecret: string
  let serverUrl: string
  try {
    ;[apiKey, apiSecret, serverUrl] = requireServerEnv(
      "LIVEKIT_API_KEY",
      "LIVEKIT_API_SECRET",
      "LIVEKIT_URL"
    )
  } catch (error) {
    if (!(error instanceof MissingEnvVarError)) {
      throw error
    }
    console.error(`/api/token: missing env vars: ${error.names.join(", ")}`)
    return NextResponse.json(
      { error: "Server misconfigured: LiveKit credentials are not set" },
      { status: 500 }
    )
  }

  let body: TokenRequestBody
  try {
    const parsed: unknown = await request.json()
    body =
      parsed && typeof parsed === "object" ? (parsed as TokenRequestBody) : {}
  } catch {
    // TokenSource always sends a JSON body, but an empty body is harmless:
    // every field is optional.
    body = {}
  }

  // The balance, read with the learner's own token so Convex sees the same
  // identity the browser does. A zero balance is not an error: it is the state
  // the out-of-minutes surface exists for, so it gets its own status.
  let balanceSeconds: number
  try {
    const viewer = await fetchQuery(
      api.users.viewer,
      {},
      { token: convexToken }
    )
    balanceSeconds = viewer?.seconds ?? 0
  } catch (error) {
    console.error("/api/token: could not read the balance", error)
    return NextResponse.json(
      { error: "Could not read your balance" },
      { status: 500 }
    )
  }
  if (balanceSeconds <= 0) {
    return NextResponse.json({ error: "out_of_minutes" }, { status: 402 })
  }

  // Minted here, never read off the body: the identity is what LiveKit sees
  // and what the room name is built from, so a client-chosen one is a
  // client-chosen room (see the note at the top of this file).
  const participantIdentity = `learner-${nonce()}`
  const participantName = "Learner"
  const roomName = generateRoomName(participantIdentity)

  const plan = boundPlan(body.session_plan)

  // Mint first, record second. The other order leaves an orphan `sessions` row
  // whenever `toJwt` fails — a row with a high-water mark of zero that the
  // debit fallback would happily adopt — and there is no rollback for it. This
  // order can only ever *discard* a token nobody received, which costs nothing:
  // the room is never joined and the agent is never dispatched.
  let participantToken: string
  try {
    const at = new AccessToken(apiKey, apiSecret, {
      identity: participantIdentity,
      name: participantName,
      ttl: TOKEN_TTL,
    })

    at.addGrant({
      roomJoin: true,
      room: roomName,
      canPublish: true,
      canPublishData: true,
      canSubscribe: true,
    })

    at.roomConfig = buildRoomConfig(plan, userId, balanceSeconds)

    participantToken = await at.toJwt()
  } catch (error) {
    console.error("/api/token: failed to mint access token", error)
    return NextResponse.json(
      { error: "Failed to generate token" },
      { status: 500 }
    )
  }

  // The row the worker's debits land on, and the one-open-session guard. If
  // this fails the token above is dropped on the floor unread: a session the
  // ledger has never heard of is worse than a connect that never happened.
  try {
    await fetchMutation(
      api.sessions.start,
      { room: roomName, plan },
      { token: convexToken }
    )
  } catch (error) {
    // `sessions.start` refuses while this learner already has a row with no
    // `endedAt` younger than 15 minutes. That is a second tab, not a fault:
    // each one would budget the whole balance and the ledger would go
    // negative by (N-1) x balance. Distinguished by the message prefix
    // because a Convex mutation error reaches us as text.
    if (String(error).includes(OPEN_SESSION_PREFIX)) {
      return NextResponse.json(
        { error: "A conversation is already running", code: "open_session" },
        { status: 409 }
      )
    }
    // The hourly start limit. Also a state rather than a fault, and also
    // carried by a message prefix: 429 so the client can say "give it a
    // while" instead of "something went wrong on our side".
    if (String(error).includes(RATE_LIMIT_PREFIX)) {
      return NextResponse.json(
        { error: "Too many sessions started recently", code: "rate_limited" },
        { status: 429 }
      )
    }
    console.error("/api/token: could not record the session", error)
    return NextResponse.json(
      { error: "Could not start the session" },
      { status: 500 }
    )
  }

  return NextResponse.json(
    { server_url: serverUrl, participant_token: participantToken },
    { status: 201 }
  )
}
