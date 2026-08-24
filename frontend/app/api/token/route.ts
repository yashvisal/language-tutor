import { NextResponse, type NextRequest } from "next/server"
import { auth } from "@clerk/nextjs/server"
import { fetchMutation, fetchQuery } from "convex/nextjs"
import {
  AccessToken,
  RoomAgentDispatch,
  RoomConfiguration,
} from "livekit-server-sdk"

import { api } from "@/convex/_generated/api"
import { MissingEnvVarError, requireServerEnv } from "@/lib/env"
import type { SessionPlan } from "@/lib/session/contract"
import { boundPlan } from "@/lib/session/plan"
import {
  ROOM_NAME_PREFIX,
  TUTOR_AGENT_NAME,
  type SessionDispatchMetadata,
} from "@/lib/session/protocol"

/**
 * LiveKit standardized token endpoint.
 *
 * Follows https://docs.livekit.io/frontends/build/authentication/endpoint.md:
 * accepts a POST body of `{ room_name?, participant_identity?,
 * participant_name?, participant_metadata?, participant_attributes?,
 * room_config? }` (snake_case, as sent by `TokenSource.endpoint`) and returns
 * `201 { server_url, participant_token }`.
 *
 * Tutor-specific behavior:
 * - a unique room per session (`lesson-<slug>-<ts>-<nonce>`) unless the client
 *   explicitly asks to rejoin a named room
 * - explicit agent dispatch for the `tutor` worker embedded in the token's
 *   room config, so exactly one agent joins the room
 * - `room_config` from the request is ignored: it is signed into the token, so
 *   accepting it would let a caller set egress, participant limits or timeouts
 * - one non-standard body field, `session_plan`: the learner's declared intent
 *   for this session, bounded here and embedded in the dispatch metadata the
 *   worker reads (see `SessionDispatchMetadata`)
 *
 * This is also the money gate, and it is the only one: a token is minted only
 * for a signed-in learner with seconds left, the balance is signed into the
 * dispatch metadata, and the `sessions` row the worker will debit against is
 * written here. A zero balance is a **402**, which the surface reads as "out of
 * minutes" rather than as a failure to connect.
 */

/** Token lifetime. Only needs to outlive connect + any reconnect attempt, but
 * a lesson can run long, so keep it comfortably above session length. */
const TOKEN_TTL = "1h"

type TokenRequestBody = {
  room_name?: string
  participant_identity?: string
  participant_name?: string
  participant_metadata?: string
  participant_attributes?: Record<string, string>
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
    const viewer = await fetchQuery(api.users.viewer, {}, { token: convexToken })
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

  const participantIdentity =
    body.participant_identity?.trim() || `learner-${nonce()}`
  const participantName = body.participant_name?.trim() || "Learner"
  const roomName =
    body.room_name?.trim() || generateRoomName(participantIdentity)

  const plan = boundPlan(body.session_plan)

  // The row the worker's debits land on. Before the token, deliberately: a
  // session the ledger has never heard of is worse than a connect that failed.
  try {
    await fetchMutation(
      api.sessions.start,
      { room: roomName, plan },
      { token: convexToken }
    )
  } catch (error) {
    console.error("/api/token: could not record the session", error)
    return NextResponse.json(
      { error: "Could not start the session" },
      { status: 500 }
    )
  }

  try {
    const at = new AccessToken(apiKey, apiSecret, {
      identity: participantIdentity,
      name: participantName,
      metadata: body.participant_metadata ?? "",
      attributes: body.participant_attributes ?? {},
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

    const participantToken = await at.toJwt()

    return NextResponse.json(
      { server_url: serverUrl, participant_token: participantToken },
      { status: 201 }
    )
  } catch (error) {
    console.error("/api/token: failed to mint access token", error)
    return NextResponse.json(
      { error: "Failed to generate token" },
      { status: 500 }
    )
  }
}
