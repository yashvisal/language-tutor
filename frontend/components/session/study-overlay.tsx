"use client"

/**
 * THE STUDY SURFACE — what a pause is for.
 *
 * This was the history peek, and it keeps every one of that component's
 * contracts: a modal dialog over a stage that is `inert` and fully hidden
 * beneath it (a translucent backdrop over a merely-dimmed stage leaks exited
 * turns), focus moved in on open and returned to the trigger on close, one
 * Escape per layer, and a single `"history"` hold for as long as it is up.
 *
 * What changed is what it holds the session FOR. Pause is the study surface
 * (plans/product-vision.md, 2026-08-20 #4), so the one escape hatch became
 * three faces of the same document:
 *
 * - TRANSCRIPT — the conversation, still selectable-to-translate, now marked at
 *   the turns the learner stopped to ask about.
 * - REVIEW — the material this session's plan implies.
 * - ASK — a coaching chat about the conversation so far.
 *
 * One hold covers all three: switching tabs is not a new kind of pause, and the
 * worker is told which tab was open only as a fact about the hold that ended.
 */

import { useEffect, useRef, useState, type RefObject } from "react"
import { MessageCircle, X } from "lucide-react"
import { AnimatePresence, motion, useReducedMotion } from "motion/react"

import { SettledText } from "@/components/session/correction-mark"
import {
  ROW_LEADING,
  StageGrid,
  StageRow,
} from "@/components/session/stage-grid"
import { AskTab } from "@/components/session/study-ask"
import { ReviewTab } from "@/components/session/study-review"
import {
  OVERLAY_ATTR,
  OVERLAY_OPEN,
} from "@/components/session/translate-overlay"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip"
import type {
  AskExchange,
  ReviewState,
  StudyTab,
  Turn,
} from "@/lib/session/contract"
import { cn } from "@/lib/utils"

const TABS: Array<{ value: StudyTab; label: string }> = [
  { value: "transcript", label: "Transcript" },
  { value: "review", label: "Review" },
  { value: "ask", label: "Ask" },
]

