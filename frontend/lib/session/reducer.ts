/**
 * Producer-agnostic session state.
 *
 * Folds `SessionEvent`s (from the mock replay engine or the live LiveKit
 * adapter) into everything the conversation surface renders: the hero
 * utterance, the turn it is answering, the history behind it, the hold set,
 * and agent state. Nothing here knows about replay timing, LiveKit, or React —
 * a producer just pushes events at it.
 *
 * The stage model is RELEVANCE, NOT RECENCY (see plans/product-vision.md): the
 * hero is the segment currently in flight, the pinned context is the previous
 * turn, and everything older is history behind an escape hatch. That falls out
 * of one rule — a delta for a new segment id retires the current one into
 * `turns`.
 */

import type {
  AgentState,
  LanguageRole,
  PauseReason,
  SessionEvent,
  Turn,
} from "./contract"

/**
 * Lifecycle of the hero segment. `analyzing` is the gap between the learner
 * finishing an utterance and the analyzer answering — corrections must not
 * pop in before the whole utterance is on screen.
 */
export type TurnPhase = "live" | "analyzing" | "settled"

export interface SessionState {
  /** Retired turns, oldest first. The most recent is the pinned context. */
  turns: Turn[]
  /** The utterance in flight (or the last one, until the next begins). */
  current: Turn | null
  phase: TurnPhase
  /** Every reason the session is currently held; empty means running. */
  holds: PauseReason[]
  agentState: AgentState
}

export const INITIAL_SESSION_STATE: SessionState = {
  turns: [],
  current: null,
  phase: "live",
  holds: [],
  agentState: "idle",
}

/**
 * The tokenization both sides of the contract agree on: producers chunk text
 * on it, the UI diffs successive cumulative deltas with it to decide which
 * words are newly arrived.
 */
export function wordsOf(text: string): string[] {
  return text.split(/\s+/).filter(Boolean)
}

/**
 * Apply a patch to whichever turn owns `segmentId` — the hero, or a turn that
 * has already retired. Late arrivals are normal: a translation line or a
 * correction can land after the next utterance has begun.
 */
function patchSegment(
  state: SessionState,
  segmentId: string,
  patch: (turn: Turn) => Turn
): SessionState {
  if (state.current?.id === segmentId) {
    return { ...state, current: patch(state.current) }
  }
  const index = state.turns.findIndex((t) => t.id === segmentId)
  if (index < 0) return state
  const turns = [...state.turns]
  turns[index] = patch(turns[index]!)
  return { ...state, turns }
}

function withText(turn: Turn, language: LanguageRole, text: string): Turn {
  return language === "target"
    ? { ...turn, target: text }
    : { ...turn, anchor: text }
}

export function sessionReducer(
  state: SessionState,
  event: SessionEvent
): SessionState {
  switch (event.type) {
    case "transcript.delta": {
      const known =
        state.current?.id === event.segmentId ||
        state.turns.some((t) => t.id === event.segmentId)
      if (known) {
        return patchSegment(state, event.segmentId, (t) =>
          withText(t, event.language, event.text)
        )
      }
      // A delta for an unknown segment opens it, and whatever is on stage
      // retires into history — this is the only "turn advanced" signal the
      // live pipeline gives us.
      const opened: Turn = withText(
        { id: event.segmentId, speaker: event.speaker, target: "", anchor: "" },
        event.language,
        event.text
      )
      return {
        ...state,
        turns: state.current ? [...state.turns, state.current] : state.turns,
        current: opened,
        phase: "live",
      }
    }

    case "transcript.final": {
      const next = patchSegment(state, event.segmentId, (t) =>
        withText(t, event.language, event.text)
      )
      // Only the target-language stream closes a turn; the anchor translation
      // finishing later is just more text.
      if (event.language !== "target" || next.current?.id !== event.segmentId) {
        return next
      }
      return { ...next, phase: event.analysisPending ? "analyzing" : "settled" }
    }

    case "analysis.complete": {
      // A timeout settles the turn exactly like an answer does, but records
      // itself: "no corrections because none were found" and "no corrections
      // because none arrived" must stay distinguishable downstream.
      const next = patchSegment(state, event.segmentId, (t) => ({
        ...t,
        corrections: event.corrections,
        analysisStatus: event.status ?? "complete",
      }))
      return next.current?.id === event.segmentId && next.phase === "analyzing"
        ? { ...next, phase: "settled" }
        : next
    }

    case "agent.state":
      return { ...state, agentState: event.state }

    case "session.paused":
      return state.holds.includes(event.reason)
        ? state
        : { ...state, holds: [...state.holds, event.reason] }

    case "session.resumed":
      return {
        ...state,
        holds: state.holds.filter((r) => r !== event.reason),
      }

    case "session.reset":
      // Holds survive a reset: a learner reading a correction is still reading.
      return { ...INITIAL_SESSION_STATE, holds: state.holds }
  }
}

/* -------------------------------------------------------------------------- */
/*  Selectors                                                                 */
/* -------------------------------------------------------------------------- */

/** The utterance on stage. */
export function heroTurn(state: SessionState): Turn | null {
  return state.current
}

/** The one turn the hero is answering — pinned above it, nothing older. */
export function pinnedTurn(state: SessionState): Turn | undefined {
  return state.turns[state.turns.length - 1]
}

/** Everything behind the stage, for the history escape hatch. */
export function historyTurns(state: SessionState): Turn[] {
  return state.turns
}

export function isHeld(state: SessionState): boolean {
  return state.holds.length > 0
}

/** Corrections only become visible once the analyzer has answered. */
export function marksActive(state: SessionState): boolean {
  return state.phase === "settled" && state.current?.speaker === "learner"
}
