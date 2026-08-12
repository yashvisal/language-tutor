"use client"

/**
 * The mock producer: a scripted conversation replayed as contract events.
 *
 * This is the design playground's half of the contract (the live LiveKit
 * adapter is the other), and it stays permanently useful — deterministic
 * states are far faster to iterate UI against than real voice. It emits the
 * same `SessionEvent`s the live pipeline will, at timings tuned to feel like
 * real speech:
 *
 * - Transcript deltas are CUMULATIVE, one word wider each beat. Real STT
 *   interims arrive as ~500ms snapshots rather than word events, so the
 *   contract carries snapshots and the UI diffs them; the mock chunks by word
 *   to drive the ticker at a speech-like cadence.
 * - No anchor-language stream. Live translation is gone (translation is
 *   select-to-translate), so replaying a lagging English column would be
 *   replaying a surface that no longer exists. The script's English text stays
 *   in `mock-conversation.ts` for whatever wants it next.
 * - Nothing is scheduled while the session is held, so the ticker freezes on
 *   whatever word it reached and resumes from exactly there.
 *
 * The engine is a pure function of session state (`nextMockBeat`) plus a thin
 * React driver (`useMockSession`), so any page can host it.
 */

import { useEffect, useReducer } from "react"

import { CONVERSATION, INTERIM } from "@/lib/design/mock-conversation"
import type { SessionEvent, Turn } from "./contract"
import {
  INITIAL_SESSION_STATE,
  sessionReducer,
  wordsOf,
  type SessionState,
} from "./reducer"

/* -------------------------------------------------------------------------- */
/*  Script                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * The trailing utterance the script ends on: a learner turn still in flight,
 * so the surface can be seen mid-thought. It never reaches the analyzer, and
 * the UI marks it as unfinished by id.
 */
export const MOCK_INTERIM_SEGMENT_ID = "interim"

interface ScriptEntry extends Turn {
  /** The analyzer only runs on completed learner utterances. */
  analysisPending: boolean
  /** How long the settled turn holds the stage before the next one opens. */
  dwell: number
}

const MOCK_SCRIPT: ScriptEntry[] = [
  ...CONVERSATION.map((turn) => ({
    id: turn.id,
    speaker: turn.speaker,
    target: turn.es,
    anchor: turn.en,
    corrections: turn.corrections,
    analysisPending: turn.speaker === "learner",
    dwell: turn.corrections?.length ? 2800 : 1500,
  })),
  {
    id: MOCK_INTERIM_SEGMENT_ID,
    speaker: INTERIM.speaker,
    target: INTERIM.esWords.join(" "),
    anchor: INTERIM.enPartial,
    analysisPending: false,
    // Longest dwell in the script: this is the frame worth looking at.
    dwell: 4200,
  },
]

/** Per-word cadence, by speaker. The tutor reads a little faster. */
const WORD_MS: Record<Turn["speaker"], number> = { learner: 250, tutor: 190 }
/** Beat between the last word and the turn closing. */
const FINAL_MS = 280
/** How long the analyzer "thinks" before corrections land. */
const ANALYSIS_MS = 900

/* -------------------------------------------------------------------------- */
/*  Replay engine                                                             */
/* -------------------------------------------------------------------------- */

export interface MockBeat {
  delay: number
  /** Dispatched together, so the surface never sees a half-applied beat. */
  events: SessionEvent[]
}

function agentStateFor(entry: ScriptEntry): SessionEvent {
  return {
    type: "agent.state",
    state: entry.speaker === "tutor" ? "speaking" : "listening",
  }
}

function transcript(entry: ScriptEntry, wordCount: number): SessionEvent[] {
  return [
    {
      type: "transcript.delta",
      segmentId: entry.id,
      speaker: entry.speaker,
      language: "target",
      text: wordsOf(entry.target).slice(0, wordCount).join(" "),
    },
  ]
}

/**
 * The next beat of the replay, derived entirely from session state: the script
 * cursor is however many turns have retired, and progress within a turn is the
 * length of the hero's transcript. Holds are the caller's business — a held
 * session simply never asks for the next beat.
 */
export function nextMockBeat(state: SessionState): MockBeat {
  const cursor = state.turns.length
  const entry = MOCK_SCRIPT[cursor]!
  const total = wordsOf(entry.target).length
  const emitted = state.current ? wordsOf(state.current.target).length : 0

  if (state.phase === "live" && emitted < total) {
    return {
      delay: WORD_MS[entry.speaker],
      events: transcript(entry, emitted + 1),
    }
  }

  if (state.phase === "live") {
    return {
      delay: FINAL_MS,
      events: [
        {
          type: "transcript.final",
          segmentId: entry.id,
          speaker: entry.speaker,
          language: "target",
          text: entry.target,
          analysisPending: entry.analysisPending,
        },
        {
          type: "agent.state",
          state: entry.analysisPending ? "thinking" : "listening",
        },
      ],
    }
  }

  if (state.phase === "analyzing") {
    return {
      delay: ANALYSIS_MS,
      events: [
        {
          type: "analysis.complete",
          segmentId: entry.id,
          corrections: entry.corrections ?? [],
        },
        { type: "agent.state", state: "listening" },
      ],
    }
  }

  // Settled: hold the stage, then hand it over. The next turn opens with an
  // empty transcript — the stage swaps a beat before its first word lands,
  // exactly as a real segment does. Running off the end loops the script.
  const next = MOCK_SCRIPT[cursor + 1]
  return {
    delay: entry.dwell,
    events: next
      ? [...transcript(next, 0), agentStateFor(next)]
      : [{ type: "session.reset" }, ...openingEvents()],
  }
}

/** Opens the script's first segment: an empty hero, aura already in state. */
function openingEvents(): SessionEvent[] {
  const first = MOCK_SCRIPT[0]!
  return [...transcript(first, 0), agentStateFor(first)]
}

/**
 * Seeded so the first frame already shows the opening (empty) hero with the
 * Aura in the right state, rather than snapping into it one beat later.
 */
export const MOCK_INITIAL_STATE: SessionState = openingEvents().reduce(
  sessionReducer,
  INITIAL_SESSION_STATE
)

/* -------------------------------------------------------------------------- */
/*  React driver                                                              */
/* -------------------------------------------------------------------------- */

export interface MockSession {
  state: SessionState
  /** For client-originated events — the hold set, mainly. */
  dispatch: (event: SessionEvent) => void
}

export function useMockSession(): MockSession {
  const [state, dispatch] = useReducer(sessionReducer, MOCK_INITIAL_STATE)

  useEffect(() => {
    if (state.holds.length > 0) return
    const { delay, events } = nextMockBeat(state)
    const id = setTimeout(() => events.forEach(dispatch), delay)
    return () => clearTimeout(id)
  }, [state])

  return { state, dispatch }
}
