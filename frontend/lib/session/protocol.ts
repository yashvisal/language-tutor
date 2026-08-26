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
  /** The Ask tab: one learner question in, one coaching answer out. */
  ask: "tutor.ask",
  /** The Review tab: this session's study material, once it exists. */
  review: "tutor.review",
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

/* -------------------------------------------------------------------------- */
/*  The study surface: Ask                                                    */
/* -------------------------------------------------------------------------- */

/**
 * One message of the Ask thread as the worker reads it. The CLIENT owns the
 * thread — the worker answers one question at a time and keeps nothing — so
 * every request carries the recent exchanges as context.
 */
export interface AskMessage {
  role: "learner" | "coach"
  text: string
}

/** The `tutor.ask` request. Snake_cased for the same reason as `ResumePayload`. */
export interface AskRequest {
  question: string
  /** The turn that was on stage when the question was asked, for the worker's logs. */
  turn_id: string | null
  /** The last few exchanges, oldest first. See `ASK_HISTORY_MESSAGES`. */
  history: AskMessage[]
}

/**
 * The `tutor.ask` reply. `limit` marks the worker's invisible cap: it still
 * answers — with a gentle redirect back to speaking — and the client renders
 * that answer like any other. The redirect IS the UX; there is no error state
 * for hitting the cap.
 */
export interface AskResponse {
  answer?: string
  limit?: true
  error?: string
}

/** How much of the thread travels with each question (messages, not exchanges). */
export const ASK_HISTORY_MESSAGES = 16

/**
 * How long the Ask tab waits for a coaching answer. Same budget as translate:
 * the worker self-limits and answers failures with an error string, so
 * reaching this ceiling is the transport, not the model.
 */
export const ASK_TIMEOUT_MS = 5000

/** Longest question the surface will send. A paragraph is not a question. */
export const MAX_QUESTION_CHARS = 400

/* -------------------------------------------------------------------------- */
/*  The study surface: Review                                                 */
/* -------------------------------------------------------------------------- */

/** A study pair: the target-language item and its anchor-language gloss. */
export interface ReviewItem {
  target: string
  anchor: string
}

/**
 * One verb in one tense. Deterministic material (see the phase-5 outline:
 * tables are shipped, never LLM-generated), so the rows arrive in the order
 * they should be read and the UI does not sort them.
 */
export interface ConjugationTable {
  verb: string
  tense: string
  rows: Array<{ person: string; form: string }>
}

/** Everything the Review tab renders, generated once per session. */
export interface ReviewMaterial {
  vocab: ReviewItem[]
  phrases: ReviewItem[]
  tables: ConjugationTable[]
}

/**
 * The `tutor.review` reply. `ready: false` means the material is still being
 * generated — the only correct response is to ask again, not to show an error.
 *
 * `version` is the snapshot this material belongs to, matching
 * `tutor.review_version` at the moment the worker generated it. From phase 7
 * step 3 the material is NOT generated once and then frozen: the worker
 * regenerates it from the transcript at a hold when there is enough new
 * material, and bumps the attribute. The version is what lets the tab tell a
 * re-fetch that changed nothing from one that brought a new snapshot — and it
 * is optional because a worker that predates it still answers these calls, and
 * a tab that cannot see a version falls back to the slow poll below.
 */
export type ReviewResponse =
  | ({ ready: true; version?: number } & ReviewMaterial)
  | { ready: false; version?: number }

/** Gap between review polls while the worker says the material is not ready. */
export const REVIEW_POLL_MS = 1500

/**
 * The fallback cadence, once the fast poll above has given up or the worker
 * answered without a version. Review arrives by PUSH now — the worker bumps
 * `tutor.review_version` and the tab re-fetches — so this exists only for the
 * two cases where the push cannot be trusted: material that has never arrived,
 * and a worker whose reply carries no version at all. Slow on purpose: it is a
 * safety net, not a mechanism.
 */
export const REVIEW_FALLBACK_POLL_MS = 30_000

/**
 * How long the Review tab wears its "Updated" marker after new material has
 * replaced what was on screen. Long enough to be noticed by someone reading,
 * short enough that it is not a badge.
 */
export const REVIEW_UPDATED_MS = 6000

/**
 * How many times to ask before giving up. At ~1.5s a poll this is half a
 * minute — well past any honest generation, and the failure it describes ("not
 * available") is quiet rather than retryable.
 */
export const REVIEW_MAX_POLLS = 20

/**
 * How long a single review poll waits. Comfortably past the worker's ~3s
 * first-material latency, and bounded so an unresponsive worker costs
 * `REVIEW_MAX_POLLS` of this rather than the SDK default multiplied by it.
 */
export const REVIEW_TIMEOUT_MS = 5000

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
  /**
   * The study tab that was open when the hold released. Optional because a
   * worker that predates the study surface must still parse these payloads —
   * and because a hold with no overlay (the pause button, a correction) has no
   * tab to report.
   */
  tab?: ResumeTab | null
  /**
   * The questions asked during THIS hold, oldest first, capped at
   * `MAX_RESUME_ASKS`. The answers never travel: what returns to the voice
   * model is a brief, never the Ask transcript (vision doc, 2026-08-20 #4).
   */
  asks?: string[]
}

/** The study tabs, as the worker reads them. Mirrors `StudyTab` in contract.ts. */
export type ResumeTab = "transcript" | "review" | "ask"

