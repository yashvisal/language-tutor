"use client"

/**
 * SELECT-TO-TRANSLATE — the correction popover's sibling.
 *
 * Phase 3 deleted ambient translation (a learner cannot read English while
 * producing Spanish), so comprehension became something you ASK FOR: drag over
 * any settled span — yours or the tutor's — and this card says what it means.
 * Same progressive-disclosure grammar as a correction mark, same tokens, and
 * the same consequence: while it is open the session is held, because a learner
 * reading a translation must never be talked over.
 *
 * Two decisions worth stating:
 *
 * 1. NO INTERMEDIATE AFFORDANCE. Mouse-up on a real selection opens the card
 *    directly rather than offering a "Translate" chip first. The gesture is
 *    already deliberate, and one click is the difference between asking and not
 *    bothering. The guard against accidents is size, not an extra step: a
 *    selection shorter than `MIN_SPAN_CHARS` is a stray click-drag, not a
 *    question.
 * 2. THE DOM IS THE REGISTRY. Every place settled text renders (pinned context,
 *    a settled hero, the history peek) marks itself with `translatableProps`,
 *    and this component resolves selections against those markers from a single
 *    document listener. Nothing has to thread selection state through the stage,
 *    and text that must NOT be translatable — the live hero, mid-stream — is
 *    excluded simply by not carrying the attribute.
 */

import { useCallback, useEffect, useRef, useState } from "react"
import { AnimatePresence, motion } from "motion/react"

import type { Speaker, TranslateFn, Turn } from "@/lib/session/contract"

const TURN_ATTR = "data-translate-turn"
const SPEAKER_ATTR = "data-translate-speaker"
/** Set on the card so click-away, the wheel-to-peek gesture and Space skip it. */
export const OVERLAY_ATTR = "data-translate-overlay"

/**
 * Mark a rendered turn's target text as selectable-to-translate. Only settled
 * text should carry this: a hero still being transcribed is moving, and
 * translating a half-arrived sentence would be answering the wrong question.
 */
export function translatableProps(turn: Pick<Turn, "id" | "speaker">) {
  return { [TURN_ATTR]: turn.id, [SPEAKER_ATTR]: turn.speaker }
}

/**
 * Below this, a selection is a slipped click rather than a question — one or
 * two letters caught while clicking a correction mark. A single short word
 * ("es") is still a legitimate ask, so the floor is characters, not words.
 */
const MIN_SPAN_CHARS = 2

/**
 * Mirrors the worker's own limit. Enforced here too so a stray select-all never
 * costs a round trip that can only come back as an error.
 */
const MAX_SPAN_CHARS = 600

const CARD_W = 300
/** Assumed card height for the flip decision — cheaper than measuring, and the
 * card only ever holds a span, a line or two of translation, and padding. */
const CARD_H = 132
/** Gap between the selection and the card, and between the card and the viewport. */
const GAP = 10
const MARGIN = 12

interface SelectionAnchor {
  /** `speaker\0text` — identity of the question being asked. */
  key: string
  text: string
  speaker: Speaker
  turnId: string
  /** Viewport coordinates of the selection, frozen at mouse-up. */
  top: number
  bottom: number
  center: number
}

interface Resolved {
  key: string
  translation?: string
  failed?: boolean
}

/**
 * Watches the document for selections inside translatable text and renders the
 * overlay for them. Presentational apart from the selection plumbing: the
 * translate function and the hold pathway are both injected, so replay and a
 * live room drive the identical component.
 */
