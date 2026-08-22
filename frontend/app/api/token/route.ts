import { NextResponse, type NextRequest } from "next/server"
import {
  AccessToken,
  RoomAgentDispatch,
  RoomConfiguration,
} from "livekit-server-sdk"

import { MissingEnvVarError, requireServerEnv } from "@/lib/env"
import type { SessionPlan } from "@/lib/session/contract"
import { boundPlan } from "@/lib/session/plan"
import {
  ROOM_NAME_PREFIX,
  SESSION_MAX_MINUTES,
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
 * TODO(auth): there is no auth on this endpoint yet. Add a bearer/session check
 * here before this is exposed anywhere public.
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
 * `max_minutes` is what the worker's clock counts down; it is authoritative
 * because it is signed, not because the client asked nicely.
 */
function buildRoomConfig(plan: SessionPlan) {
  const metadata: SessionDispatchMetadata = {
    // TODO(credits): read the learner's remaining minutes from the ledger once
    // auth and the database land, and refuse the token at a zero balance.
    max_minutes: SESSION_MAX_MINUTES,
    // TODO(auth): the authenticated user id, once there is one.
    user_id: null,
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

  const participantIdentity =
    body.participant_identity?.trim() || `learner-${nonce()}`
  const participantName = body.participant_name?.trim() || "Learner"
  const roomName =
    body.room_name?.trim() || generateRoomName(participantIdentity)

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

    at.roomConfig = buildRoomConfig(boundPlan(body.session_plan))

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