/** How many of a hold's questions ride back on the resume payload. */
export const MAX_RESUME_ASKS = 5

/** Participant attribute keys, all published by the agent. `paused` is mirrored
 * so pause state survives reconnects; `analyzer` tells the surface whether
 * corrections are coming at all, so a learner turn need not wait on an analyzer
 * that isn't running; the clock attributes are the meter, which the worker owns
 * outright — the surface renders these and never computes them. */
export const PARTICIPANT_ATTRIBUTES = {
  paused: "tutor.paused",
  analyzer: "tutor.analyzer",
  /**
   * Integer string: seconds of ACTIVE talking so far, holds excluded. Published
   * every 5s while unheld and on every pause, resume, nudge and zero. This is
   * the stopwatch the learner watches — see `session-clock.tsx`.
   */
  elapsedSeconds: "tutor.elapsed_s",
  /**
   * Integer string: seconds of balance left, published alongside `elapsed_s`.
   * The surface only shows it in the last 30 seconds, which is the one moment a
   * countdown is honest rather than a container to fill.
   */
  remainingSeconds: "tutor.remaining_s",
  /** `"true"` while the session is HELD at a zero balance. Not an ending: the
   * conversation waits, and more minutes resume it where it stopped. */
  outOfMinutes: "tutor.out_of_minutes",
  /** `"true"` once the clock — not the learner — ended the session. */
  sessionOver: "tutor.session_over",
  /**
   * Integer string, bumped once per COMMITTED learner turn. The worker's turn
   * detector is the only thing that knows where a learner's turn ends — the STT
   * emits a segment per VAD-bounded phrase — so this is what closes the
   * learner's bubble on stage (see `openSegment` in `reducer.ts`).
   */
  turnSeq: "tutor.turn_seq",
  /**
   * The one thing the worker can say when the conversation cannot happen. Two
   * values, and they are different facts (see `TUTOR_ERROR_*` below); absent
   * whenever the session is merely fine.
   */
  error: "tutor.error",
  /** The confirmed goal, one line. See `ATTR_GOAL`. */
  goal: "tutor.goal",
  /** The Review snapshot counter. See `ATTR_REVIEW_VERSION`. */
  reviewVersion: "tutor.review_version",
} as const

/**
 * The session's confirmed goal, as one line of text — empty until the tutor and
 * the learner have agreed one (phase 7 step 3: the conversation starts with
 * goal setting). Published as an attribute rather than sent as an event because
 * it is a fact about the session that a tab joining late must also see, and
 * because it changes at most once.
 *
 * Named separately from the map above for the same reason as `ATTR_ERROR`: the
 * producer reads it directly, and the surfaces that render it should not have
 * to know which bag the key lives in.
 */
export const ATTR_GOAL = "tutor.goal"

/**
 * Integer string, `"0"` at the start of a session and incremented every time
 * the worker has a NEW Review snapshot. This is what makes Review a push:
 * the tab watches this attribute and re-fetches `tutor.review` when it moves,
 * instead of polling a material that used to be generated once and then never
 * changed. A worker that never bumps it is indistinguishable from the old one,
 * and the slow fallback poll covers that case.
 */
export const ATTR_REVIEW_VERSION = "tutor.review_version"

/**
 * `tutor.error`, spelled out. Named separately from the map above because both
 * halves of the surface read it directly: the live producer to decide whether
 * this session has a future, and the failed card to decide what to say.
 */
export const ATTR_ERROR = "tutor.error"

/**
 * The realtime model died and could not be brought back. The worker holds,
 * debits what was actually spoken, and ends the session through the ordinary
 * `session_over` path — so the learner gets their summary, with a line saying
 * it ended on its own. Time already talked IS billed: it happened.
 */
export const TUTOR_ERROR_MODEL = "model"

/**
 * The tutor joined and never produced a single audio frame inside
 * `TUTOR_SILENT_TIMEOUT_MS`. Nothing is billed — the meter starts at the first
 * tutor audio — so this is a failed start, not a short session.
 */
export const TUTOR_ERROR_SILENT = "tutor_silent"

/**
 * How long the surface waits for the tutor to JOIN before calling the session
 * failed. Generous next to a healthy dispatch (a second or two) and short
 * enough that a learner never sits in front of a silent stage wondering
 * whether they are supposed to speak first. Audit B6.
 */
export const AGENT_JOIN_TIMEOUT_MS = 12_000

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
 * The dispatch metadata the token route signs into the room config, as the
 * Python worker parses it. Snake_cased for the same reason as `ResumePayload`:
 * this is wire JSON, not a frontend type.
 *
 * There is no `max_minutes`: a session is not a container with a length, it is
 * a conversation that runs while the balance lasts (plans/product-vision.md,
 * 2026-08-24 #1). `balance_s` is what the learner had when the room was minted
 * — a starting budget, not a limit; the worker re-reads the balance from Convex
 * when a session held at zero is continued.
 */
export interface SessionDispatchMetadata {
  /** The learner's Clerk id. Signed, so the worker can bill it. */
  user_id: string
  /** Balance in seconds at the moment the token was minted. */
  balance_s: number
  plan: {
    topic: string | null
    scenario: string | null
    tenses: string[]
    /** Free text beside the forms — the thing they asked to be pushed on. */
    focus_note: string | null
    /** Free text beside the level — anything else the tutor should know. */
    note: string | null
    vocab: string[]
    level: string | null
  }
}
