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
 * 2. CORRECTIONS DO NOT CARRY A SEGMENT ID, AND ARE KEYED TO A WHOLE TURN. The
 *    analyzer keys its payload by the agent-side chat message id, which has no
 *    relationship to the segment ids LiveKit mints for transcription, and its
 *    `text` is the joined text of a turn that STT may have split across several
 *    segments. The join is therefore textual and, when the turn was split,
 *    per-correction (`attributeCorrections`).
 *
 * 3. PAUSE IS TWO-SIDED. The hold set is client-side (several UI affordances can
 *    hold at once) but the agent mirrors its real paused state as a participant
 *    attribute. Rather than edge-trigger an RPC per transition, the two are
 *    reconciled: while desired != reported the RPC is re-sent, so a dropped
 *    call, a reconnect, or a fresh agent all converge instead of stranding the
 *    surface and the tutor in opposite states. The *surface* freeze is instant
 *    and purely client-side; only the RPC is debounced — on the way up so a
 *    glance at a correction never interrupts the tutor's voice, and on the way
 *    down so hopping from one correction to the next never lets it start a
 *    sentence it will be cut off mid-word.
 *
 * The surface's other invariant is that a HELD SESSION DOES NOT MOVE. In replay
 * that is free (a held mock never schedules a beat); live, speech keeps
 * arriving, so turn-advancing events are queued while any hold is up and
 * flushed in order when the last one is released.
 */

import { useCallback, useEffect, useReducer, useRef, useState } from "react"
import { ConnectionState, Track, type Room } from "livekit-client"
import {
  useAgent,
  useSession,
  useTextStream,
  useTranscriptions,
  type TextStreamData,
  type TrackReference,
} from "@livekit/components-react"

import type {
  Correction,
  PauseReason,
  SessionEvent,
  Speaker,
  TranslateFn,
} from "./contract"
import {
  ANALYZER_OFF,
  ATTRIBUTE_TRUE,
  PARTICIPANT_ATTRIBUTES,
  RPC_METHODS,
  STREAM_ATTRIBUTES,
  TEXT_STREAM_TOPICS,
  TUTOR_SESSION_OPTIONS,
  tutorTokenSource,
} from "./livekit"
import { TRANSLATE_TIMEOUT_MS } from "./protocol"
import type {
  ResumeCorrectionPayload,
  ResumePayload,
  TranslateRequest,
  TranslateResponse,
} from "./protocol"
import {
  INITIAL_SESSION_STATE,
  isHeld,
  sessionReducer,
  type SessionState,
} from "./reducer"

/**
 * How long a learner turn may sit in `analyzing` before the surface gives up
 * waiting and settles it. The analyzer is fire-and-forget on the worker and
 * every failure path there is a dropped correction, so without this a single
 * dropped call would freeze the hero's marks forever. The turn is settled as
 * `status: "timeout"` — never as a clean bill of health.
 */
const ANALYSIS_TIMEOUT_MS = 8000

/**
 * How long a hold must survive before the agent hears about it at all. The
 * surface freezes on the first hold regardless — this window only decides
 * whether the interruption machinery gets involved, so a glance that opens and
 * closes a correction never costs the tutor a sentence.
 */
const HOLD_DEBOUNCE_MS = 400

/**
 * The release's mirror image. Hold-hopping is normal — close one correction,
 * open the next — and each gap would otherwise fire a resume the worker answers
 * with a re-entry reply, cut off by the next pause a moment later: a blurted
 * fragment. So the resume waits for the hold set to STAY empty this long, and a
 * hold reappearing inside the window cancels the release outright: the pause was
 * never lifted, so there is nothing to re-send and the held clock keeps running.
 * The surface unfreeze is not debounced — that is driven by the raw hold set.
 */
const RELEASE_DEBOUNCE_MS = 300

/** How long to wait before re-sending an unacknowledged pause/resume RPC. */
const PAUSE_RETRY_MS = 2000

/** Attempts per desired pause state before giving up on this agent. */
const MAX_PAUSE_ATTEMPTS = 5

/**
 * How many finalized learner utterances stay joinable. Corrections arrive
 * within a turn or two of the speech that produced them, so anything older is
 * dead weight — and every entry costs a `normalize()` pass per payload.
 */
const MAX_FINALIZED = 10