export function SelectionTranslator({
  translate,
  onHold,
  onRelease,
}: {
  translate: TranslateFn
  /** Called when the overlay opens. Must be referentially stable. */
  onHold: () => void
  /** Called when it closes. Must be referentially stable. */
  onRelease: () => void
}) {
  const [anchor, setAnchor] = useState<SelectionAnchor | null>(null)
  const [resolved, setResolved] = useState<Resolved | null>(null)
  const cardRef = useRef<HTMLDivElement>(null)

  const dismiss = useCallback(() => {
    setAnchor(null)
    setResolved(null)
  }, [])

  useEffect(() => {
    /**
     * One listener, on mouse-up, because that is when the browser has committed
     * the selection — and because it is also every dismissal: a click anywhere
     * that is not a fresh translatable selection collapses the selection, which
     * resolves to nothing and closes the card. Deliberately NOT paired with a
     * mouse-down dismissal: dragging a new selection while the card is open
     * would then release the hold and immediately re-take it, which the live
     * producer reads as a resume the tutor can hear.
     */
    const onMouseUp = (e: MouseEvent) => {
      // Selecting the translation itself must not re-ask the question.
      if (e.target instanceof Node && cardRef.current?.contains(e.target))
        return
      const next = resolveSelection()
      if (next) setAnchor(next)
      else dismiss()
    }

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return
      // Clear the highlight too, or the dismissed question stays painted on the
      // stage with nothing answering it.
      document.getSelection()?.removeAllRanges()
      dismiss()
    }

    document.addEventListener("mouseup", onMouseUp)
    window.addEventListener("keydown", onKeyDown)
    return () => {
      document.removeEventListener("mouseup", onMouseUp)
      window.removeEventListener("keydown", onKeyDown)
    }
  }, [dismiss])

  // The hold: open is held, closed is not. Keyed on open/closed rather than on
  // the anchor, so re-selecting elsewhere moves the card without releasing and
  // re-taking the hold (which the live producer would see as a resume).
  const open = anchor !== null
  useEffect(() => {
    if (!open) return
    onHold()
    return onRelease
  }, [open, onHold, onRelease])

  useEffect(() => {
    if (!anchor) return
    const { key, text, speaker, turnId } = anchor
    let cancelled = false
    translate(text, speaker, turnId)
      .then((translation) => {
        if (!cancelled) setResolved({ key, translation })
      })
      .catch(() => {
        // The reason is for the console, never for the learner: every failure
        // reads the same from here, and the fix is always "select it again".
        if (!cancelled) setResolved({ key, failed: true })
      })
    return () => {
      cancelled = true
    }
  }, [anchor, translate])

  // Derived rather than stored: a result that isn't this selection's is still
  // in flight. Keeps the loading state out of an effect.
  const result = anchor && resolved?.key === anchor.key ? resolved : null

  return (
    <AnimatePresence>
      {anchor && (
        <motion.div
          // A stable key: re-selecting elsewhere repositions this card rather
          // than crossfading two of them.
          key="translate-overlay"
          ref={cardRef}
          role="status"
          aria-label="Translation"
          {...{ [OVERLAY_ATTR]: "" }}
          initial={{ opacity: 0, scale: 0.96, y: -4 }}
          animate={{ opacity: 1, scale: 1, y: 0 }}
          exit={{ opacity: 0, scale: 0.96, transition: { duration: 0.12 } }}
          transition={{ duration: 0.16, ease: "easeOut" }}
          style={{ ...cardPosition(anchor), width: CARD_W }}
          className="fixed z-50 rounded-lg bg-popover p-3.5 text-sm text-popover-foreground shadow-md ring-1 ring-foreground/10"
        >
          <div className="line-clamp-2 text-xs text-muted-foreground/70 italic">
            {anchor.text}
          </div>
          {result?.translation ? (
            <p className="mt-2 leading-relaxed text-balance">
              {result.translation}
            </p>
          ) : result?.failed ? (
            <p className="mt-2 text-xs text-muted-foreground/70">
              Couldn’t translate — try again
            </p>
          ) : (
            <Shimmer />
          )}
        </motion.div>
      )}
    </AnimatePresence>
  )
}

/** The wait, made quiet: two breathing bars where the sentence will land. */
function Shimmer() {
  return (
    <div aria-hidden className="mt-3 flex flex-col gap-2">
      {[0, 1].map((i) => (
        <motion.span
          key={i}
          animate={{ opacity: [0.25, 0.6, 0.25] }}
          transition={{
            duration: 1.3,
            repeat: Infinity,
            ease: "easeInOut",
            delay: i * 0.18,
          }}
          className="block h-2.5 rounded-full bg-muted-foreground/40"
          style={{ width: i === 0 ? "100%" : "58%" }}
        />
      ))}
    </div>
  )
}

/**
 * Anchored off the Range's own rect rather than a trigger element: the "thing"
 * being pointed at is a span of text that may not correspond to any single node
 * (it can start mid-word and cross correction marks), so there is nothing for a
 * Popover to attach to. Fixed positioning keeps it in the same coordinate space
 * the rect is measured in.
 */
function cardPosition(anchor: SelectionAnchor): { top: number; left: number } {
  const below = anchor.bottom + GAP
  const flip = below + CARD_H > window.innerHeight - MARGIN
  return {
    top: flip ? Math.max(MARGIN, anchor.top - GAP - CARD_H) : below,
    left: clamp(
      anchor.center - CARD_W / 2,
      MARGIN,
      Math.max(MARGIN, window.innerWidth - CARD_W - MARGIN)
    ),
  }
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max)
}

/**
 * The current selection, if it is a translatable question.
 *
 * Everything rejected here is rejected silently — an empty selection, a
 * selection outside settled text, and a selection that spans two turns (whose
 * common ancestor carries no marker, so no turn owns it) all simply produce no
 * overlay. A selection that starts inside a correction mark is fine: marks are
 * nested inside the turn's marker, so the turn still owns it.
 */
function resolveSelection(): SelectionAnchor | null {
  const selection = document.getSelection()
  if (!selection || selection.isCollapsed || selection.rangeCount === 0) {
    return null
  }
  const range = selection.getRangeAt(0)
  const host = closestTranslatable(range.commonAncestorContainer)
  if (!host) return null
  // The common ancestor can carry the marker while an endpoint sits outside it
  // (a selection extended past the turn re-anchors upward in some browsers).
  if (
    !host.contains(range.startContainer) ||
    !host.contains(range.endContainer)
  )
    return null

  const turnId = host.getAttribute(TURN_ATTR)
  const speaker = host.getAttribute(SPEAKER_ATTR)
  if (!turnId || (speaker !== "learner" && speaker !== "tutor")) return null

  const text = selection.toString().replace(/\s+/g, " ").trim()
  if (text.length < MIN_SPAN_CHARS || text.length > MAX_SPAN_CHARS) return null

  const rect = range.getBoundingClientRect()
  if (rect.width === 0 && rect.height === 0) return null

  return {
    key: `${speaker}\u0000${text}`,
    text,
    speaker,
    turnId,
    top: rect.top,
    bottom: rect.bottom,
    center: rect.left + rect.width / 2,
  }
}

function closestTranslatable(node: Node | null): HTMLElement | null {
  const element = node instanceof Element ? node : (node?.parentElement ?? null)
  return element?.closest<HTMLElement>(`[${TURN_ATTR}]`) ?? null
}
