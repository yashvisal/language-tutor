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
} as const

export type TextStreamTopic =
  (typeof TEXT_STREAM_TOPICS)[keyof typeof TEXT_STREAM_TOPICS]

/** Text stream attributes. The `lk.*` keys are set by LiveKit on the
 * `lk.transcription` topic; the rest are set by our worker. */
export const STREAM_ATTRIBUTES = {
  /** Join key across transcription and correction payloads. */
  segmentId: "lk.segment_id",
  /** `"true"` on the final stream for a segment, `"false"` on interims. */
  transcriptionFinal: "lk.transcription_final",
  /** Present on transcription streams; identifies the transcribed track. */
  transcribedTrackId: "lk.transcribed_track_id",
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
  /** Select-to-translate: one settled span in, one translation out. */
  translate: "tutor.translate",
} as const

/**
 * The `tutor.translate` request. Snake_cased for the same reason as
 * `ResumePayload`: this is the JSON the Python worker parses, not a frontend
 * type.
 */
export interface TranslateRequest {
  text: string
  speaker: string
  /** The turn the span was selected in, for the worker's logs. */
  turn_id: string | null
}

/**
 * Longest span the worker will translate. Mirrored on the frontend — the
 * overlay refuses to open on a stray select-all rather than paying for a round
 * trip that can only come back as an error. The Python side keeps its own copy
 * (cross-language duplication, documented there); this is the single frontend
 * source.
 */
export const MAX_SPAN_CHARS = 600

/**
 * How long the overlay waits for a translation. The worker self-limits to 4s
 * and answers failures with an error string rather than silence, so anything
 * that reaches this ceiling is the transport, not the model.
 */
export const TRANSLATE_TIMEOUT_MS = 5000

/** The `tutor.translate` reply: exactly one of these fields is present. */
export interface TranslateResponse {
  translation?: string
  error?: string
}

/**
 * The correction the learner inspected during a hold, as it travels on the
 * wire. Deliberately snake_cased and stringly-typed: this is the JSON the
 * Python worker parses, not the frontend's `Correction`.
 */
export interface ResumeCorrectionPayload {
  original: string
  replacement: string
  category: string
}

/**
 * The `tutor.resume` payload — the facts the worker needs to decide whether,
 * and how, the tutor re-enters the conversation. A hold that never reached the
 * agent (see the debounce in `live-producer.ts`) sends nothing at all, so every
 * payload here describes a real study pause.
 */
export interface ResumePayload {
  /** Measured from when the pause RPC was sent, not when the hold opened. */
  held_ms: number
  /** Every reason that was active at some point during the hold. */
  reasons: string[]
  /** The most recently inspected correction, if the hold included one. */
  correction: ResumeCorrectionPayload | null
}

/** Participant attribute keys, all published by the agent. `paused` is mirrored
 * so pause state survives reconnects; `analyzer` tells the surface whether
 * corrections are coming at all, so a learner turn need not wait on an analyzer
 * that isn't running; `minutesLeft`/`sessionOver` are the clock, which the
 * worker owns outright — the surface renders these and never computes them. */
export const PARTICIPANT_ATTRIBUTES = {
  paused: "tutor.paused",
  analyzer: "tutor.analyzer",
  /** Integer string. Published on start, every 30s, at one minute, and at zero. */
  minutesLeft: "tutor.minutes_left",
  /** `"true"` once the clock — not the learner — ended the session. */
  sessionOver: "tutor.session_over",
} as const

/** Value convention for boolean participant attributes. */
export const ATTRIBUTE_TRUE = "true"
export const ATTRIBUTE_FALSE = "false"

/** Values of the `analyzer` attribute. Absent means "assume on". */
export const ANALYZER_ON = "on"
export const ANALYZER_OFF = "off"

/** Room names are `lesson-<slug>-<timestamp>-<nonce>`; one room per session. */
export const ROOM_NAME_PREFIX = "lesson"

/** Languages the v0 tutor session is configured for. */
export const TARGET_LANGUAGE = "es"
export const ANCHOR_LANGUAGE = "en"

/**
 * Minutes a session is allowed to run. One credit = 15 minutes (see
 * plans/product-vision.md, 2026-08-20 #2). The token route embeds this in the
 * dispatch metadata and the worker's clock enforces it.
 *
 * TODO(credits): derive from the learner's ledger balance once auth and the
 * database land; a constant is correct only while every session is free.
 */
export const SESSION_MAX_MINUTES = 10

/**
 * The dispatch metadata the token route signs into the room config, as the
 * Python worker parses it. Snake_cased for the same reason as `ResumePayload`:
 * this is wire JSON, not a frontend type. `user_id` is null until auth lands.
 */
export interface SessionDispatchMetadata {
  max_minutes: number
  user_id: string | null
  plan: {
    topic: string | null
    scenario: string | null
    tenses: string[]
    vocab: string[]
    level: string | null
  }
}
