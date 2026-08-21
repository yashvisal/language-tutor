"use client"

/**
 * ASK — a coaching chat, in text, inside a pause.
 *
 * "Branching conversations" resolved to TEXT (vision doc, 2026-08-20 #4): voice
 * is the metered resource, study is cheap, and a question about a word is a
 * better question typed than spoken. So this is deliberately a thread and
 * nothing more — the persona (push back, make the learner try first, never
 * ghostwrite) and the invisible limits both live in the worker. The UI's only
 * opinions are that a question is anchored to the moment it was asked, and that
 * waiting is quiet.
 *
 * A `limit` answer renders exactly like any other, because it IS one: when the
 * worker decides the learner has been reading for long enough, it answers with
 * a gentle turn back toward speaking. Marking that as a rejection would make
 * the surface argue with the coach.
 */

import { useEffect, useRef, useState } from "react"

import { Shimmer } from "@/components/session/translate-overlay"
import type { AskExchange, Turn } from "@/lib/session/contract"
import { MAX_QUESTION_CHARS } from "@/lib/session/protocol"

export function AskTab({
  thread,
  onAsk,
  /** The turn on stage right now — what a new question gets stamped to. */
  heroTurnId,
  /** The conversation, for resolving an exchange's anchor to readable words. */
  turns,
}: {
  thread: readonly AskExchange[]
  onAsk: (question: string, turnId: string | null) => void
  heroTurnId: string | null
  turns: readonly Turn[]
}) {
  const [draft, setDraft] = useState("")
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const bottomRef = useRef<HTMLDivElement>(null)

  // Switching to this tab is reaching for the keyboard. (On the overlay's own
  // open, the dialog's focus effect runs last and keeps the close button — a
  // learner who opened the surface has not necessarily decided to type.)
  useEffect(() => {
    inputRef.current?.focus()
  }, [])

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ block: "end", behavior: "smooth" })
  }, [thread])

  const send = () => {
    const question = draft.trim()
    if (!question) return
    onAsk(question.slice(0, MAX_QUESTION_CHARS), heroTurnId)
    setDraft("")
  }

  return (
    <div className="flex min-h-full flex-col pt-2">
      <div className="flex-1 space-y-8">
        {thread.length === 0 && (
          <p className="pt-16 text-sm text-muted-foreground/60">
            Ask about anything you just said — a word you couldn’t reach, a
            correction you don’t believe.
          </p>
        )}
        {thread.map((entry, i) => (
          <Exchange
            key={entry.id}
            entry={entry}
            // The anchor line is a change marker, not a stamp on every message:
            // a run of questions about the same moment says it once.
            anchor={
              entry.turnId && entry.turnId !== thread[i - 1]?.turnId
                ? anchorLabel(entry.turnId, turns)
                : null
            }
          />
        ))}
        <div ref={bottomRef} />
      </div>

      <div className="sticky bottom-0 mt-8 bg-background/80 pt-3 pb-2 backdrop-blur-sm">
        <textarea
          ref={inputRef}
          value={draft}
          onChange={(e) =>
            setDraft(e.target.value.slice(0, MAX_QUESTION_CHARS))
          }
          onKeyDown={(e) => {
            // Enter sends; Shift+Enter is a newline. Escape is left alone — it
            // belongs to the overlay, and closing is also resuming.
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault()
              send()
            }
          }}
          rows={2}
          placeholder="Ask a question…"
          aria-label="Ask the coach a question"
          className="w-full resize-none rounded-lg border border-border/60 bg-background/60 px-3 py-2 text-sm leading-6 transition-colors outline-none placeholder:text-muted-foreground/50 focus:border-border"
        />
      </div>
    </div>
  )
}

function Exchange({
  entry,
  anchor,
}: {
  entry: AskExchange
  anchor: string | null
}) {
  return (
    <div>
      {anchor && (
        <p className="mb-2 text-xs text-muted-foreground/50 italic">
          asked after “{anchor}”
        </p>
      )}
      <p className="text-sm leading-6 tracking-[-0.011em] text-foreground/90">
        {entry.question}
      </p>
      {entry.answer ? (
        <p className="mt-2 text-sm leading-6 text-pretty text-foreground/65">
          {entry.answer}
        </p>
      ) : entry.failed ? (
        <p className="mt-2 text-xs text-muted-foreground/60">
          Couldn’t answer — ask again
        </p>
      ) : (
        <Shimmer lines={2} className="mt-3 max-w-[70%]" />
      )}
    </div>
  )
}

/** The first words of the turn a question was asked after. */
export function anchorLabel(
  turnId: string,
  turns: readonly Turn[],
  words = 6
): string | null {
  const turn = turns.find((t) => t.id === turnId)
  if (!turn?.target) return null
  const parts = turn.target.split(/\s+/).filter(Boolean)
  const head = parts.slice(0, words).join(" ")
  return parts.length > words ? `${head}…` : head
}
