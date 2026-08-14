# Phase 3: Comprehension On Demand

*Status: COMPLETE (2026-08-14). All workstreams validated in live sessions —
see "Live evaluation findings" at the end. Read `plans/product-vision.md` first.*

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

What replaces it: **select text — learner turns once settled, tutor turns
even while still arriving (amended from live testing, see findings) — and an
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
- Opening holds the session (`"translation"` becomes a new `PauseReason` in the
  contract, joining the hold set); closing releases. Overlay results live in
  overlay state, not on `Turn.anchor`.
- Worker RPC or HTTP? Simplest: a new RPC `tutor.translate` on the agent
  (span + turn context in, translation out) reusing the analyzer's OpenAI
  client. Keep latency < ~1s; show a quiet shimmer while waiting.
- Cache per span per session — re-selecting the same text is instant.

### 4. Conversational resume

The known phase-2 gap: after a hold, resume is dead air. The design (settled
in ideation, 2026-08-12) is conversational re-entry, not audio playback — a
human tutor paused mid-thought re-enters ("como decía…"), they don't resume
mid-word like a tape deck. The surface freezes exactly (already true); the
voice re-enters with judgment.

Three layers, deliberately separate:

1. **Situation briefs** (dynamic facts, per moment): the resume RPC grows a
   payload — hold duration, hold reasons, the inspected correction if any —
   and the worker turns it into a short factual brief for a `generate_reply`
   when (and only when) the tutor was interrupted or a committed turn's reply
   was killed. If the learner was mid-utterance, resume stays silent and lets
   them lead. Debounce: holds that open and close within ~400ms never ripple
   to the agent at all — the surface freeze is client-side and instant, the
   interruption machinery is reserved for real study pauses.
2. **Behavioral policy** (system prompt v2): the language-mixing social
   grammar, taught not scripted — post-pause comprehension check happens in
   the anchor language ("ready to jump back in?") then returns to target;
   "¿cómo se dice?" moments get a brief anchor-language answer, a modeled
   form, and re-immersion; repeated struggle earns a check-in. Informed by
   the phase-2 session transcripts.
3. **The learner feedback loop** (analyzer awareness is only its first
   source): the worker composes a "tutor context brief" — quiet factual
   observations injected into the tutor's context — and this session's
   corrections stream is source #1 ("3 preterite errors so far"), letting the
   tutor steer and check in the way a human would. Build the BRIEF as the
   stable primitive, not the analyzer wiring: future sources plug into the
   same seam without rearchitecting — prior-session performance summaries,
   the reflection agent, long-term goal tracking (vision doc: learner model /
   memory / planner). Distinguish this from the phase-4 learner PROFILE:
   profile is configuration (level, preferences — things that are *set*);
   the feedback loop is evidence (things that are *observed*). They meet in
   the prompt but must stay separate primitives, or per-session tuning and
   longitudinal learning will entangle. Direction (recorded 2026-08-12,
   mechanics deferred): the loop may eventually PROPOSE profile changes
   (evidence -> inferred level), but never silently writes them — profile
   updates are deliberate and visible to the learner. When profile fields
   exist, they are typed declared-vs-inferred from day one.

Explicitly deferred to phase 4 — **learner-profile tuning**: level as a
parameter selecting policy (English-tolerance, pacing, complexity), speech
speed control (spike the realtime API for a native speed knob during this
phase's build; prompt-level pacing approximates via shorter, simpler
sentences either way). Layers 1–2 are written knowing level arrives as the
third prompt parameter beside target/anchor language.

### 5. Carried from phase 2 (unchanged scope)

- **Afterthought turns** (product question): when a learner completes a thought
  after the turn committed, should it merge and revise? Explore feel first;
  no mechanism until the interaction is understood.
- **UI polish debt**: tutor text/voice sync feel, history-peek dialog
  semantics + focus management, correction popover motion.
- **STT stray-script leakage**: keep monitoring; escalate to an STT swap
  (Deepgram Nova-3) only if it stays noisy after the prompt constraint.

## Non-goals

Tutor-side ambient translation, beginner-mode translation defaults, curriculum
features, deployment hardening, mobile, learner-level profiles and speed/
complexity tuning (phase 4 — see workstream 4). The prompt-v2 policy IS a
build item here; its refinement continues through live testing.

## Exit criteria

- Zero translation infrastructure running during normal conversation; the
  translate socket and its heuristics are deleted, not disabled.
- Conversational resume: no dead air after a hold the tutor was talking into; short glances never interrupt the voice at all.
- Select-to-translate works on learner settled turns and tutor turns
  (including in-flight), holds the session
  while open, and feels like the correction popover's sibling.
- The one-column stage renders tutor and learner turns at full width with the
  existing typography and motion intact.
- Live sessions confirm the loop still feels complete without ambient
  translation — and record whether select-to-translate gets used enough to
  justify richer treatments later.


---

## Live evaluation findings (2026-08-13/14)

All three resume paths, select-to-translate, the one-column stage, and the
analyzer passed live validation. What the sessions taught us:

1. **Prose cannot beat a realtime model's continuation instinct.** With its
   own truncated sentence last in history, "do NOT finish it" loses — the
   plain-pause re-entry replayed content until it became an EXACT-output
   instruction (the worker shuffles ten language-neutral intents, never repeating the
   immediately previous one;
   the model renders the line bilingually but does not compose it). The
   check-in and owed-answer paths, which have a concrete anchor to talk about,
   follow prose instructions fine. Rule of thumb going forward: give the model
   judgment where it has material, and exact output where it does not.
2. **Turns commit during holds.** STT finals lag the audio, so pausing right
   after speaking lands the turn mid-pause; the worker suppresses that reply
   (`StopResponse`) and marks it owed so the re-entry answers it. Without
   this, the reply is spoken into a muted session and its transcript dumps on
   resume.
3. **Tutor speech is selectable while still arriving** — in-the-moment
   comprehension is the actual use case, and selection holds the session, so
   the settled-only gate was wrong for tutor turns (kept for learner turns).
4. **The analyzer had a perfect audited session** (4/4 turns judged
   correctly), including using conversation context to repair an STT
   mishearing ("Hamas" -> hummus) and correctly passing a clean turn ("uso"
   used correctly). Luna stays for translate; the felt translate latency was
   the cold TLS connection, fixed by background warmup, not the model.
5. **"Heavy" sessions were environmental both times it was investigated:**
   once degraded transport to LiveKit's hosted inference (500-657ms, timeouts),
   once local CPU contention/thermal throttling ("inference is slower than
   realtime" plus a hot laptop running Spotify/Discord/an always-on mic app).
   Architecture was ruled out both times by healthy sessions on the same
   build. Deploying the worker to LiveKit Cloud (phase 4+) removes the local
   half of this.
6. **Design corrections from live feel:** the two-bar pause caret read as a
   glitch, not a state (now a single steady caret); the translucent review
   overlay leaked lingering exited-turn ghosts (stage now fully hidden under
   it); bridge lines are bilingual, target then anchor, so re-orientation
   never requires decoding.

### Carried to phase 4

- Learner profiles and pacing/complexity tuning (the phase headline), with
  the declared-vs-inferred typing and feedback-loop mediation as designed.
- Touch/keyboard selection paths for select-to-translate (desktop-first V0).
- Afterthought-turn merging (still an open product question).
- Worker deployment to LiveKit Cloud.
- Correction popover render-from-holds conversion; Base UI Dialog swap for
  the history peek (polish).
