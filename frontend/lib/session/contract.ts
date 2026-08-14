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

export type { AgentState }

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
 * Why the session is being held. Multiple sources can hold it at once (the
 * control button is sticky; a correction popover, a translation overlay and a
 * history peek release themselves), so holds are a set, not a boolean. This set
 * is client-side state: the live adapter collapses "any hold" into a single
 * pause RPC and "no holds left" into a resume.
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
  | AgentStateEvent
  | SessionPausedEvent
  | SessionResumedEvent
  | SessionResetEvent
