/**
 * The canonical frontend session contract.
 *
 * Everything the conversation surface knows arrives as a `SessionEvent`. Two
 * producers emit them: the scripted mock replay engine (`mock-producer.ts`) and
 * the live LiveKit adapter. The reducer in `reducer.ts` consumes only this
 * union, so the design playground and the real session render from identical
 * state.
 *
 * Two rules the shapes here encode, both dictated by the live pipeline:
 *
 * 1. SEGMENT IDS ARE THE JOIN KEY. LiveKit stamps `lk.segment_id` on every
 *    transcription stream and the analyzer's corrections are attributed back to
 *    it. One segment = one utterance = one `Turn` on screen.
 * 2. TRANSCRIPT DELTAS ARE CUMULATIVE. STT interims are throttled snapshots
 *    ("here is the transcript so far", roughly every 500ms), not word events.
 *    A delta therefore *replaces* the segment's text rather than appending to
 *    it, and any word-arrival animation is the UI's job — it diffs successive
 *    snapshots. Producers must never send a fragment.
 *
 * Nothing here is Spanish-specific: text carries a `LanguageRole` of "target"
 * (the language being learned) or "anchor" (the language being learned from).
 */

import type { AgentState } from "@livekit/components-react"

import type {
  AskMessage,
  ConjugationTable,
  ReviewItem,
  ReviewMaterial,
} from "./protocol"

export type { AgentState }

/**
 * The wire's study shapes are the frontend's too — `target`/`anchor`/`verb`/
 * `rows` read identically on both sides, so re-exporting beats maintaining a
 * parallel set of interfaces that would only ever be copies.
 */
export type { AskMessage, ConjugationTable, ReviewItem, ReviewMaterial }

/* -------------------------------------------------------------------------- */
/*  Domain types                                                              */
/* -------------------------------------------------------------------------- */

export type Speaker = "learner" | "tutor"

/** Target = the language being practiced; anchor = the language explained in. */
export type LanguageRole = "target" | "anchor"

export type CorrectionCategory =
  "tense" | "agreement" | "word-order" | "vocabulary" | "naturalness"

export type CorrectionSeverity = "error" | "unnatural" | "suggestion"

export interface Correction {
  id: string
  /** Exact substring of the segment's target-language text it applies to. */
  original: string
  replacement: string
  category: CorrectionCategory
  severity: CorrectionSeverity
  /** One-line explanation in the anchor language, for instant reveal. */
  explanation: string
}

/**
 * One STT segment inside a turn. Live STT emits a segment per VAD-bounded
 * phrase, so a hesitant speaker produces several per conversational turn; the
 * reducer coalesces them (see reducer.ts) and renders the joined text.
 */
export interface TurnSegment {
  id: string
  target: string
  anchor: string
}

/**
 * A settled or in-flight conversational turn. `id` is the FIRST segment's id;
 * late-arriving corrections join against any segment the turn owns.
 */
export interface Turn {
  id: string
  speaker: Speaker
  /** Joined target-language text (what was actually said). Cumulative while live. */
  target: string
  /**
   * Joined anchor-language text. Nothing populates this since live translation
   * was removed (translation is select-to-translate and lives in overlay
   * state); the field stays because the contract's door to a future ambient
   * mode costs nothing to hold open.
   */
  anchor: string
  /** The STT segments this turn coalesces. Absent for mock/single-segment turns. */
  segments?: TurnSegment[]
  corrections?: Correction[]
  /**
   * How the analyzer resolved for this turn. Absent means it never ran (a tutor
   * turn, or an analyzer that is switched off); "timeout" means the corrections
   * never arrived, so an empty `corrections` proves nothing.
   */
  analysisStatus?: AnalysisStatus
}

/** Category → human label, for legends and popovers. */
export const CATEGORY_LABELS: Record<CorrectionCategory, string> = {
  tense: "Tense",
  agreement: "Agreement",
  "word-order": "Word order",
  vocabulary: "Vocabulary",
  naturalness: "More natural",
}

/**
 * The session's declared intent, chosen (or accepted from a suggestion) before
 * the room exists. It is the one thing the learner configures, and it has three
 * consumers: the tutor prompt, the analyzer's focus weighting, and — from phase
 * 5 — the Review tab.
 *
 * Every field is language-neutral: `tenses` holds values from the per-language
 * catalog in `plan.ts` (keyed by the target language), not Spanish-specific
 * enums, and `topic`/`vocab` are free text. `null`/empty means "no preference",
 * which is a real answer — free conversation with no focus is a plan.
 *
 * Mirrors `SessionDispatchMetadata["plan"]` in `protocol.ts` one-for-one; that
 * is the wire shape, this is the frontend's.
 */
