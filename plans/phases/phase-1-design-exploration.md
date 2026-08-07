# Phase 1: UI/UX Design Exploration

*Status: next up. Read `plans/product-vision.md` first — it is the source of truth for product intent, taste, and settled decisions.*

## Goal

**Find the right UX for the live conversation surface.** Not "produce N variants" — variants are the instrument, not the deliverable. Build as many or as few as it takes to answer the core questions below; kill weak directions early and go deeper on promising ones. Parallel exploration (worktrees/subagents) is encouraged where directions are genuinely independent — usage budget is not the constraint.

The deliverable is a set of *answers* (a chosen direction, backed by things you can feel and compare), not a gallery.

## The core questions

The nature of the problem is that speech is a live, temporal medium — so the hardest design questions here are about **time and density**, not static layout:

1. **How does text live on screen?** How words arrive during speech (word-by-word? phrase chunks? settling from interim to final?), how a finished utterance transitions to "settled," how corrections layer in afterward, and how text *leaves* — fading, collapsing, scrolling away. The full lifecycle of an utterance is the thing to design.
2. **How much text should be on screen at once?** Both sides are transcribed, translation may be visible, corrections add another layer. What's the density ceiling before the surface stops feeling like a conversation and starts feeling like a document? What does the minimum viable amount of text look like?
3. **What layout carries this best?** Including deliberately extreme points: a text-only treatment (no Aura — just typography doing all the work), an Aura-dominant treatment with subtitle-level text, and points between. Aura center-top is the working assumption, not a requirement.
4. **What do corrections and translation reveals feel like in context?** (Progressive disclosure patterns from the vision doc — but evaluated inside a flowing conversation, not as isolated components.)

Motion is not a polish step here — it *is* the subject. Interim→final settling and transcript→correction are candidate signature moments.

## What every exploration must express

Whatever the layout, each renders the same loop: learner speaks → live target-language transcription (translation available) → tutor responds (also transcribed) → learner turn settles → differentiated semantic highlights (tense, word order, structure, vocabulary — distinct treatments, not one red underline) → correction inspectable → optional short explanation → older turns recede. Minimal controls (mute, end, translation toggle).

## Method

- **Mock a real conversation, realistically.** Drive explorations from a shared scripted event stream (interim transcript deltas, final transcripts, tutor speech + transcript, correction payloads, agent state changes) played back on a realistic timeline — real speech pacing, real pauses, not instant text dumps. The script must include the hard cases: mid-sentence restarts/self-corrections, a turn with multiple error categories, a clean turn with no corrections (what does silence look like?), a long tutor explanation, an interruption.
- Because the event shapes mirror what LiveKit + the analyzer will emit, the mock survives as a permanent dev/demo/replay mode.
- **Real voice is available if mocked timing isn't enough.** Yash can set up LiveKit + model API keys on request. If evaluating a direction genuinely requires real turn-taking feel (it likely will before finalizing timing-dependent interactions), ask for keys and wire a minimal real pipeline rather than tuning animations against fake rhythm indefinitely.

## Fixed (do not vary)

- Theme: existing base-mira / neutral / indigo tokens, Geist, light + dark both work
- Desktop-first; no mobile layouts
- Taste guardrails from the vision doc: no chat bubbles by default, no cards-everywhere, no error-red corrections, no gamification chrome
- Spanish target / English anchor content

## Evaluation

Judge against the vision doc's definition of success:

- Does the 30-second loop feel excellent, calm, and legible?
- Does text arrival/departure feel like conversation, not like a terminal printing logs?
- Can you always tell what the agent is doing without labels?
- Do corrections feel like invitations, not grades?
- Does translation help without becoming a crutch surface?
- Is two-sided transcription readable without clutter?

## Exit criteria

Phase 1 is done when the core questions above have answers we believe — a chosen layout direction (possibly hybridized), a chosen text-density/history model, a chosen default correction pattern + translation interaction, the mock event schema promoted to the canonical frontend event contract, and a shortlist of things only real voice can settle — enough to write `plans/phases/phase-2-*.md`.

## Non-goals

Persistence, auth, performance work, mobile, full backend build-out. (A minimal real-voice pipeline for evaluation purposes is allowed, per Method.)
