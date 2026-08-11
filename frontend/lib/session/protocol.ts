/**
 * Protocol constants shared between the Next.js frontend and the Python agent
 * worker. This module is dependency-free on purpose: it is imported both from
 * the server (`app/api/token/route.ts`) and from client code, so it must not
 * pull in `livekit-client` or any browser/node-only API.
 *
 * Any string that has to match on both sides of the wire lives here.
 */

/** Agent name used for explicit dispatch. Must match the backend worker's
 * `@server.rtc_session(agent_name=...)`. */
export const TUTOR_AGENT_NAME = "tutor"

/** Route that mints LiveKit credentials (standardized token endpoint). */
export const TOKEN_ENDPOINT = "/api/token"

/** Text stream topics. `lk.*` topics are LiveKit built-ins; `tutor.*` topics
 * are ours and are written by the agent worker via `send_text`. */
export const TEXT_STREAM_TOPICS = {
  /** Built-in: live transcription of the learner's (and agent's) speech. */
  transcription: "lk.transcription",
  /** Built-in: text input channel to the agent. */
  chat: "lk.chat",
  /** Ours: structured `Correction[]` JSON for a settled turn. */
  corrections: "tutor.corrections",
  /** Ours: lagging translation of the learner's speech into the anchor language. */
  translation: "tutor.translation",
} as const

export type TextStreamTopic =
  (typeof TEXT_STREAM_TOPICS)[keyof typeof TEXT_STREAM_TOPICS]

/** Text stream attributes. The `lk.*` keys are set by LiveKit on the
 * `lk.transcription` topic; the rest are set by our worker. */
export const STREAM_ATTRIBUTES = {
  /** Join key across transcription, translation and correction payloads. */
  segmentId: "lk.segment_id",
  /** `"true"` on the final stream for a segment, `"false"` on interims. */
  transcriptionFinal: "lk.transcription_final",
  /** Present on transcription streams; identifies the transcribed track. */
  transcribedTrackId: "lk.transcribed_track_id",
  /** Ours: BCP-47-ish language tag on translation streams (e.g. `"en"`). */
  language: "tutor.language",
  /** Ours: source language of a translation stream. */
  sourceLanguage: "tutor.source_language",
  /** Ours: the translate model's item id — one text stream per item. */
  translationItemId: "tutor.item_id",
  /** Ours: the analyzer's own turn id. NOT an `lk.segment_id` — see the
   * corrections join in `live-producer.ts`. */
  turnId: "tutor.turn_id",
} as const

/** RPC methods the frontend invokes on the agent participant. These names are
 * namespaced because RPC methods share one registry per participant; they must
 * match `register_rpc_method(...)` in `backend/src/agent.py` exactly. */
export const RPC_METHODS = {
  pause: "tutor.pause",
  resume: "tutor.resume",
} as const

/** Participant attribute keys. `paused` is mirrored by the agent so pause
 * state survives reconnects. */
export const PARTICIPANT_ATTRIBUTES = {
  paused: "tutor.paused",
} as const

/** Value convention for boolean participant attributes. */
export const ATTRIBUTE_TRUE = "true"
export const ATTRIBUTE_FALSE = "false"

/** Room names are `lesson-<slug>-<timestamp>-<nonce>`; one room per session. */
export const ROOM_NAME_PREFIX = "lesson"

/** Languages the v0 tutor session is configured for. */
export const TARGET_LANGUAGE = "es"
export const ANCHOR_LANGUAGE = "en"
