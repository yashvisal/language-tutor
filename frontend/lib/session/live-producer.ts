"use client"

/**
 * The live producer: a LiveKit room translated into contract events.
 *
 * This is the mock producer's twin. Where `mock-producer.ts` replays a script,
 * this hook subscribes to the room's text streams and the agent's state and
 * pushes exactly the same `SessionEvent`s at `sessionReducer`, so the surface
 * cannot tell them apart.
 *
 * Three wire-level realities shape everything below, and each is handled once,
 * in one place:
 *
 * 1. TRANSCRIPTION IS ALREADY CUMULATIVE AND ALREADY KEYED. The agent publishes
 *    every interim as a fresh text stream carrying the same `lk.segment_id`;
 *    `useTranscriptions()` folds those into one entry per segment whose `text`
 *    is the full transcript so far and whose attributes carry the current
 *    `lk.transcription_final`. That is the contract's delta/final shape
 *    verbatim — no buffering needed here.
 *
 * 2. CORRECTIONS DO NOT CARRY A SEGMENT ID. The analyzer keys its payload by
 *    the agent-side chat message id, which has no relationship to the segment
 *    ids LiveKit mints for transcription. The payload does include the final
 *    utterance text, so we join on that (`matchCorrectionsToSegment`).
 *
 * 3. TRANSLATION DOES NOT CARRY A SEGMENT ID EITHER. The translate side-task
 *    opens one stream per translated item with no `lk.segment_id` at all, and
 *    its chunks are true deltas rather than snapshots. Each stream is bound, on
 *    first sight, to whichever learner segment is live at that moment, and its
 *    accumulated text becomes that segment's anchor language.
 *
 * The hold set stays client-side exactly as in the mock: several UI affordances
 * can hold at once, and only the transitions "first hold added" and "last hold
 * released" reach the agent, as one `tutor.pause` / `tutor.resume` RPC.
 */

import {
  useCallback,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
} from "react"
import { ConnectionState, Track, type Room } from "livekit-client"
import {
  useAgent,
  useSession,
  useTextStream,
  useTranscriptions,
  type TextStreamData,
  type TrackReference,
} from "@livekit/components-react"

import type { Correction, SessionEvent, Speaker } from "./contract"
import {
  ATTRIBUTE_TRUE,
  PARTICIPANT_ATTRIBUTES,
  RPC_METHODS,
  STREAM_ATTRIBUTES,
  TEXT_STREAM_TOPICS,
  tutorSessionOptions,
  tutorTokenSource,
} from "./livekit"
import {
  INITIAL_SESSION_STATE,
  sessionReducer,
  type SessionState,
} from "./reducer"

/**
 * How long a learner turn may sit in `analyzing` before the surface gives up
 * waiting and settles it uncorrected. The analyzer is fire-and-forget on the
 * worker and every failure path there is a dropped correction, so without this
 * a single dropped call would freeze the hero's marks forever.
 */
const ANALYSIS_TIMEOUT_MS = 8000

/* -------------------------------------------------------------------------- */
/*  Corrections join                                                          */
/* -------------------------------------------------------------------------- */

/** What the worker's analyzer publishes on `tutor.corrections`. */
interface CorrectionsPayload {
  type?: string
  turnId?: string
  /** The finalized utterance the corrections were computed against. */
  text?: string
  language?: string
  corrections?: Correction[]
}

/** A finalized learner utterance, remembered so corrections can find it. */
export interface FinalizedUtterance {
  segmentId: string
  text: string
}

/** Case-, accent-of-punctuation- and whitespace-insensitive comparison key. */
function normalize(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, "")
    .replace(/\s+/g, " ")
    .trim()
}

/**
 * Resolve which on-screen segment a corrections payload belongs to.
 *
 * The worker keys corrections by its own turn id (the agent's `ChatMessage.id`)
 * while the UI keys turns by `lk.segment_id`, and the two are minted by
 * different processes — they will never be equal. The payload's `text` is the
 * only shared fact, so it is the join key:
 *
 *   1. exact match against a finalized learner utterance (the normal case: the
 *      analyzer sees the same STT output the UI rendered);
 *   2. else a normalized match, which absorbs punctuation and casing drift
 *      between the realtime model's transcript and the STT plugin's;
 *   3. else the most recently finalized learner utterance, because corrections
 *      arrive within a turn or two of the speech that produced them and a
 *      slightly misplaced mark beats a silently dropped one.
 *
 * Searching newest-first matters: a learner who repeats themselves should see
 * the correction on the utterance they just said.
 */
export function matchCorrectionsToSegment(
  payloadText: string,
  finalized: readonly FinalizedUtterance[]
): string | null {
  if (finalized.length === 0) return null

  for (let i = finalized.length - 1; i >= 0; i--) {
    if (finalized[i]!.text === payloadText) return finalized[i]!.segmentId
  }

  const target = normalize(payloadText)
  if (target) {
    for (let i = finalized.length - 1; i >= 0; i--) {
      if (normalize(finalized[i]!.text) === target)
        return finalized[i]!.segmentId
    }
  }

  return finalized[finalized.length - 1]!.segmentId
}