export function StudyOverlay({
  turns,
  thread,
  tab,
  onTabChange,
  onAsk,
  review,
  goal,
  focusTenses,
  heroTurnId,
  outOfMinutes = false,
  onEnd,
  onClose,
  restoreFocusTo,
}: {
  /** The whole conversation, hero included — see `transcriptTurns`. */
  turns: Turn[]
  thread: readonly AskExchange[]
  tab: StudyTab
  onTabChange: (tab: StudyTab) => void
  onAsk: (question: string, turnId: string | null) => void
  /** This session's material and how fresh it is; see `ReviewState`. */
  review: ReviewState
  /**
   * The confirmed goal, one line. It appears on the Review tab and nowhere
   * else: the stage during a conversation carries the current moment, and a
   * standing line of intent above it would be furniture.
   */
  goal?: string | null
  focusTenses?: readonly string[]
  heroTurnId: string | null
  /**
   * The balance ran out and the worker is holding here. A modal says so and
   * offers the one door — End — and nothing else works until it is taken. The
   * learner may set the modal aside to read the transcript and review
   * underneath (the most useful things on screen at that moment), but the
   * surface itself still cannot be closed: closing is resuming, and there is
   * nothing to resume into until there are minutes again.
   */
  outOfMinutes?: boolean
  onClose: () => void
  /** Out of minutes, the one action: end the session as End does. */
  onEnd?: () => void
  /**
   * What opened the surface, captured by the caller at interaction time (a ref,
   * so nothing reads it during render). Null when there is nothing to go back
   * to — the wheel gesture. It cannot be found from in here: the stage is
   * marked `inert` in the same commit that mounts this, which blurs the trigger
   * to `<body>` before any effect runs.
   */
  restoreFocusTo?: RefObject<HTMLElement | null>
}) {
  const reducedMotion = useReducedMotion()

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return
      // Escape is a resume, and out of minutes there is nothing to resume to.
      if (outOfMinutes) return
      // One Escape, one layer: a translation open over the surface dismisses
      // first. The value matters — a card mid-exit is still in the DOM but is
      // no longer a layer, and would otherwise swallow this Escape too.
      if (document.querySelector(`[${OVERLAY_ATTR}="${OVERLAY_OPEN}"]`)) return
      onClose()
    }
    window.addEventListener("keydown", onKeyDown)
    return () => window.removeEventListener("keydown", onKeyDown)
  }, [onClose, outOfMinutes])

  /**
   * Dialog focus, both directions. The panel covers the stage (which the stage
   * marks `inert` while this is up), so focus must move into it on open or the
   * next Tab lands on nothing; and it must go back where it came from on close,
   * or a learner who opened this from the control bar loses their place.
   */
  const closeRef = useRef<HTMLButtonElement>(null)
  const endRef = useRef<HTMLButtonElement>(null)
  const barEndRef = useRef<HTMLButtonElement>(null)
  useEffect(() => {
    // Read on mount, not on close: whatever opened this surface is the thing to
    // return to, whatever the ref happens to hold by then.
    const trigger = restoreFocusTo?.current
    // Out of minutes the close button is gone. The modal moves focus to its
    // own End button when it opens; if it has been set aside, the bar's End is
    // the surface's one control.
    ;(closeRef.current ?? barEndRef.current)?.focus()
    return () => {
      if (trigger?.isConnected) trigger.focus()
    }
  }, [restoreFocusTo])

  /**
   * "Read the review" sets the modal aside without letting the learner out:
   * the overlay stays, the close button stays gone, and a bar at the top keeps
   * End in view. The flag is cleared the moment minutes exist again, so the
   * next zero is announced the same way as the first.
   */
  const [reading, setReading] = useState(false)
  const [wasOut, setWasOut] = useState(outOfMinutes)
  if (wasOut !== outOfMinutes) {
    setWasOut(outOfMinutes)
    if (!outOfMinutes) setReading(false)
  }

  return (
    <motion.div
      role="dialog"
      aria-modal="true"
      aria-label="Study"
      initial={reducedMotion ? { opacity: 0 } : { opacity: 0, y: -12 }}
      animate={{ opacity: 1, y: 0 }}
      exit={reducedMotion ? { opacity: 0 } : { opacity: 0, y: -12 }}
      transition={{
        duration: reducedMotion ? 0.15 : 0.3,
        ease: [0.32, 0.72, 0, 1],
      }}
      className="absolute inset-0 z-20 bg-background/92 backdrop-blur-xl"
    >
      <Tabs
        value={tab}
        onValueChange={(value) => onTabChange(value as StudyTab)}
        className="flex h-full min-h-0 flex-col gap-0"
      >
        {/* The exit stays visible once the modal has been set aside: a learner
            who put it away to read should not have to go looking for the
            door when they are done. */}
        {outOfMinutes && reading && (
          <div className="flex shrink-0 items-center justify-between gap-3 border-b border-foreground/[0.06] bg-primary/[0.06] px-4 py-2">
            <p className="text-sm text-foreground/80">Out of minutes</p>
            <Button size="sm" ref={barEndRef} onClick={onEnd}>
              End session
            </Button>
          </div>
        )}

        <div className="relative flex shrink-0 items-center justify-center px-4 pt-3">
          <TabsList variant="line" className="h-8">
            {TABS.map(({ value, label }) => (
              <TabsTrigger key={value} value={value} className="px-3">
                {label}
              </TabsTrigger>
            ))}
          </TabsList>
          {/* No way out while the balance is zero: the only door is End, and a
              close button that resumed into a held session would be a button
              that does nothing. */}
          {!outOfMinutes && (
            <Tooltip>
              <TooltipTrigger
                render={
                  <Button
                    ref={closeRef}
                    variant="ghost"
                    size="icon-sm"
                    onClick={onClose}
                    aria-label="Close and resume"
                    className="absolute top-3 right-4 rounded-full text-muted-foreground hover:text-foreground"
                  >
                    <X />
                  </Button>
                }
              />
              <TooltipContent side="left">Close and resume</TooltipContent>
            </Tooltip>
          )}
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto px-6 pt-6 pb-16">
          {/* Same grid as the stage, so every tab reads as the same document.
              `min-h-full`, not `h-full`: a fixed-height grid inside a scroll
              container lets a long transcript overflow its own box, and the
              container's bottom padding then sits behind the overflow rather
              than after it — the "no gap at the bottom" (live, 2026-09-09). */}
          <StageGrid className="flex min-h-full flex-col">
            <TabsContent value="transcript">
              <TranscriptTab turns={turns} thread={thread} />
            </TabsContent>
            <TabsContent value="review">
              <ReviewTab
                review={review}
                goal={goal}
                focusTenses={focusTenses}
              />
            </TabsContent>
            {/* The Ask tab fills the column so its composer sits at the
                bottom; `h-full` on it had nothing to be full of once the grid
                became `min-h-full`, and the empty state showed the composer
                floating mid-screen (live, 2026-09-10). */}
            <TabsContent value="ask" className="flex flex-1 flex-col">
              <AskTab
                thread={thread}
                onAsk={onAsk}
                heroTurnId={heroTurnId}
                turns={turns}
              />
            </TabsContent>
          </StageGrid>
        </div>
      </Tabs>

      {/* A modal, not a card wedged above the tabs: running out is a stop, and
          a stop should look like one. It cannot be dismissed by Escape, the
          backdrop, or a close button — the only way to close it and stay is
          "Read the review", which leaves the bar above. The Escape and close
          guards on the overlay itself hold either way. */}
      <Dialog
        open={outOfMinutes && !reading}
        // `open` is fully controlled and only the two buttons change it, so
        // every close Base UI asks for (Escape, and the backdrop even with
        // pointer dismissal off) is declined here.
        onOpenChange={() => undefined}
        disablePointerDismissal
      >
        <DialogContent
          showCloseButton={false}
          initialFocus={endRef}
          // Set aside rather than closed, so focus goes to the bar's End
          // (rendered in the same commit) instead of back to `<body>`.
          finalFocus={barEndRef}
          className="gap-0 overflow-hidden p-0 sm:max-w-md"
        >
          <DialogHeader className="px-6 pt-5 pb-5 text-left">
            <DialogTitle className="text-base">
              You&rsquo;re out of minutes.
            </DialogTitle>
            <DialogDescription className="leading-relaxed">
              Buying more will land here. For now, end the session — this
              conversation and its review go to your history.
            </DialogDescription>
          </DialogHeader>
          <div className="flex items-center justify-end gap-2 border-t border-foreground/[0.06] px-6 py-4">
            <Button variant="ghost" onClick={() => setReading(true)}>
              Read the review
            </Button>
            <Button ref={endRef} onClick={onEnd}>
              End session
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </motion.div>
  )
}

