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
 * SEGMENTS ARE NOT TURNS. The STT emits a segment per VAD-bounded phrase, so a
 * hesitant learner produces several segments per conversational turn ("Ahora," /
 * "Um," / "Yo trabajo en crear…"). Rendering each as its own turn shreds the
 * stage. A turn therefore OWNS a list of segments: consecutive same-speaker
 * segments coalesce into the current turn, and the joined text is what renders.
 * The turn's id is its first segment's id.
 */
function ownsSegment(turn: Turn, segmentId: string): boolean {
  return (
    turn.id === segmentId ||
    (turn.segments?.some((s) => s.id === segmentId) ?? false)
  )
}

/**
 * Filled pauses the STT transcribes verbatim. Stripped from display only —
 * they are speech, not content. Deliberately English-ish hesitations only:
 * Spanish "este"/"eh" are real words and stay.
 */
const FILLER = /(?:^|\s)(?:u+m+|u+h+|m+h?m+|h+m+)[,.]?(?=\s|$)/gi

function stripFillers(text: string): string {
  return text.replace(FILLER, " ").replace(/\s+/g, " ").trim()
}

/**
 * Each STT segment is transcribed as its own sentence, so a coalesced turn
 * reads "…es bien Ahora trabajo Para crear…" — every fragment restarts the
 * sentence case. When the text so far hasn't ended a sentence, a continuation
 * fragment loses its leading capital (unless it looks like an acronym or
 * proper noun can't be told apart — a capital followed by another capital is
 * left alone).
 */
function joinTargetFragments(fragments: string[]): string {
  let out = ""
  for (const fragment of fragments) {
    if (!out) {
      out = fragment
      continue
    }
    let next = fragment
    if (!/[.?!…]$/.test(out) && /^[A-ZÁÉÍÓÚÑÜ][a-záéíóúñü]/.test(next)) {
      next = next[0]!.toLowerCase() + next.slice(1)
    }
    out = `${out} ${next}`
  }
  return out
}

/** Rebuild the rendered texts from the segment list. */
function joined(turn: Turn): Turn {
  const segments = turn.segments ?? []
  const targets = segments
    .map((s) => stripFillers(s.target))
    .filter(Boolean)
  const anchors = segments
    .map((s) => s.anchor.trim())
    .filter(Boolean)
  return {
    ...turn,
    target: joinTargetFragments(targets),
    anchor: anchors.join(" "),
  }
}

/**
 * Apply a patch to whichever turn owns `segmentId` — the hero, or a turn that
 * has already retired. Late arrivals are normal: a translation line or a
 * correction can land after the next utterance has begun.
 */
function patchOwning(
  state: SessionState,
  segmentId: string,
  patch: (turn: Turn) => Turn
): SessionState {
  if (state.current && ownsSegment(state.current, segmentId)) {
    return { ...state, current: patch(state.current) }
  }
  const index = state.turns.findIndex((t) => ownsSegment(t, segmentId))
  if (index < 0) return state
  const turns = [...state.turns]
  turns[index] = patch(turns[index]!)
  return { ...state, turns }
}

/** Set one segment's text in one language, and re-join the turn. */
function withSegmentText(
  turn: Turn,
  segmentId: string,
  language: LanguageRole,
  text: string
): Turn {
  const segments = (
    turn.segments ?? [{ id: turn.id, target: turn.target, anchor: turn.anchor }]
  ).map((s) =>
    s.id === segmentId
      ? language === "target"
        ? { ...s, target: text }
        : { ...s, anchor: text }
      : s
  )
  return joined({ ...turn, segments })
}

/** Coalesce a new segment into the current turn, or open a new turn with it. */
function openSegment(
  state: SessionState,
  segmentId: string,
  speaker: Turn["speaker"],
  targetText: string
): SessionState {
  const segment = { id: segmentId, target: targetText, anchor: "" }
  // Same speaker, still unsettled: this is the same conversational turn
  // continuing after a pause — append, don't retire. A settled turn (the
  // analyzer already answered it) is finished; new speech starts fresh.
  if (
    state.current &&
    state.current.speaker === speaker &&
    state.phase !== "settled"
  ) {
    const current = joined({
      ...state.current,
      segments: [
        ...(state.current.segments ?? [
          {
            id: state.current.id,
            target: state.current.target,
            anchor: state.current.anchor,
          },
        ]),
        segment,
      ],
    })
    return { ...state, current, phase: "live" }
  }
  const opened: Turn = joined({
    id: segmentId,
    speaker,
    target: "",
    anchor: "",
    segments: [segment],
  })
  return {
    ...state,
    turns: state.current ? [...state.turns, state.current] : state.turns,
    current: opened,
    phase: "live",
  }
}

export function sessionReducer(
  state: SessionState,
  event: SessionEvent
): SessionState {
  switch (event.type) {
    case "transcript.delta": {
      const known =
        (state.current && ownsSegment(state.current, event.segmentId)) ||
        state.turns.some((t) => ownsSegment(t, event.segmentId))
      if (known) {
        return patchOwning(state, event.segmentId, (t) =>
          withSegmentText(t, event.segmentId, event.language, event.text)
        )
      }
      // Only the target stream opens/advances turns; an anchor delta for a
      // segment the reducer doesn't know is routing noise, not a turn.
      if (event.language !== "target") return state
      // A delta for an unknown segment either coalesces into the current
      // same-speaker turn or retires it and opens the next — the only "turn
      // advanced" signal the live pipeline gives us.
      const next = openSegment(state, event.segmentId, event.speaker, "")
      return patchOwning(next, event.segmentId, (t) =>
        withSegmentText(t, event.segmentId, event.language, event.text)
      )
    }

    case "transcript.final": {
      const known =
        (state.current && ownsSegment(state.current, event.segmentId)) ||
        state.turns.some((t) => ownsSegment(t, event.segmentId))
      // A final for a segment we never saw a delta for is a whole utterance
      // arriving at once (every interim missed, or a segment published only
      // once finalized). Open it exactly as a delta would. Only the target
      // stream may open a turn — a stray anchor final has no words for one.
      const base: SessionState =
        known || event.language !== "target"
          ? state
          : openSegment(state, event.segmentId, event.speaker, "")

      const next = patchOwning(base, event.segmentId, (t) =>
        withSegmentText(t, event.segmentId, event.language, event.text)
      )
      // Only a target final on the CURRENT turn moves the phase. Mid-turn this
      // fires per segment — the next fragment's delta flips it back to "live",
      // so only the last fragment's analyzing/settled state sticks.
      if (
        event.language !== "target" ||
        !next.current ||
        !ownsSegment(next.current, event.segmentId)
      ) {
        return next
      }
      return { ...next, phase: event.analysisPending ? "analyzing" : "settled" }
    }

    case "analysis.complete": {
      // Corrections apply to the whole turn owning the segment (the analyzer
      // sees full turns, not STT fragments). A timeout settles exactly like an
      // answer, but records itself — "no corrections found" and "no answer
      // arrived" must stay distinguishable downstream.
      const next = patchOwning(state, event.segmentId, (t) => ({
        ...t,
        corrections: event.corrections,
        analysisStatus: event.status ?? "complete",
      }))
      return next.current &&
        ownsSegment(next.current, event.segmentId) &&
        next.phase === "analyzing"
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