export interface SessionPlan {
  /** A curated situation to play out, prompt-ready ("ordering at a restaurant"). */
  scenario: string | null
  /** Free text, when the learner wants a subject rather than a situation. */
  topic: string | null
  /** Forms to steer toward, as catalog values for the target language. */
  tenses: string[]
  /**
   * Free text beside the forms: the specific thing the learner wants pushed on
   * ("when to use he comido vs comí"). A form catalog is a menu; this is the
   * question they actually came in with, so it reaches the tutor verbatim.
   */
  focusNote: string | null
  /** Anything else the tutor should know, free text, beside the level. */
  note: string | null
  /**
   * Free-text vocabulary themes. No longer asked for in the UI (the pre-flight
   * is three questions, and a themes input was a fourth), but kept on the
   * contract because the worker's Review material still reads it and a future
   * surface may fill it again. The UI always sends `[]`.
   */
  vocab: string[]
  /** Self-declared, one tap. No assessment — see phase 4, workstream 4. */
  level: string | null
}

/**
 * A finished session, snapshotted at the moment it ended — the whole input to
 * the post-session summary.
 *
 * Snapshotted rather than derived, because the session state is cleared when
 * the room goes away and the corrections the learner earned must outlive it.
 * `secondsTalked` is the meter's final reading — the seconds of ACTIVE talking,
 * holds excluded, which is exactly what the ledger was charged. Null when the
 * worker never published a clock (a session that ended before the first
 * attribute, or a worker without one): the surface says nothing rather than
 * guessing, since the worker owns the meter.
 */
export interface SessionOutcome {
  plan: SessionPlan
  secondsTalked: number | null
  /** True when the clock ended it, false when the learner hung up. */
  endedByClock: boolean
  /** Every correction the analyzer produced this session, in the order seen. */
  corrections: Correction[]
  /**
   * The session ended without the learner asking it to — the agent left, the
   * room closed, the network gave up. CLIENT-ONLY: `sessionOutcomeValidator`
   * has no such field and `sessions.finish` is never sent it, because the
   * stored record is what was said and this is a fact about how the tab's
   * connection died. It changes one line of copy on the summary and nothing
   * else. Audit B5.
   */
  endedUnexpectedly: boolean
  /**
   * The room this conversation happened in, frozen at the moment of ending —
   * `room.name` is empty again by the time the summary renders. Also
   * client-only, and the key the summary reads `sessions.byRoom` with, which
   * is how the worker's `about`, Review and transcript reach the screen the
   * learner is already looking at. Null when the session never connected.
   */
  room: string | null
}

/**
 * Why the session is being held. Multiple sources can hold it at once (a
 * correction popover and a translation overlay release themselves; the study
 * surface is released by resuming), so holds are a set, not a boolean. This set
 * is client-side state: the live adapter collapses "any hold" into a single
 * pause RPC and "no holds left" into a resume.
 *
 * `"history"` is every deliberate stop — the hold button and Space as much as
 * the transcript button — because all of them land on the study surface, and
 * the worker is told which tab a hold ended on only for holds that had one.
 * `"control"` is left for the sticky hold with no surface behind it: the one
 * the live producer adopts from an agent that reconnects already paused.
 */
export type PauseReason = "control" | "correction" | "history" | "translation"

/**
 * Translate one selected span of settled text into the anchor language — the
 * whole of select-to-translate's contract with its producer. It is a plain
 * request/response call rather than an event because the answer belongs to the
 * overlay that asked, not to the session state: nothing on the stage changes.
 * Rejects on timeout, transport failure, or a worker-side error.
 */
export type TranslateFn = (
  text: string,
  speaker: Speaker,
  turnId?: string
) => Promise<string>

/* -------------------------------------------------------------------------- */
/*  The study surface                                                         */
/* -------------------------------------------------------------------------- */

/** The pause overlay's three faces. See plans/product-vision.md, 2026-08-20 #4. */
export type StudyTab = "transcript" | "review" | "ask"

/**
 * One question and its answer.
 *
 * ANCHORED, not floating: `turnId` is the turn that was on stage when the
 * learner asked, which is what lets the Transcript tab mark the moment the
 * question belongs to. Null only when the stage was empty.
 *
 * `answer === null` is the pending state; `failed` is a transport failure, and
 * is a different fact from `limit` — the worker's invisible cap still produces
 * a real answer (a redirect back to speaking) that renders like any other.
 */
