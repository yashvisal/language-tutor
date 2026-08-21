"use client"

/**
 * The study surface's session state, shared by both producers.
 *
 * Pause is the study surface (plans/product-vision.md, 2026-08-20 #4), and what
 * it studies outlives any one pause: a question asked two holds ago is still
 * part of this session's thread, and the review material is generated once and
 * then never changes. Neither can live in the overlay, which unmounts on every
 * resume — so both live here, in the producer, for exactly as long as the
 * session does.
 *
 * The hook is backend-agnostic on purpose: the live adapter hands it RPCs and
 * the mock hands it canned answers, and the overlay cannot tell them apart —
 * the same split that makes the design playground a real test of the surface.
 */

import { useCallback, useMemo, useRef, useState } from "react"

import type { AskExchange, StudySession, StudyTab } from "./contract"
import {
  ASK_HISTORY_MESSAGES,
  REVIEW_MAX_POLLS,
  REVIEW_POLL_MS,
  type AskMessage,
  type AskResponse,
  type ReviewMaterial,
  type ReviewResponse,
} from "./protocol"

/**
 * What a producer must supply. Both methods are one round trip: the polling,
 * the thread, and the cache are this hook's business, so a producer only has to
 * know how to reach its answerer.
 */
export interface StudyBackend {
  ask: (
    question: string,
    turnId: string | null,
    history: AskMessage[]
  ) => Promise<AskResponse>
  review: () => Promise<ReviewResponse>
}

export interface Study extends StudySession {
  /**
   * Clears the thread, the tab and the cached material. Called when the room
   * goes away: the next session studies its own conversation, not this one's.
   */
  reset: () => void
}

export function useStudy(
  backend: StudyBackend,
  /**
   * Told about every question as it is asked, so the live producer can put this
   * hold's questions on the resume payload without the overlay knowing that the
   * pause pipeline exists. Must be referentially stable.
   */
  onAsk?: (question: string) => void
): Study {
  const [thread, setThread] = useState<AskExchange[]>([])
  const [tab, setTab] = useState<StudyTab>("transcript")

  /**
   * The material, as the in-flight PROMISE rather than the answer — a second
   * visit to the Review tab while the first poll loop is still running joins it
   * instead of starting a second one. Null resolutions stay cached too: a
   * worker that never produced material will not produce it on the next glance
   * either, and re-polling for twenty more seconds would only re-shimmer.
   */
  const material = useRef<Promise<ReviewMaterial | null> | null>(null)

  /** Monotonic within a session; ids only have to be unique among siblings. */
  const asked = useRef(0)

  /**
   * The thread, mirrored so that `ask` can read it (for the history it sends)
   * and patch it (when the answer lands) without either depending on the render
   * that produced it.
   */
  const threadRef = useRef<AskExchange[]>([])
  const update = useCallback(
    (patch: (prev: readonly AskExchange[]) => AskExchange[]) => {
      threadRef.current = patch(threadRef.current)
      setThread(threadRef.current)
    },
    []
  )

  const ask = useCallback(
    (question: string, turnId: string | null) => {
      const trimmed = question.trim()
      if (!trimmed) return
      const id = `ask-${(asked.current += 1)}`
      const history = historyFrom(threadRef.current)
      update((prev) => [
        ...prev,
        { id, question: trimmed, answer: null, turnId },
      ])
      onAsk?.(trimmed)

      backend
        .ask(trimmed, turnId, history)
        .then((response) => {
          // An `error` with no answer is the only failure the worker reports;
          // hitting the invisible cap is not one — it comes back as a real
          // answer with `limit`, and renders like any other.
          update((prev) =>
            prev.map((entry) =>
              entry.id === id
                ? response.answer
                  ? {
                      ...entry,
                      answer: response.answer,
                      limit: response.limit === true,
                    }
                  : { ...entry, failed: true }
                : entry
            )
          )
        })
        .catch(() => {
          update((prev) =>
            prev.map((entry) =>
              entry.id === id ? { ...entry, failed: true } : entry
            )
          )
        })
    },
    [backend, onAsk, update]
  )

  const fetchReview = useCallback((): Promise<ReviewMaterial | null> => {
    const cached = material.current
    if (cached) return cached
    const pending = pollReview(backend.review)
    material.current = pending
    // A transport failure is a moment, not an answer: dropping it from the
    // cache is how re-opening the tab retries.
    void pending.catch(() => {
      if (material.current === pending) material.current = null
    })
    return pending
  }, [backend])

  const reset = useCallback(() => {
    threadRef.current = []
    setThread([])
    setTab("transcript")
    material.current = null
    asked.current = 0
  }, [])

  return useMemo(
    () => ({ thread, ask, fetchReview, tab, setTab, reset }),
    [thread, ask, fetchReview, tab, reset]
  )
}

/** The last few exchanges, flattened into the alternating roles the worker reads. */
function historyFrom(thread: readonly AskExchange[]): AskMessage[] {
  const messages: AskMessage[] = []
  for (const entry of thread) {
    if (!entry.answer) continue
    messages.push({ role: "learner", text: entry.question })
    messages.push({ role: "coach", text: entry.answer })
  }
  return messages.slice(-ASK_HISTORY_MESSAGES)
}

/**
 * Ask until the material exists. `ready: false` is not a failure — the worker
 * generates a session's material once, in the background — so this waits it
 * out, and gives up quietly rather than surfacing a retry the learner would
 * have to think about.
 */
async function pollReview(
  request: () => Promise<ReviewResponse>
): Promise<ReviewMaterial | null> {
  for (let attempt = 0; attempt < REVIEW_MAX_POLLS; attempt++) {
    const response = await request()
    if (response.ready) {
      const { vocab, phrases, tables } = response
      return {
        vocab: vocab ?? [],
        phrases: phrases ?? [],
        tables: tables ?? [],
      }
    }
    await sleep(REVIEW_POLL_MS)
  }
  return null
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