/**
 * Separator for the translation cache's composite key. A NUL never occurs in
 * transcript text, so no combination of turn id, speaker and span can collide
 * with another.
 */
const KEY_SEP = "\u0000"

/** Events that must not reach the reducer while the session is held. */
const TURN_ADVANCING = new Set<SessionEvent["type"]>([
  "transcript.delta",
  "transcript.final",
  "analysis.complete",
])

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

/** Case-, punctuation- and whitespace-insensitive comparison key. */
function normalize(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, "")
    .replace(/\s+/g, " ")
    .trim()
}

/**
 * Resolve which on-screen segment a whole corrections payload belongs to.
 *
 * The worker keys corrections by its own turn id (the agent's `ChatMessage.id`)
 * while the UI keys turns by `lk.segment_id`, and the two are minted by
 * different processes — they will never be equal. The payload's `text` is the
 * only shared fact, so it is the join key:
 *
 *   1. exact match against a finalized learner utterance (the normal case: the
 *      analyzer sees the same STT output the UI rendered);
 *   2. else a normalized match, which absorbs punctuation and casing drift
 *      between the realtime model's transcript and the STT plugin's.
 *
 * Returns null when the payload spans no single segment — usually because STT
 * split the turn into several segments while the analyzer saw them joined. That
 * case is `attributeCorrections`' job, not a reason to guess.
 *
 * Searching newest-first matters: a learner who repeats themselves should see
 * the correction on the utterance they just said.
 */
export function matchCorrectionsToSegment(
  payloadText: string,
  finalized: readonly FinalizedUtterance[]
): string | null {
  for (let i = finalized.length - 1; i >= 0; i--) {
    if (finalized[i]!.text === payloadText) return finalized[i]!.segmentId
  }

  const target = normalize(payloadText)
  if (!target) return null
  for (let i = finalized.length - 1; i >= 0; i--) {
    if (normalize(finalized[i]!.text) === target) return finalized[i]!.segmentId
  }

  return null
}

/** The newest finalized segment whose text contains `original`, or null. */
function segmentContaining(
  original: string,
  finalized: readonly FinalizedUtterance[]
): string | null {
  for (let i = finalized.length - 1; i >= 0; i--) {
    if (finalized[i]!.text.includes(original)) return finalized[i]!.segmentId
  }
  const needle = normalize(original)
  if (!needle) return null
  for (let i = finalized.length - 1; i >= 0; i--) {
    if (normalize(finalized[i]!.text).includes(needle))
      return finalized[i]!.segmentId
  }
  return null
}

/**
 * Spread one corrections payload over the segments it actually describes.
 *
 * The analyzer's `text` is a whole learner turn; STT may have emitted that turn
 * as several segments, each its own `Turn` on screen. When the payload matches
 * one segment outright everything belongs to it. Otherwise each correction is
 * placed on the newest segment containing its `original` — corrections whose
 * text is nowhere to be found are dropped rather than misattributed, which is
 * the only case where a mark would point at words the learner never said.
 *
 * Returns segment id → corrections, one entry per affected segment.
 */
export function attributeCorrections(
  payloadText: string,
  corrections: readonly Correction[],
  finalized: readonly FinalizedUtterance[]
): Map<string, Correction[]> {
  const bySegment = new Map<string, Correction[]>()
  if (finalized.length === 0) return bySegment

  const whole = matchCorrectionsToSegment(payloadText, finalized)
  if (whole) {
    bySegment.set(whole, [...corrections])
    return bySegment
  }

  for (const correction of corrections) {
    const segmentId = segmentContaining(correction.original, finalized)
    if (!segmentId) continue
    const list = bySegment.get(segmentId) ?? []
    list.push(correction)
    bySegment.set(segmentId, list)
  }
  return bySegment
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
  /** Select-to-translate's back end. Session-cached; see `translations`. */
  translate: TranslateFn
}

