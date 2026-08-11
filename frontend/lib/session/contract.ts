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
 *    transcription stream; the analyzer echoes it on its corrections and the
 *    translation side-task echoes it on its lines. One segment = one utterance
 *    = one `Turn` on screen.
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
 * A settled or in-flight utterance. `id` is the segment id, so a turn can be
 * joined against late-arriving corrections or translation lines.
 */
export interface Turn {
  id: string
  speaker: Speaker
  /** Target-language text (what was actually said). Cumulative while live. */
  target: string
  /** Anchor-language translation. Lags the target during live speech. */
  anchor: string
  corrections?: Correction[]
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
 * control button is sticky; a correction popover and a history peek release
 * themselves), so holds are a set, not a boolean. This set is client-side
 * state: the live adapter collapses "any hold" into a single pause RPC and
 * "no holds left" into a resume.
 */
export type PauseReason = "control" | "correction" | "history"

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
  /** BCP-47 tag when the producer knows it ("es", "en"); informational only. */
  languageCode?: string
}

/** A cumulative transcript snapshot for a segment in one language. */
export interface TranscriptDeltaEvent extends TranscriptEventBase {
  type: "transcript.delta"
}

/**
 * The segment is closed in this language: `text` is final. The *target*-
 * language final is what drives the turn lifecycle — the anchor stream
 * finishing later only updates translation text.
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

/** Corrections for a settled segment, from the semantic analyzer. */
export interface AnalysisCompleteEvent {
  type: "analysis.complete"
  segmentId: string
  corrections: Correction[]
}

/** Agent lifecycle, mirroring LiveKit's `useAgent()` state. */
export interface AgentStateEvent {
  type: "agent.state"
  state: AgentState
}

export interface SessionPausedEvent {
  type: "session.paused"
  reason: PauseReason
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

/** Anything that can drive the reducer: producers hand events to one of these. */
export type SessionEventSink = (event: SessionEvent) => void