/**
 * The conversation, plus the marks a learner left on it.
 *
 * An Ask thread is stamped to the turn that was on stage when it was asked, and
 * that stamp is rendered HERE rather than only in the Ask tab: the transcript is
 * where a learner goes looking for "the bit where I got stuck", and a question
 * is part of what happened at that moment. The marker is deliberately almost
 * invisible until reached for — this is a transcript, not a comment thread.
 */
function TranscriptTab({
  turns,
  thread,
}: {
  turns: Turn[]
  thread: readonly AskExchange[]
}) {
  const [opened, setOpened] = useState<string | null>(null)

  if (turns.length === 0) {
    return (
      <p className="pt-16 text-sm text-muted-foreground">Nothing said yet.</p>
    )
  }

  return (
    <div className="space-y-7">
      {turns.map((turn) => {
        const asks = thread.filter((entry) => entry.turnId === turn.id)
        const open = opened === turn.id
        return (
          <StageRow key={turn.id} speaker={turn.speaker}>
            <p
              className={cn(
                "text-base tracking-[-0.011em]",
                ROW_LEADING,
                turn.speaker === "tutor"
                  ? "text-muted-foreground"
                  : "text-foreground/90"
              )}
            >
              <SettledText turn={turn} />
              {asks.length > 0 && (
                <button
                  type="button"
                  onClick={() => setOpened(open ? null : turn.id)}
                  aria-expanded={open}
                  aria-label={`${asks.length} question${asks.length > 1 ? "s" : ""} asked here`}
                  className={cn(
                    "ml-1.5 inline-flex translate-y-[2px] items-center rounded-sm text-muted-foreground/35 transition-colors hover:text-muted-foreground/80 focus-visible:outline-1 focus-visible:outline-ring",
                    open && "text-muted-foreground/80"
                  )}
                >
                  <MessageCircle className="size-3.5" />
                  {asks.length > 1 && (
                    <span className="ml-0.5 text-[10px] leading-none">
                      {asks.length}
                    </span>
                  )}
                </button>
              )}
            </p>
            <AnimatePresence initial={false}>
              {open && (
                <motion.div
                  initial={{ opacity: 0, height: 0 }}
                  animate={{ opacity: 1, height: "auto" }}
                  exit={{ opacity: 0, height: 0 }}
                  transition={{ duration: 0.22, ease: "easeOut" }}
                  className="overflow-hidden"
                >
                  <div className="mt-2 space-y-3 border-l border-border/50 pl-3">
                    {asks.map((entry) => (
                      <div key={entry.id}>
                        <p className="text-sm leading-6 text-foreground/75">
                          {entry.question}
                        </p>
                        <p className="text-sm leading-6 text-pretty text-muted-foreground/70">
                          {entry.answer ?? (entry.failed ? "No answer" : "…")}
                        </p>
                      </div>
                    ))}
                  </div>
                </motion.div>
              )}
            </AnimatePresence>
          </StageRow>
        )
      })}
    </div>
  )
}
