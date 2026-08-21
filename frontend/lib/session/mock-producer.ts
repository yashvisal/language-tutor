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

import { useEffect, useMemo, useReducer } from "react"

import { CONVERSATION, INTERIM } from "@/lib/design/mock-conversation"
import type { SessionEvent, StudySession, TranslateFn, Turn } from "./contract"
import type { AskResponse, ReviewItem, ReviewResponse } from "./protocol"
import {
  INITIAL_SESSION_STATE,
  sessionReducer,
  wordsOf,
  type SessionState,
} from "./reducer"
import { useStudy, type StudyBackend } from "./study"

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
/*  Select-to-translate                                                       */
/* -------------------------------------------------------------------------- */

/** Roughly the round trip the worker's `tutor.translate` budgets for. */
const MOCK_TRANSLATE_MS = 400

/**
 * Replay's answer to a selected span — the mock's half of `TranslateFn`, and it
 * lives here for the same reason the beats do: the script is the only thing
 * that knows what its turns mean. The turn id does the lookup, so any span of a
 * scripted turn comes back as that turn's English; anything else gets an
 * obviously-canned line rather than a plausible-looking lie, because the point
 * of replay is the interaction, not the translation.
 */
export const mockTranslate: TranslateFn = (text, _speaker, turnId) =>
  new Promise((resolve) =>
    setTimeout(() => {
      const scripted = CONVERSATION.find((turn) => turn.id === turnId)
      resolve(
        scripted?.es.includes(text)
          ? scripted.en
          : `“${text}” — replay has no translator.`
      )
    }, MOCK_TRANSLATE_MS)
  )

/* -------------------------------------------------------------------------- */
/*  The study surface                                                         */
/* -------------------------------------------------------------------------- */

/** Roughly what a coaching answer costs on the wire. */
const MOCK_ASK_MS = 500

/**
 * Replay's coach. Canned, and deliberately in the persona the worker owns —
 * push back, make the learner try first, never hand over the sentence — so the
 * design playground shows the shape of an answer rather than an answer. Cycled
 * so a demo of several questions doesn't read as one stuck response.
 */
const MOCK_ANSWERS = [
  "Try it yourself first: you already used the preterite once in this conversation. What would the “yo” form be?",
  "Close. Think about which past you mean — a finished event (pretérito) or a scene you're describing (imperfecto)?",
  "That one's a fixed expression, so don't translate it word by word. Say it out loud once and it'll stick.",
]

export const mockAsk: StudyBackend["ask"] = (_question, _turnId, history) =>
  new Promise<AskResponse>((resolve) =>
    setTimeout(() => {
      const asked = Math.floor(history.length / 2)
      resolve({ answer: MOCK_ANSWERS[asked % MOCK_ANSWERS.length]! })
    }, MOCK_ASK_MS)
  )

/** The focus forms the scripted conversation drills. Stands in for a plan. */
export const MOCK_FOCUS_TENSES = ["preterite"]

/** Vocabulary the scripted conversation actually uses. */
const MOCK_VOCAB: ReviewItem[] = [
  { target: "el supermercado", anchor: "the supermarket" },
  { target: "las fresas", anchor: "strawberries" },
  { target: "la sandía", anchor: "the watermelon" },
  { target: "el batido", anchor: "the smoothie" },
  { target: "la cocina", anchor: "the kitchen" },
]

/**
 * A tiny hardcoded table, standing in for the deterministic conjugation data
 * the worker ships (phase-5 outline: tables are data, never model-generated).
 */
const MOCK_TABLES = [
  {
    verb: "ir",
    tense: "preterite",
    rows: [
      { person: "yo", form: "fui" },
      { person: "tú", form: "fuiste" },
      { person: "él / ella / usted", form: "fue" },
      { person: "nosotros", form: "fuimos" },
      { person: "ellos / ustedes", form: "fueron" },
    ],
  },
  {
    verb: "comprar",
    tense: "preterite",
    rows: [
      { person: "yo", form: "compré" },
      { person: "tú", form: "compraste" },
      { person: "él / ella / usted", form: "compró" },
      { person: "nosotros", form: "compramos" },
      { person: "ellos / ustedes", form: "compraron" },
    ],
  },
]

/** How long replay pretends the worker is still generating the material. */
const MOCK_REVIEW_DELAY_MS = 1200

/** When the material was first asked for; the shimmer is worth showing once. */
let reviewAskedAt: number | null = null

/**
 * Replay's review material: the script's own tutor lines as phrases, the words
 * the conversation turns on as vocabulary, and the shipped tables. The first
 * poll answers "not ready" so the playground exercises the loading state the
 * live surface will actually spend time in.
 */
export const mockReview: StudyBackend["review"] = () => {
  reviewAskedAt ??= Date.now()
  if (Date.now() - reviewAskedAt < MOCK_REVIEW_DELAY_MS) {
    return Promise.resolve<ReviewResponse>({ ready: false })
  }
  return Promise.resolve<ReviewResponse>({
    ready: true,
    vocab: MOCK_VOCAB,
    phrases: CONVERSATION.filter((turn) => turn.speaker === "tutor")
      .slice(0, 4)
      .map((turn) => ({ target: turn.es, anchor: turn.en })),
    tables: MOCK_TABLES,
  })
}

/* -------------------------------------------------------------------------- */
/*  React driver                                                              */
/* -------------------------------------------------------------------------- */

export interface MockSession {
  state: SessionState
  /** For client-originated events — the hold set, mainly. */
  dispatch: (event: SessionEvent) => void
  /** The pause overlay's back end, canned. */
  study: StudySession
}

export function useMockSession(): MockSession {
  const [state, dispatch] = useReducer(sessionReducer, MOCK_INITIAL_STATE)
  const backend = useMemo<StudyBackend>(
    () => ({ ask: mockAsk, review: mockReview }),
    []
  )
  const study = useStudy(backend)

  useEffect(() => {
    if (state.holds.length > 0) return
    const { delay, events } = nextMockBeat(state)
    const id = setTimeout(() => events.forEach(dispatch), delay)
    return () => clearTimeout(id)
  }, [state])

  return { state, dispatch, study }
}
