# Phase 3: Comprehension On Demand

*Status: draft, pending Yash's review. Read `plans/product-vision.md` and the
phase-2 evaluation findings first.*

## The decision this phase implements

**Live translation is removed. Translation becomes select-to-translate.**

Settled 2026-08-12, from live use: the learner cannot read English while
producing Spanish — the same fact that killed the scrolling transcript kills
the live anchor column. Meanwhile the realtime-translate socket was the
weakest subsystem in every live session (undocumented endpoint, no item ids,
arrival-time attribution guessing, $0.034/min continuous) and its planned fix
was more engineering in service of a questionable feature. Phase 2's evaluation
called translation "the weakest link"; the correct response is deletion, not
reinforcement.

What replaces it: **select any settled text — learner or tutor — and an
overlay translates exactly that span, on demand.** One interaction for both
sides of the conversation, built on machinery that already exists:

- Selection opens a hold (the pause model's third entry point — inspection
  already soft-pauses; this is the same grammar as tapping a correction).
- The span is settled text, so translation is a plain request/response call to
  a cheap text model (the analyzer's Luna client can serve it) — no streams,
  no clocks, no attribution. Hundreds of ms, cached system prompt.
- Dismissing the overlay releases the hold and the conversation resumes.

Recorded trade: the original "lagging English while you speak" design bet is
dead. If a future beginner mode wants ambient translation, the contract still
carries per-turn anchor text — the door stays open without the socket.

## Workstreams

### 1. Remove the live-translation pipeline

- Backend: delete `translation.py`, its wiring task, config, and env; drop the
  `tutor.translation` topic from the contract docs.
- Frontend: remove the anchor arrival-routing (`anchorConsumed`/`anchorPending`/
  grace window) from the live producer; remove the mock producer's anchor-lag
  simulation or keep it only as replay decoration (decide in build).
- The `anchor` field stays on `Turn`/`TurnSegment` (populated on demand by
  workstream 3's results if we want persistence; otherwise vestigial-but-cheap).

### 2. One-column layout

- Remove the global English toggle and the collapsible anchor column from the
  session surface. The stage becomes a single full-width text column — this
  also fixes tutor turns rendering squeezed into half the page.
- The design-inspo playground keeps the two-column variants as historical
  reference; only the live surface and its shared components change.
- Control bar loses the Languages switch; keep the bar minimal (review, mute,
  hold, end).

### 3. Select-to-translate overlay

- Text selection (or tap-drag on touch later — desktop-first) on any settled
  turn opens a floating overlay anchored to the selection: the English
  translation, styled like the correction popover (same progressive-disclosure
  family: conversation → reveal).
- Opening holds the session (`reason: "translation"` joins the hold set);
  closing releases.
- Worker RPC or HTTP? Simplest: a new RPC `tutor.translate` on the agent
  (span + turn context in, translation out) reusing the analyzer's OpenAI
  client. Keep latency < ~1s; show a quiet shimmer while waiting.
- Cache per span per session — re-selecting the same text is instant.

### 4. Carried from phase 2 (unchanged scope)

- **Afterthought turns** (product question): when a learner completes a thought
  after the turn committed, should it merge and revise? Explore feel first;
  no mechanism until the interaction is understood.
- **UI polish debt**: tutor text/voice sync feel, history-peek dialog
  semantics + focus management, correction popover motion.
- **STT stray-script leakage**: keep monitoring; escalate to an STT swap
  (Deepgram Nova-3) only if it stays noisy after the prompt constraint.

## Non-goals

Tutor-side ambient translation, beginner-mode translation defaults, curriculum
features, deployment hardening, mobile. Language-mixing policy tuning stays a
live-testing activity, not a build item.

## Exit criteria

- Zero translation infrastructure running during normal conversation; the
  translate socket and its heuristics are deleted, not disabled.
- Select-to-translate works on both speakers' settled turns, holds the session
  while open, and feels like the correction popover's sibling.
- The one-column stage renders tutor and learner turns at full width with the
  existing typography and motion intact.
- Live sessions confirm the loop still feels complete without ambient
  translation — and record whether select-to-translate gets used enough to
  justify richer treatments later.