/* -------------------------------------------------------------------------- */
/*  Hook                                                                      */
/* -------------------------------------------------------------------------- */

export type LiveConnectionState = "idle" | "connecting" | "live"

export interface LiveSession {
  state: SessionState
  /** For client-originated events — the hold set, mainly. */
  dispatch: (event: SessionEvent) => void
  connection: LiveConnectionState
  /** Non-null once a connect attempt has failed; cleared by retrying. */
  error: string | null
  connect: () => void
  disconnect: () => void
  muted: boolean
  toggleMute: () => void
  /** The agent's audio track, for the Aura. Undefined until the tutor joins. */
  agentAudioTrack: TrackReference | undefined
  /** The room, for `RoomAudioRenderer` and anything else that needs it. */
  room: Room
}

export function useLiveSession(): LiveSession {
  const options = useMemo(() => tutorSessionOptions(), [])
  const session = useSession(tutorTokenSource, options)
  const agent = useAgent(session)
  const room = session.room

  const [state, dispatch] = useReducer(sessionReducer, INITIAL_SESSION_STATE)

  const connection: LiveConnectionState =
    session.connectionState === ConnectionState.Disconnected
      ? "idle"
      : session.connectionState === ConnectionState.Connecting
        ? "connecting"
        : "live"

  /* -- connect / disconnect ---------------------------------------------- */

  const [error, setError] = useState<string | null>(null)

  const connect = useCallback(() => {
    setError(null)
    // The microphone is the whole point of the surface: publish on connect
    // rather than making the learner find a button.
    session
      .start({ tracks: { microphone: { enabled: true } } })
      .catch((err: unknown) => {
        setError(err instanceof Error ? err.message : String(err))
      })
  }, [session])

  const disconnect = useCallback(() => {
    void session.end()
  }, [session])

  /* -- microphone --------------------------------------------------------- */

  const [muted, toggleMuteLocal] = useReducer((v: boolean) => !v, false)

  const micPublication = session.isConnected
    ? room.localParticipant.getTrackPublication(Track.Source.Microphone)
    : undefined

  useEffect(() => {
    if (!micPublication) return
    // Mute rather than unpublish: the track stays live so unmuting is instant
    // and the agent never sees a track churn mid-conversation.
    void (muted ? micPublication.mute() : micPublication.unmute())
  }, [muted, micPublication])

  /* -- agent state -------------------------------------------------------- */

  useEffect(() => {
    dispatch({ type: "agent.state", state: agent.state })
  }, [agent.state])

  /* -- wire bookkeeping, cleared whenever the room goes away -------------- */

  const transcriptSeen = useRef(
    new Map<string, { text: string; final: boolean }>()
  )
  const finalizedLearner = useRef<FinalizedUtterance[]>([])
  const liveLearnerSegment = useRef<string | null>(null)
  const correctionsSeen = useRef(new Set<string>())
  const translationBindings = useRef(new Map<string, string>())

  useEffect(() => {
    if (connection !== "idle") return
    transcriptSeen.current.clear()
    finalizedLearner.current = []
    liveLearnerSegment.current = null
    correctionsSeen.current.clear()
    translationBindings.current.clear()
    dispatch({ type: "session.reset" })
  }, [connection])

  /* -- transcription -> transcript.delta / transcript.final --------------- */

  const transcriptions = useTranscriptions({ room })
  const localIdentity = room.localParticipant.identity

  useEffect(() => {
    // Iterating in arrival order matters: a delta for an unseen segment retires
    // whatever is on stage, and that is the only "turn advanced" signal the
    // live pipeline gives the reducer.
    for (const entry of transcriptions) {
      const attributes = entry.streamInfo.attributes ?? {}
      const segmentId =
        attributes[STREAM_ATTRIBUTES.segmentId] ?? entry.streamInfo.id
      const speaker: Speaker =
        entry.participantInfo.identity === localIdentity ? "learner" : "tutor"
      const final =
        attributes[STREAM_ATTRIBUTES.transcriptionFinal] === ATTRIBUTE_TRUE
      const seen = transcriptSeen.current.get(segmentId)

      if (!seen || seen.text !== entry.text) {
        // Always emit the delta first, even for a segment that arrives already
        // final: `transcript.final` only patches a segment the reducer knows.
        dispatch({
          type: "transcript.delta",
          segmentId,
          speaker,
          language: "target",
          text: entry.text,
        })
        if (speaker === "learner") liveLearnerSegment.current = segmentId
      }

      if (final && !seen?.final) {
        dispatch({
          type: "transcript.final",
          segmentId,
          speaker,
          language: "target",
          text: entry.text,
          // Only learner turns reach the analyzer.
          analysisPending: speaker === "learner",
        })
        if (speaker === "learner") {
          finalizedLearner.current = [
            ...finalizedLearner.current,
            { segmentId, text: entry.text },
          ]
        }
      }

      transcriptSeen.current.set(segmentId, { text: entry.text, final })
    }
  }, [transcriptions, localIdentity])

  /* -- corrections -> analysis.complete ----------------------------------- */

  const { textStreams: correctionStreams } = useTextStream(
    TEXT_STREAM_TOPICS.corrections,
    { room }
  )

  useEffect(() => {
    for (const stream of correctionStreams) {
      if (correctionsSeen.current.has(stream.streamInfo.id)) continue
      const payload = parseCorrections(stream)
      // A stream still in flight parses as null; leave it unseen and retry on
      // the next chunk.
      if (!payload) continue
      correctionsSeen.current.add(stream.streamInfo.id)

      const segmentId = matchCorrectionsToSegment(
        payload.text ?? "",
        finalizedLearner.current
      )
      if (!segmentId) continue

      dispatch({
        type: "analysis.complete",
        segmentId,
        corrections: payload.corrections ?? [],
      })
    }
  }, [correctionStreams])

  /* -- analyzer timeout --------------------------------------------------- */

  const analyzingSegment =
    state.phase === "analyzing" ? state.current?.id : null
  useEffect(() => {
    if (!analyzingSegment) return
    const timer = setTimeout(
      () =>
        dispatch({
          type: "analysis.complete",
          segmentId: analyzingSegment,
          corrections: [],
        }),
      ANALYSIS_TIMEOUT_MS
    )
    return () => clearTimeout(timer)
  }, [analyzingSegment])

  /* -- translation -> anchor deltas --------------------------------------- */

  const { textStreams: translationStreams } = useTextStream(
    TEXT_STREAM_TOPICS.translation,
    { room }
  )

  useEffect(() => {
    // Bind each stream to the segment that was live when it opened, then
    // recompute each bound segment's anchor text from every stream on it — the
    // translate model can split one utterance across several items.
    const bySegment = new Map<string, string[]>()

    for (const stream of translationStreams) {
      const streamId = stream.streamInfo.id
      let segmentId = translationBindings.current.get(streamId)
      if (segmentId === undefined) {
        // v0 translates learner speech only, so "the current utterance" is
        // unambiguous. A stream arriving before any transcript has nowhere to
        // go and is dropped rather than opening a phantom turn.
        if (!liveLearnerSegment.current) continue
        segmentId = liveLearnerSegment.current
        translationBindings.current.set(streamId, segmentId)
      }
      const texts = bySegment.get(segmentId) ?? []
      texts.push(stream.text)
      bySegment.set(segmentId, texts)
    }

    for (const [segmentId, texts] of bySegment) {
      dispatch({
        type: "transcript.delta",
        segmentId,
        speaker: "learner",
        language: "anchor",
        text: texts.join(" ").replace(/\s+/g, " ").trim(),
      })
    }
  }, [translationStreams])

  /* -- holds -> pause / resume RPC ---------------------------------------- */

  const held = state.holds.length > 0
  const sentPause = useRef(false)

  useEffect(() => {
    if (!agent.isConnected || !agent.identity) return
    if (sentPause.current === held) return
    sentPause.current = held
    const identity = agent.identity
    void room.localParticipant
      .performRpc({
        destinationIdentity: identity,
        method: held ? RPC_METHODS.pause : RPC_METHODS.resume,
        payload: "",
      })
      .catch((err: unknown) => {
        // A failed pause is worth knowing about but not worth breaking the
        // session over; the next transition will try again.
        console.warn("tutor pause/resume RPC failed", err)
        sentPause.current = !held
      })
  }, [held, agent.isConnected, agent.identity, room])

  // The agent mirrors its real paused state as an attribute so it survives
  // reconnects. It is the source of truth for whether audio is actually
  // flowing, so if it says "paused" while the UI holds nothing, adopt a hold
  // rather than leave the learner looking at a live-looking dead session.
  const agentPaused = agent.attributes?.[PARTICIPANT_ATTRIBUTES.paused]
  useEffect(() => {
    if (agentPaused !== ATTRIBUTE_TRUE) return
    if (held) return
    sentPause.current = true
    dispatch({ type: "session.paused", reason: "control" })
  }, [agentPaused, held])

  return {
    state,
    dispatch,
    connection,
    error,
    connect,
    disconnect,
    muted,
    toggleMute: toggleMuteLocal,
    agentAudioTrack: agent.microphoneTrack,
    room,
  }
}

/** Parse a corrections stream, tolerating a payload that is still arriving. */
function parseCorrections(stream: TextStreamData): CorrectionsPayload | null {
  try {
    const parsed: unknown = JSON.parse(stream.text)
    return parsed && typeof parsed === "object"
      ? (parsed as CorrectionsPayload)
      : null
  } catch {
    return null
  }
}
