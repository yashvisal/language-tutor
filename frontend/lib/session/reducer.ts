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
 * of one rule — a delta for a new segment id retires the current turn into
 * `turns`, unless it is the learner still talking (no tutor segment and no
 * resume since), in which case it joins the turn already on stage.
 */

import type {
  AgentState,
  Correction,
  CorrectionCategory,
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
  /**
   * A real resume has landed since the last segment opened. The learner's
   * segments otherwise join across any pause, but the worker commits the
   * pre-hold text as its own turn to the tutor — so the first words after a
   * resume are a new turn there, and must be a new bubble here.
   */
  resumedSinceSegment: boolean
}

export const INITIAL_SESSION_STATE: SessionState = {
  turns: [],
  current: null,
  phase: "live",
  holds: [],
  agentState: "idle",
  resumedSinceSegment: false,
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
  const targets = segments.map((s) => stripFillers(s.target)).filter(Boolean)
  const anchors = segments.map((s) => s.anchor.trim()).filter(Boolean)
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
  // Same speaker, same conversational turn — append, don't retire.
  //
  // For the LEARNER this holds however long they breathe, and regardless of
  // whether the analyzer already answered: the agent's turn detector merges
  // every VAD-bounded fragment into ONE turn until the tutor replies, so
  // "Yo quiero pagar con" / "Plástico." is one thing said and must be one
  // bubble. Only the tutor starting (which retires this turn below) or a
  // resume ends it — the worker commits held text as a turn of its own, so
  // after a resume the next words are genuinely new on both sides.
  //
  // The TUTOR is the opposite case: its turns are bounded by its own replies,
  // so two consecutive tutor utterances with no learner between them really
  // are two turns. Only an unsettled tutor turn keeps taking segments.
  const continues =
    state.current !== null &&
    state.current.speaker === speaker &&
    (speaker === "learner"
      ? !state.resumedSinceSegment
      : state.phase !== "settled")
  if (state.current && continues) {
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
    return { ...state, current, phase: "live", resumedSinceSegment: false }
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
    resumedSinceSegment: false,
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
      // MERGE, never replace: a coalesced turn receives one event per segment
      // its corrections were attributed to, and the last of those can be the
      // empty settle-the-newest-segment event — replacing would erase every
      // correction the earlier events delivered. A timeout settles exactly
      // like an answer, but records itself — "no corrections found" and "no
      // answer arrived" must stay distinguishable downstream (and a timeout
      // never downgrades a turn that already has a real answer).
      const next = patchOwning(state, event.segmentId, (t) => {
        const merged = [...(t.corrections ?? [])]
        for (const c of event.corrections) {
          if (!merged.some((m) => m.id === c.id)) merged.push(c)
        }
        return {
          ...t,
          corrections: merged,
          analysisStatus:
            t.analysisStatus === "complete"
              ? "complete"
              : (event.status ?? "complete"),
        }
      })
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

    case "session.resumed": {
      // Releasing a reason that isn't held is routine, not an error: the
      // translation overlay releases on unmount whatever closed it, and
      // `holds.forEach(release)` re-releases whatever it just cleared. Return
      // the same state so those no-ops cost no render.
      if (!state.holds.includes(event.reason)) return state
      const holds = state.holds.filter((r) => r !== event.reason)
      // Only the LAST release is a resume — that is what the producer turns
      // into a single resume RPC, and what makes the worker close off the
      // held text as a turn. Dropping one of several holds is still held.
      return {
        ...state,
        holds,
        resumedSinceSegment:
          state.resumedSinceSegment || holds.length === 0,
      }
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

/**
 * The whole conversation, the turn on stage included — what the study surface's
 * Transcript tab reads.
 *
 * Deliberately wider than `historyTurns`: the stage's escape hatch showed what
 * was BEHIND the stage, but a study surface is the document, and the moment a
 * learner most often pauses to study is the one they just lived. It is also
 * what makes an Ask anchor always resolvable — a question is stamped to the
 * hero, which `historyTurns` by definition does not contain.
 */
export function transcriptTurns(state: SessionState): Turn[] {
  return state.current ? [...state.turns, state.current] : state.turns
}

export function isHeld(state: SessionState): boolean {
  return state.holds.length > 0
}

/** Corrections only become visible once the analyzer has answered. */
export function marksActive(state: SessionState): boolean {
  return state.phase === "settled" && state.current?.speaker === "learner"
}

/**
 * Every correction the analyzer produced this session, oldest turn first.
 *
 * The session state IS the record — corrections ride on the turns they belong
 * to and retired turns keep them — so the post-session summary needs no second
 * store. Deduped by id because a coalesced turn can receive the same correction
 * attributed to more than one of its segments.
 */
export function sessionCorrections(state: SessionState): Correction[] {
  const all: Correction[] = []
  const seen = new Set<string>()
  for (const turn of transcriptTurns(state)) {
    if (turn.speaker !== "learner") continue
    for (const correction of turn.corrections ?? []) {
      if (seen.has(correction.id)) continue
      seen.add(correction.id)
      all.push(correction)
    }
  }
  return all
}

/**
 * Corrections grouped by category, for the summary. Category is the axis the
 * product has always treated as meaningful (see the vision doc's correction
 * schema) — "three tense slips" is a pattern a learner can act on, where a flat
 * list is just a scorecard. Empty categories are dropped.
 */
export function groupCorrections(
  corrections: Correction[]
): Array<{ category: CorrectionCategory; corrections: Correction[] }> {
  const groups = new Map<CorrectionCategory, Correction[]>()
  for (const correction of corrections) {
    const list = groups.get(correction.category) ?? []
    list.push(correction)
    groups.set(correction.category, list)
  }
  return [...groups].map(([category, list]) => ({
    category,
    corrections: list,
  }))
}