export function useLiveSession(): LiveSession {
  const session = useSession(tutorTokenSource, TUTOR_SESSION_OPTIONS)
  const agent = useAgent(session)
  const room = session.room

  const [state, dispatch] = useReducer(sessionReducer, INITIAL_SESSION_STATE)

  /**
   * The last correction the learner opened. Never cleared: the resume payload
   * only reads it when the hold that is ending actually included a
   * `"correction"` reason, and in that case the most recent open is by
   * definition this hold's. (Clearing on the rising edge would race the very
   * dispatch that opened the hold.)
   */
  const inspected = useRef<ResumeCorrectionPayload | null>(null)

  /**
   * Client-originated events pass through here so a `"correction"` hold can
   * name what is being studied. Everything else is forwarded untouched.
   */
  const clientDispatch = useCallback((event: SessionEvent) => {
    if (event.type === "session.paused" && event.correction) {
      const { original, replacement, category } = event.correction
      inspected.current = { original, replacement, category }
    }
    dispatch(event)
  }, [])

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

  /* -- the hold gate ------------------------------------------------------ */

  const held = isHeld(state)
  const heldRef = useRef(false)
  const buffered = useRef<SessionEvent[]>([])

  /**
   * Everything the wire produces goes through here rather than at the reducer
   * directly. A held session must not advance — the mock gets that by never
   * scheduling a beat, but real speech keeps arriving, so turn-advancing events
   * queue up instead. Agent state and pause events pass through: the Aura
   * should still settle while the surface is frozen.
   */
  const emit = useCallback((event: SessionEvent) => {
    if (heldRef.current && TURN_ADVANCING.has(event.type)) {
      buffered.current.push(event)
      return
    }
    dispatch(event)
  }, [])

  // Declared before the producers so that within one commit the gate closes (or
  // drains) before anything new is emitted.
  useEffect(() => {
    heldRef.current = held
    if (held || buffered.current.length === 0) return
    // FIFO: the queued deltas are cumulative snapshots, so replaying them in
    // order reproduces exactly the ticker the learner would have watched.
    const queued = buffered.current
    buffered.current = []
    for (const event of queued) dispatch(event)
  }, [held])

  /* -- agent state -------------------------------------------------------- */

  useEffect(() => {
    dispatch({ type: "agent.state", state: agent.state })
  }, [agent.state])

  /* -- wire bookkeeping, cleared whenever the room goes away -------------- */

  const transcriptSeen = useRef(
    new Map<string, { text: string; final: boolean }>()
  )
  /** Index of the oldest transcription entry that is not yet seen-final. */
  const transcriptScanFrom = useRef(0)
  const finalizedLearner = useRef<FinalizedUtterance[]>([])
  const correctionsSeen = useRef(new Set<string>())
  /**
   * Translations already paid for, keyed by turn, speaker and RAW span. Raw
   * because punctuation is meaning ("Vamos a comer, niños"), and turn-scoped
   * because the same words in a later turn are a different question — a
   * normalized, turn-blind key would answer one with the other's result. A
   * learner re-reading a phrase inside the same turn still pays nothing.
   *
   * The value is the in-flight PROMISE, not the answer: a second selection
   * while the first is still out joins that round trip instead of buying
   * another. Rejections are evicted (see `translate`), so a failure retries.
   */
  const translations = useRef(new Map<string, Promise<string>>())

  /* -- pause-cycle bookkeeping (see the hold reconciler below) ------------- */

  /**
   * A hold that has lasted long enough to be worth interrupting the tutor for
   * — and, on the way down, one that has been gone long enough to be worth
   * resuming for. The surface froze the moment the first hold landed; this is
   * the only thing the agent ever sees, so a hold that clears inside the window
   * is invisible to it — no pause, and therefore no resume either.
   */
  const [holdSettled, setHoldSettled] = useState(false)

  /** When the pause RPC actually went out; null until it does. */
  const pauseSentAt = useRef<number | null>(null)
  /**
   * How long the agent was held, frozen at release. Not recomputed per retry:
   * a re-sent resume describes the same hold, not a longer one.
   */
  const heldMs = useRef(0)
  /** Every reason that was active at any point in the current hold. */
  const holdReasons = useRef<PauseReason[]>([])
  /**
   * Whether a hold cycle is live — which outlasts the hold set itself, through
   * the release debounce. A hold arriving while this is still true is the same
   * pause continuing, not a new one.
   */
  const cycleOpen = useRef(false)
  /** When the live cycle's first hold went up, for the settle countdown. */
  const cycleStart = useRef(0)

  useEffect(() => {
    if (connection !== "idle") return
    transcriptSeen.current.clear()
    transcriptScanFrom.current = 0
    finalizedLearner.current = []
    correctionsSeen.current.clear()
    translations.current.clear()
    buffered.current = []
    // The pause cycle belongs to the room that is going away. A resume sent to
    // the NEXT tutor must not brief it with a five-minute `held_ms`, the last
    // session's reasons, or a correction from a conversation it never had — so
    // the cycle is closed here and reopened from scratch (by the reconciler
    // below, which re-runs on `connection`) if the session is still held.
    cycleOpen.current = false
    pauseSentAt.current = null
    heldMs.current = 0
    holdReasons.current = []
    inspected.current = null
    dispatch({ type: "session.reset" })
  }, [connection])

  /* -- transcription -> transcript.delta / transcript.final --------------- */

  const transcriptions = useTranscriptions({ room })
  const localIdentity = room.localParticipant.identity

  // The agent tells us whether corrections are coming at all. With the analyzer
  // off, a learner final must settle immediately rather than hang in `analyzing`
  // for the full timeout on every single turn.
  const analyzerOff =
    agent.attributes?.[PARTICIPANT_ATTRIBUTES.analyzer] === ANALYZER_OFF

  useEffect(() => {
    // `useTranscriptions` keeps insertion order and updates entries IN PLACE by
    // `lk.segment_id`, so a change is not necessarily at the tail: an older
    // learner segment can finalize after a newer tutor segment already has.
    // Only a seen-final entry is immutable, so replay from the oldest entry
    // that is not yet seen-final — the cursor advances past finalized prefixes
    // afterwards, which keeps this off the unbounded history.
    const start = transcriptScanFrom.current

    // Forward order matters from here: a delta for an unseen segment retires
    // whatever is on stage, and that is the only "turn advanced" signal the
    // live pipeline gives the reducer.
    for (let i = start; i < transcriptions.length; i++) {
      const entry = transcriptions[i]!
      const attributes = entry.streamInfo.attributes ?? {}
      const segmentId = segmentIdOf(entry)
      const speaker: Speaker =
        entry.participantInfo.identity === localIdentity ? "learner" : "tutor"
      const final =
        attributes[STREAM_ATTRIBUTES.transcriptionFinal] === ATTRIBUTE_TRUE
      const seen = transcriptSeen.current.get(segmentId)

      if (!seen || seen.text !== entry.text) {
        // Always emit the delta first, even for a segment that arrives already
        // final: `transcript.final` only patches a segment the reducer knows.
        emit({
          type: "transcript.delta",
          segmentId,
          speaker,
          language: "target",
          text: entry.text,
        })
      }

      if (final && !seen?.final) {
        emit({
          type: "transcript.final",
          segmentId,
          speaker,
          language: "target",
          text: entry.text,
          // Only learner turns reach the analyzer — and only when it is running.
          analysisPending: speaker === "learner" && !analyzerOff,
        })
        if (speaker === "learner") {
          finalizedLearner.current = [
            ...finalizedLearner.current,
            { segmentId, text: entry.text },
          ].slice(-MAX_FINALIZED)
        }
      }

      transcriptSeen.current.set(segmentId, { text: entry.text, final })
    }

    let cursor = start
    while (cursor < transcriptions.length) {
      const entry = transcriptions[cursor]!
      if (!transcriptSeen.current.get(segmentIdOf(entry))?.final) break
      cursor++
    }
    transcriptScanFrom.current = cursor
  }, [transcriptions, localIdentity, analyzerOff, emit])

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

      const finalized = finalizedLearner.current
      const newest = finalized[finalized.length - 1]?.segmentId
      // Corrections can beat their own segment's final onto the wire. Nothing
      // to attribute them to yet, so leave the stream unseen: this effect runs
      // again on the next render and the payload gets another chance, where
      // marking it seen here would drop it forever.
      if (!newest) continue

      correctionsSeen.current.add(stream.streamInfo.id)

      const bySegment = attributeCorrections(
        payload.text ?? "",
        payload.corrections ?? [],
        finalized
      )
      // The segment still waiting on the analyzer is the turn's last one, and
      // the corrections may all have landed on earlier ones (or nowhere). It
      // gets an answer regardless, or it would sit in `analyzing` until the
      // timeout for a turn the analyzer did in fact reply to.
      if (!bySegment.has(newest)) bySegment.set(newest, [])

      for (const [segmentId, corrections] of bySegment) {
        emit({ type: "analysis.complete", segmentId, corrections })
      }
    }
    // `transcriptions` is a dependency so a payload deferred above is retried
    // as soon as a learner segment finalizes; the effect declared above this
    // one has already refreshed `finalizedLearner` by then. Re-running is free
    // — `correctionsSeen` makes it idempotent.
  }, [correctionStreams, transcriptions, emit])

  /* -- analyzer timeout --------------------------------------------------- */

  const analyzingSegment =
    state.phase === "analyzing" ? state.current?.id : null
  useEffect(() => {
    if (!analyzingSegment) return
    const timer = setTimeout(
      () =>
        emit({
          type: "analysis.complete",
          segmentId: analyzingSegment,
          corrections: [],
          // Not a clean bill: nothing was ever heard back.
          status: "timeout",
        }),
      ANALYSIS_TIMEOUT_MS
    )
    return () => clearTimeout(timer)
  }, [analyzingSegment, emit])

  /* -- holds <-> pause / resume RPC --------------------------------------- */

  /**
   * The whole life of a hold cycle, in one effect keyed on the hold SET.
   *
   * Opening, accumulating reasons and closing were three effects whose
   * correctness depended on their declaration order; they are one here because
   * they are one fact. `state.holds` is the key rather than `held` so that a
   * reason added mid-cycle is recorded without restarting the settle clock —
   * that is what `cycleStart` is for.
   *
   * Both edges are debounced, and asymmetrically. Rising: a glance that opens
   * and closes a correction inside `HOLD_DEBOUNCE_MS` never reaches the agent.
   * Falling: the release is deferred by `RELEASE_DEBOUNCE_MS`, and a hold
   * arriving inside that window CANCELS it rather than restarting anything —
   * the pause was never lifted, so the cycle simply continues with the same
   * `pauseSentAt`. `inspected` is deliberately never cleared here; see its
   * declaration.
   *
   * `connection` is a dependency so that a room going away (which closes the
   * cycle above) reopens a fresh one against the new tutor while still held.
   */
  useEffect(() => {
    if (state.holds.length === 0) {
      // Scheduled even when no cycle is open: that is also how a `holdSettled`
      // stranded by a reconnect (the reset above closes the cycle without
      // touching state) gets dropped.
      const timer = setTimeout(() => {
        cycleOpen.current = false
        // Freeze how long the agent was actually held: the resume may be
        // retried, and a retry describes the same hold, not a longer one.
        heldMs.current =
          pauseSentAt.current === null ? 0 : Date.now() - pauseSentAt.current
        setHoldSettled(false)
      }, RELEASE_DEBOUNCE_MS)
      return () => clearTimeout(timer)
    }

    if (!cycleOpen.current) {
      cycleOpen.current = true
      cycleStart.current = Date.now()
      holdReasons.current = []
      pauseSentAt.current = null
    }
    for (const reason of state.holds) {
      if (!holdReasons.current.includes(reason)) {
        holdReasons.current.push(reason)
      }
    }
    // Measured from the cycle's start, not this run's: a second reason arriving
    // 300ms in must not buy the tutor another 400ms of talking.
    const remaining = Math.max(
      0,
      HOLD_DEBOUNCE_MS - (Date.now() - cycleStart.current)
    )
    const timer = setTimeout(() => setHoldSettled(true), remaining)
    return () => clearTimeout(timer)
  }, [state.holds, connection])

  // Desired: what the (debounced) hold set says. Reported: what the agent says
  // it is doing (mirrored as an attribute so it survives reconnects). The two
  // are reconciled rather than edge-triggered, so a dropped RPC, a stale
  // attribute or a brand-new agent all converge instead of stranding the
  // session.
  const desiredPause = holdSettled
  const reportedPause =
    agent.attributes?.[PARTICIPANT_ATTRIBUTES.paused] === ATTRIBUTE_TRUE
  const agentIdentity = agent.isConnected ? agent.identity : undefined

  /** The last value we asked this agent for; null = nothing asked yet. */
  const pauseAsked = useRef<boolean | null>(null)
  const pauseAttempts = useRef(0)
  const [pauseRetry, setPauseRetry] = useState(0)

  useEffect(() => {
    // A different agent (or none) has negotiated nothing with us: start over, so
    // a session that is still held re-pauses the agent it reconnects to.
    pauseAsked.current = null
    pauseAttempts.current = 0
  }, [agentIdentity])

  useEffect(() => {
    if (!agentIdentity) return
    if (desiredPause === reportedPause) {
      pauseAttempts.current = 0
      return
    }

    // The agent reports paused and we have never asked it for anything: it is
    // the source of truth for whether audio is flowing, so adopt a hold rather
    // than leave the learner looking at a live-looking dead session. Only here —
    // once we have asked, a disagreeing attribute is merely stale, and adopting
    // it would re-pause the session on every resume.
    if (pauseAsked.current === null && reportedPause) {
      pauseAsked.current = true
      dispatch({ type: "session.paused", reason: "control" })
      return
    }

    if (pauseAsked.current !== desiredPause) pauseAttempts.current = 0
    if (pauseAttempts.current >= MAX_PAUSE_ATTEMPTS) return
    pauseAsked.current = desiredPause
    pauseAttempts.current += 1

    // First attempt only: a retry is the same pause, so the clock the worker
    // reads must keep running from when the hold first reached it.
    if (desiredPause && pauseSentAt.current === null) {
      pauseSentAt.current = Date.now()
    }

    void room.localParticipant
      .performRpc({
        destinationIdentity: agentIdentity,
        method: desiredPause ? RPC_METHODS.pause : RPC_METHODS.resume,
        payload: desiredPause
          ? ""
          : JSON.stringify(
              resumePayload(
                heldMs.current,
                holdReasons.current,
                inspected.current
              )
            ),
      })
      .catch((err: unknown) => {
        // Worth knowing about, not worth breaking the session over: the retry
        // below re-fires until the agent's attribute agrees with us.
        console.warn("tutor pause/resume RPC failed", err)
      })

    // Success is the attribute flipping, not the promise resolving — that
    // re-runs this effect and clears the timer. Anything else retries.
    const timer = setTimeout(() => setPauseRetry((n) => n + 1), PAUSE_RETRY_MS)
    return () => clearTimeout(timer)
  }, [agentIdentity, desiredPause, reportedPause, pauseRetry, room])

  /* -- select-to-translate ------------------------------------------------ */

  const translate = useCallback<TranslateFn>(
    (text, speaker, turnId) => {
      const key = [turnId ?? "", speaker, text].join(KEY_SEP)
      const cached = translations.current.get(key)
      if (cached) return cached

      const ask = async (): Promise<string> => {
        if (!agentIdentity) throw new Error("no tutor connected")

        const request: TranslateRequest = {
          text,
          speaker,
          turn_id: turnId ?? null,
        }
        const raw = await room.localParticipant.performRpc({
          destinationIdentity: agentIdentity,
          method: RPC_METHODS.translate,
          payload: JSON.stringify(request),
          responseTimeout: TRANSLATE_TIMEOUT_MS,
        })

        const response = JSON.parse(raw) as TranslateResponse
        if (!response.translation) {
          throw new Error(response.error ?? "translation failed")
        }
        return response.translation
      }

      // The PROMISE is cached, and before it resolves: a second selection of
      // the same span while the first is still in flight (or a double-invoked
      // effect under StrictMode) joins that round trip instead of buying
      // another.
      const pending = ask()
      translations.current.set(key, pending)
      // Only successes stay: an error is a moment, not an answer, and
      // re-selecting the span is exactly how a learner retries.
      void pending.catch(() => {
        if (translations.current.get(key) === pending) {
          translations.current.delete(key)
        }
      })
      return pending
    },
    [agentIdentity, room]
  )

  return {
    state,
    dispatch: clientDispatch,
    translate,
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

/**
 * What the worker is told about a hold that just ended. The correction rides
 * along only when the hold actually included an inspection — otherwise the most
 * recent one belongs to some earlier moment and would be a lie about this pause.
 */
function resumePayload(
  heldMs: number,
  reasons: readonly PauseReason[],
  inspected: ResumeCorrectionPayload | null
): ResumePayload {
  return {
    held_ms: Math.max(0, Math.round(heldMs)),
    reasons: [...reasons],
    correction: reasons.includes("correction") ? inspected : null,
  }
}

/** LiveKit's segment id, falling back to the stream's own id. */
function segmentIdOf(entry: TextStreamData): string {
  return (
    entry.streamInfo.attributes?.[STREAM_ATTRIBUTES.segmentId] ??
    entry.streamInfo.id
  )
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