export interface AskExchange {
  id: string
  question: string
  answer: string | null
  turnId: string | null
  limit?: boolean
  failed?: boolean
}

/**
 * The study surface's back end, session-scoped and owned by the producer.
 *
 * The thread lives here rather than in the overlay because the overlay unmounts
 * every time the learner resumes, and a question asked two pauses ago is still
 * part of this session's study. It is deliberately NOT persisted: a new session
 * starts with an empty thread.
 */
export interface StudySession {
  /** The Ask thread, oldest first. */
  thread: AskExchange[]
  /** Asks a question and files it under the turn on stage. Never rejects. */
  ask: (question: string, turnId: string | null) => void
  /**
   * This session's review material, awaited by the Review tab. Polls while the
   * worker is still generating and resolves null when it never arrives —
   * "not available" is a quiet line, not an error.
   */
  fetchReview: () => Promise<ReviewMaterial | null>
  /** The tab the learner last had open. Remembered for the session. */
  tab: StudyTab
  setTab: (tab: StudyTab) => void
}

/* -------------------------------------------------------------------------- */
/*  Events                                                                    */
/* -------------------------------------------------------------------------- */

interface TranscriptEventBase {
  /** LiveKit `lk.segment_id`. Identifies the utterance across every stream. */
  segmentId: string
  speaker: Speaker
  language: LanguageRole
  /** The full transcript of this segment so far — NOT a fragment. */
  text: string
}

/** A cumulative transcript snapshot for a segment in one language. */
export interface TranscriptDeltaEvent extends TranscriptEventBase {
  type: "transcript.delta"
}

/**
 * The segment is closed in this language: `text` is final. Only the *target*-
 * language final drives the turn lifecycle; the anchor role survives on these
 * events for a future producer that has anchor text to send.
 */
export interface TranscriptFinalEvent extends TranscriptEventBase {
  type: "transcript.final"
  /**
   * An `analysis.complete` is expected for this segment, so the surface should
   * wait before treating the turn as settled. True for learner turns that the
   * analyzer will pick up.
   */
  analysisPending?: boolean
}

/**
 * The analyzer has stopped being pending for a segment: either it answered, or
 * the producer gave up waiting. Both settle the turn, but they are NOT the same
 * fact — `status: "timeout"` with no corrections must never be read as "no
 * mistakes", so it is recorded on the turn for the UI to distinguish later.
 */
export interface AnalysisCompleteEvent {
  type: "analysis.complete"
  segmentId: string
  corrections: Correction[]
  /** Defaults to "complete"; only the live producer's timeout sends "timeout". */
  status?: AnalysisStatus
}

export type AnalysisStatus = "complete" | "timeout"

/**
 * The learner's conversational turn is CLOSED — the worker's turn detector
 * committed it, merging however many VAD-bounded STT segments it spanned.
 *
 * There is no transcript event for this: a segment final closes a phrase, not a
 * turn, and a hesitant learner produces several per turn. Only the worker knows
 * the boundary, so it publishes it (`tutor.turn_seq`) and the producer turns
 * each rise into one of these. The reducer needs no payload — it closes
 * whatever learner turn is on stage, so the next segment opens a fresh bubble.
 */
export interface LearnerTurnCommittedEvent {
  type: "learner.turn_committed"
}

/** Agent lifecycle, mirroring LiveKit's `useAgent()` state. */
export interface AgentStateEvent {
  type: "agent.state"
  state: AgentState
}

export interface SessionPausedEvent {
  type: "session.paused"
  reason: PauseReason
  /**
   * The correction the learner just opened, on a `"correction"` hold. The
   * reducer ignores it — it exists so the live producer can name the thing that
   * was being studied in its resume payload, without the UI having to know the
   * pause pipeline exists.
   */
  correction?: Correction
}

export interface SessionResumedEvent {
  type: "session.resumed"
  reason: PauseReason
}

/**
 * Clear the conversation and start over — a fresh room, or the mock looping
 * back to the top of its script.
 */
export interface SessionResetEvent {
  type: "session.reset"
}

export type SessionEvent =
  | TranscriptDeltaEvent
  | TranscriptFinalEvent
  | AnalysisCompleteEvent
  | LearnerTurnCommittedEvent
  | AgentStateEvent
  | SessionPausedEvent
  | SessionResumedEvent
  | SessionResetEvent
