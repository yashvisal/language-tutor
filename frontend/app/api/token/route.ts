import { NextResponse, type NextRequest } from "next/server"
import {
  AccessToken,
  RoomAgentDispatch,
  RoomConfiguration,
} from "livekit-server-sdk"

import { ROOM_NAME_PREFIX, TUTOR_AGENT_NAME } from "@/lib/session/protocol"

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
 * Builds the room config carrying explicit agent dispatch.
 *
 * Constructed entirely server-side: the room config is signed into the token,
 * so anything read off the request body here would let a caller dictate
 * egress, participant limits or room timeouts. The client's `room_config` is
 * therefore ignored outright, and dispatch metadata is empty because the
 * worker does not consume it.
 */
function buildRoomConfig() {
  return new RoomConfiguration({
    agents: [new RoomAgentDispatch({ agentName: TUTOR_AGENT_NAME })],
  })
}

export async function POST(request: NextRequest) {
  const apiKey = process.env.LIVEKIT_API_KEY
  const apiSecret = process.env.LIVEKIT_API_SECRET
  const serverUrl = process.env.LIVEKIT_URL

  if (!apiKey || !apiSecret || !serverUrl) {
    const missing = [
      !apiKey && "LIVEKIT_API_KEY",
      !apiSecret && "LIVEKIT_API_SECRET",
      !serverUrl && "LIVEKIT_URL",
    ].filter(Boolean)
    console.error(`/api/token: missing env vars: ${missing.join(", ")}`)
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

    at.roomConfig = buildRoomConfig()

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
