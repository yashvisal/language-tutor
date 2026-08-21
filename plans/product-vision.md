# Language Tutor: Product Vision

*Last updated: 2026-08-20. This is the source of truth for what we're building and why. Phase-level plans live in `plans/phases/`. Read this before starting work in any new thread.*

---

## Vision

An AI-native language tutor centered on **real conversation**.

Long term, this should feel less like "talking to an AI in Spanish" and more like a persistent tutor that understands the learner over time: what they know, what they struggle with, recurring grammar mistakes, vocabulary gaps, pronunciation, fluency, interests, and what to practice next. Eventually: learner memory, session reflection, adaptive planning, pronunciation analysis, curriculum, personalized conversation goals.

We are intentionally **not building most of that yet**. The first goal:

> **Build the best possible live language-learning conversation surface.**

If this surface isn't meaningfully better for learning than opening a generic voice assistant and saying "practice Spanish with me," nothing else matters.

---

## Core Hypothesis

Modern models already handle natural multilingual conversation. Connecting a microphone to an LLM is not the product. The opportunity is in what happens **around** the conversation.

A good human tutor simultaneously listens, understands meaning, notices grammar and pronunciation mistakes, recognizes unnatural phrasing, decides which mistakes matter, and chooses when to correct. Constant verbal correction destroys conversational flow. Software lets us separate these concerns:

> **Conversation and coaching happen in parallel.**

The spoken tutor maintains natural conversation while the UI quietly provides learning feedback.

Example — the learner says:

> Ayer yo fue al supermercado.

The tutor keeps responding naturally while, after the turn settles, the UI subtly shows:

> Ayer yo **fui** al supermercado.

The learner sees what they should have said without being interrupted, can tap for an explanation, or simply keeps speaking. **This interaction is the primary thing to validate.**

A second, subtler version of the same hypothesis: a tutor constantly decides *how* to help — respond in Spanish, switch to English to explain a concept, or say nothing and let the UI handle it. How much of that explanatory burden can move from the tutor's voice into the interface is a core open design question (see "Language-Mixing Policy" below).

---

## Decisions Settled (2026-08-06)

These were open questions; they're now settled and shouldn't be relitigated without reason:

1. **Real voice from week one.** Live voice interaction shapes everything — how long the learner speaks, when to step in, the feel of turn-taking. We do not build a mock-only surface and wire voice later. Mocked/scripted conversation data is still used *alongside* real voice as a design and replay tool (deterministic states are faster for UI iteration), but it's a supplement, not a phase.
2. **Both sides are transcribed.** Learner speech and tutor speech both appear on screen. Layout must handle both without clutter.
3. **Spanish is the test language, not a hardcoded one.** Target language = Spanish, anchor language = English for all building and testing. But nothing should be *architecturally* Spanish-specific — prompts, schemas, and UI copy treat "target language" and "anchor language" as parameters. No language picker in V0.
4. **Target learner: the regressed/early intermediate.** Someone who has learned some Spanish, understands far more than they can produce, reaches for phrases and gets tenses and structure wrong. Not a true beginner (they can't sustain the loop yet), not an advanced learner. Yash is the reference user and primary test subject.
5. **Desktop-first web app.** This is a web-native product. No mobile work in V0.
6. **Visual baseline is settled.** shadcn "base-mira" style, neutral palette, indigo/blue primary, Geist, Base UI primitives, light/dark via next-themes. These are deliberate choices, not scaffold defaults — build on them, don't replace them. Blue is the identity color, chosen partly for how the Aura visualizer reads in it.
7. **Candidate voice models: xAI Grok Voice and OpenAI GPT Realtime.** Both have official LiveKit plugins. Initial hands-on comparison favored Grok. A structured comparison (feel, latency, instruction-following, cost per short conversation) happens once the interaction exists to test with. The model must remain swappable.
8. **LiveKit is the realtime layer.** Audio, sessions, connection state, interruptions, transcription delivery, observability. Agents UI components (including the Aura visualizer, which is shadcn-based and installs into our component tree) are implementation primitives to restyle freely — not the final design.

---

## Decisions Settled (2026-08-07)

From reviewing the phase-1 layout explorations (aura-stage, split-columns, and the stage-split hybrid built from them):

1. **Relevance-based history, not recency-based.** The live surface shows the current utterance (the hero) plus the one turn it is answering (pinned above, secondary) — and nothing else. No receding stack, no ambient scrollable transcript. Rationale: the target learner cannot multitask while producing Spanish; if they're reading history, the conversation isn't happening. Faded partially-readable history lines are the worst of both worlds — unreadable but space-consuming.
2. **Pause is a first-class interaction state**, not just a button. Three entry points, modeled as a *set of holds* (overlapping sources can't clobber each other): an explicit pause/resume control; inspecting a correction soft-pauses and closing it resumes; scrolling/opening history auto-pauses (scrolling is a declaration of "I'm reading, not talking"). While held, the surface — Aura, text, caret — communicates "holding" without a text label, and resume continues exactly where speech froze. `session.paused` / `session.resumed` are events in the frontend event contract, so the LiveKit worker is built against this model.
3. **History is an escape hatch, not a surface.** Full conversation review lives behind a deliberate action (scroll-up peek / history control) that holds the session while open.
4. **Stage-split is the working layout direction.** Aura anchor + pinned context + hero, with translation as a per-line collapsible English column under one global toggle and English lagging the Spanish during live speech. The abstraction is settled; its visual grid and motion are still being refined, and the exploration variants remain as reference points.

---

## Decisions Settled (2026-08-12, from phase-2 live testing)

1. **One realtime model: OpenAI GPT Realtime.** Grok Voice support was removed —
   its plugin cannot hand turn detection to the agent, which forces a second,
   disagreeing turn clock and degrades everything downstream. The planned A/B
   comparison is off until that changes. Decision #7 above (candidate models)
   is superseded.
2. **One turn clock.** LiveKit's semantic turn detector owns endpointing for
   the tutor's replies, transcript segmentation, the analyzer trigger — all of
   it. Every configuration that violated this broke in live testing.
3. **Live translation is dead; translation is select-to-translate.** The
   learner cannot read English while producing Spanish (the same fact that
   killed the scrolling transcript), and the ambient-translation column was
   the flakiest, costliest subsystem in every session. Translation now appears
   only on demand: select any settled text, an overlay translates that span,
   selection holds the session. "Live side-by-side translation of in-progress
   speech" (see Translation Philosophy) was explicitly flagged as unvalidated;
   it is now invalidated for V0. A future beginner mode may revisit ambient
   translation without the realtime socket.
4. **Pause is non-destructive.** Holding never discards the learner's
   in-flight utterance; input goes deaf but what was said stays in the turn.

---

## Decisions Settled (2026-08-20, product direction after the core interaction)

1. **Consumer product, not institutional.** This is a portfolio project first and
   a side-income product second. Institutional sales (schools, professors,
   approvals) are explicitly out. The Market Direction section below is
   superseded: the answer is consumer; the prototype stops being a research
   instrument for choosing a market and becomes the product.
2. **Monetization: credits, pay-as-you-go, then subscription.** A credit buys
   10 minutes of live conversation (settled 2026-08-20 — a session is a short
   1/4/4/1 arc, and ten minutes is the right length for it). One free credit on signup. Credit packs are
   the purchase unit; sessions debit a MINUTES balance (actual minutes used,
   rounded up) so short sessions are not punished. A subscription tier comes
   later and bundles the tutoring program (assessment, pre/post reviews,
   quizzes, included minutes).
3. **Pricing follows cost.** Measured 2026-08-21 on `gpt-realtime-2.1` with
   OpenAI's audio prices ($32/M input, $0.40/M cached input, $64/M output), a
   10-minute session of live conversation costs roughly **$0.85–0.95** (≈$0.09
   per active minute of talk; a paused minute costs no realtime audio — only
   the text-only study calls, below). Audio is ~94% of that, split about evenly
   between uncached input audio (learner speech + room silence, billed once per
   turn) and output audio (tutor speech, ~35–50% talk share). The mini is 3.2×
   cheaper on audio (~$0.30 per 10 minutes) but was dropped for
   instruction-following. Text-token prices for this model are unverified; the
   separate Luna calls (analyzer, Review, Ask) are not yet in the measurement.
   Credits are priced at >=3x cost. Tutor brevity is a margin policy as well as
   a pedagogy policy.
4. **Pause is the study surface: Transcript / Review / Ask.** "Branching
   conversations" from Longer-Term Direction resolves to TEXT, not voice —
   voice is the expensive, metered resource; study is cheap and better as
   text. Review = material for the session's plan (vocab, scenario phrases,
   conjugation tables). Ask = a coaching chat (not a ghostwriter) with the
   transcript-to-pause-point as context, soft invisible limits, anchored to
   the transcript position it was opened at. What returns to the voice model
   is a <=2-line brief through the existing resume-brief seam — never the
   Ask transcript.
5. **Session pre-configuration.** Before a conversation the learner can pick
   topic, scenario, focus tenses, vocab themes (or accept a suggestion). The
   resulting session plan feeds the tutor prompt, the analyzer's focus, and
   the Review tab. Onboarding is lite for now: a self-declared level plus the
   free credit; adaptive assessment is subscription-era.
6. **Auth and payments move into scope now** — credits require identity.
   Spanish remains the only language until the loop is monetized.

---

## The Conversation Surface

The working mental model for the screen (to be pressure-tested in design exploration, not final):

- **Aura sits center-top** — the visual and interactive anchor of the experience. It communicates system state (idle, connecting, listening, user speaking, processing, tutor speaking, trouble) through fluid transitions, so users understand what the agent is doing without labels.
- **As the learner speaks**, their words transcribe in the target language, with an optional **live English translation alongside** (one sentence or a couple at a time). Same for tutor speech.
- **When a learner turn settles**, a light, fast model analyzes the utterance and returns structured findings. The UI applies differentiated, subtle highlighting — tense errors, word order (e.g., adjective placement), structure, vocabulary opportunities — each treated as its own category, not one generic red underline.
- **Corrections are inspectable.** Tapping/hovering reveals the better version and, on request, a short explanation.
- **Minimal conversation controls.** Mute, end, translation toggle — little else.

Spend disproportionate effort making **30 seconds of interaction feel excellent**. Do not optimize for feature completeness.

---

## Feedback Timing

**While the learner speaks:** prioritize flow. Live transcription, Aura activity, optional translation. Never grammar corrections mid-sentence — this must not feel like Grammarly editing someone in real time.

**Immediately after the turn:** once the utterance settles, semantic feedback appears. `speech → transcript settles → correction appears`. Semantic feedback may arrive slightly later than transcription if the transition feels intentional. Categories: grammatical correction, more natural phrasing, vocabulary improvement, eventually pronunciation.

**After the conversation:** deeper coaching — recurring mistakes, vocabulary gaps, pronunciation patterns, proficiency observations, suggested practice. Outside V0.

---

## Correction UX

The most important design problem. Explore multiple ways to transform `Yo fue al parque` → `Yo fui al parque`:

- underline + replacement
- inline diff
- animated sentence morph
- replacement beneath the original word
- tap-to-reveal
- subtle highlighting

The UI must communicate (1) what could be improved and (2) the better version — without making the learner feel graded. Three separate layers, progressively disclosed:

> **conversation → correction → explanation**

Seeing `fue → fui` may be enough; grammatical explanation appears only when requested. Short explanations should be precomputed with the correction (instant reveal); deeper on-demand explanation can come later.

Not every improvement is equal. Distinguish (eventually in UI treatment, from day one in the data schema):

- actual grammatical errors
- correct but unnatural phrasing
- vocabulary opportunities
- minor stylistic improvements
- pronunciation issues

More feedback is not better feedback. A good tutor knows what to ignore. Corrections should **not** use harsh error-red; they're invitations, not failures.

---

## Language-Mixing Policy (open design question)

When the learner is confused or wrong, the tutor has three channels:

1. **Respond in Spanish** — keeps immersion, may not land
2. **Switch to English verbally** — clear, but breaks immersion and costs conversation time
3. **Say nothing; let the UI teach** — preserves flow entirely

The balance between these is a defining product question, not an implementation detail. The more teaching the UI absorbs, the more the voice can stay purely conversational. V0 should let us feel this trade-off directly and develop opinions from real use. The tutor's system prompt and the UI's feedback density are two halves of one policy.

---

## Translation Philosophy

Translation should be **available without dominating**. If English is always visible under Spanish, learners read English instead of thinking in Spanish.

Explore: global toggle, per-sentence reveal, press-and-hold, temporary reveal, different defaults by proficiency. A beginner wants translation often; an advanced learner mostly wants natural-phrasing feedback. Don't hardcode behavior yet.

Note: live side-by-side translation of in-progress speech is a stated goal (see "The Conversation Surface"). Whether a model can do this well in realtime is unvalidated — if it can't, rethink the UX rather than fake it.

---

## Visual & Product Taste

Minimal, quiet, spacious, typography-led, sophisticated, restrained. **Notion-like restraint**, not a traditional language-learning app. Credible for college students and adults.

Avoid: excessive cards, generic SaaS dashboards, gradients everywhere, mascots, childish educational aesthetics, gamification, constant scores, aggressive error colors, visual chrome.

Use typography, spacing, opacity, subtle borders, motion, selective color. Color gets expressive around: **Aura, semantic corrections, active interaction states.**

Typography note: we render inline diffs and Spanish orthography (`fue → fui`, `¿`, `ñ`, accents) prominently — the type system must handle this beautifully.

---

## Motion

Motion should explain state changes, never decorate:

- speech → interim transcript
- interim → finalized transcript
- transcript → corrected transcript
- correction → explanation
- listening → thinking → speaking

The transcript-to-correction transition may become the signature interaction.

---

## Do Not Default to Chat UI

Voice-first product, not a chatbot with a microphone. No default user-bubble/assistant-bubble stack. Explore: current utterance as visual focus, subtitle-like transcription, fading older turns, only recent context visible, interactive previous sentences, transcript hidden entirely (immersion mode). Design around **speaking another language**, not chatbot conventions.

---

## Longer-Term Direction

If the conversation primitive works, expand around it:

- **Learner model** — grammar, vocab, pronunciation, fluency, recurring mistakes
- **Reflection agent** — analyze whole conversations for patterns
- **Planner** — decide what to practice next
- **Adaptive conversation** — naturally create situations exercising weak concepts
- **Pronunciation analysis** — evaluate audio, not just transcripts
- **Memory** — prior conversations and personal context
- **Branching conversations** — tap a correction and *talk about it* (a side conversation inside a pause), then pop back to the main thread exactly where it left off. A natural extension of the pause model; explicitly later-phase.
- **Curriculum** — align with proficiency frameworks or courses

E.g., a learner repeatedly struggling with past-tense narration gets future conversations that naturally invite telling stories about past events. A tutor adapting, not a lesson tree.

Architecturally, the long-term shape is a **primary speech-to-speech agent with awareness of parallel background analyzers** (grammar, pronunciation, diction) — possibly via agent tools. Feasibility unvalidated; direction, not commitment.

---

## Market Direction

*Superseded 2026-08-20: settled on consumer — see the decisions above. Kept for the record.*

Deliberately undecided between: consumer app, college language programs, high school, or infrastructure for tutors/teachers. The interaction primitive helps answer this. A polished 60-second experience communicates the thesis better than any pitch.

Once it works, put it in front of learners at different levels, current Spanish students, tutors, and instructors. Watch for: Does transcription help or distract? Do users notice corrections? Do corrections hurt fluency? How often is translation revealed? Which corrections would tutors ignore? Would learners voluntarily talk 10–20 minutes? Would instructors assign this between classes?

The prototype is both the first product and a **research instrument for discovering the market**.

---

## Technical Direction

Stack: Next.js 16 / React 19, Tailwind 4, shadcn (base-mira) + Base UI, LiveKit + LiveKit Agents, Agents UI primitives (restyled freely).

```text
user audio
    ↓
realtime transcription ─────→ live UI (interim + final transcripts, translation)
    ↓
final utterance
    ↓
semantic analyzer (light, fast model)
    ↓
structured corrections (typed schema, never freeform Markdown)
    ↓
frontend interaction (highlight → correction → explanation)
```

Key facts established from LiveKit docs (2026-08):

- **Agents run in a separate worker process** (Python or Node), not inside Next.js. Both GPT Realtime and Grok Voice have official plugins in both languages; Python is the flagship SDK with some extra capabilities (e.g., xAI provider tools, pre-connect audio buffering).
- **Realtime speech-to-speech models do not produce interim transcripts**, and their user transcripts can arrive delayed — sometimes after the agent's response. Live on-screen transcription therefore requires a **separate STT plugin running in parallel** with the realtime model. This confirms the instinct that transcription is its own specialized stream, and it's why "live transcription" and "the voice model" must be designed as independent pipelines feeding one UI.
- Agent transcriptions are published to the frontend in sync with audio playback by default.

The semantic analyzer stays **independent of the voice pipeline** — a separate service taking finalized utterances (+ recent context) and returning the structured correction schema. The correction schema (span, replacement, category, severity, short explanation) is one of the first concrete artifacts to define; the entire correction UX renders from it.

Conversation model, transcription model, and analyzer model are all independently swappable. The product owns the learning experience; models are infrastructure.

---

## Product Principles

1. **Conversation comes first.** Don't destroy flow to surface more feedback.
2. **Learning happens around the conversation.** Teach through UI, not verbal interruption.
3. **Progressive disclosure.** Correction first, explanation second, deeper analysis later.
4. **Encourage speaking.** The learner must feel comfortable being imperfect.
5. **Calm over gamified.** No assumed streaks, XP, scores, celebration.
6. **Design for voice, not chat.**
7. **Models are replaceable infrastructure.**
8. **More correction is not necessarily better correction.**
9. **Explore multiple interaction patterns before converging.**
10. **Build the primitive before the system.**

---

## Current Scope

**In:** Aura behavior, live transcription, transcript layout, translation interactions, turn completion, correction rendering/animation/explanations, conversation controls, treatment of previous turns.

**In (since 2026-08-20):** auth, credits and minute metering, credit-pack payments, session pre-configuration, onboarding-lite, the pause study surface (Transcript / Review / Ask), deployment.

**Out (for now):** subscriptions and the tutoring program, streaks/XP, curriculum, long-term memory, planners, teacher/admin dashboards, LMS integrations, marketing pages beyond a landing page.

---

## Definition of Success

> I speak Spanish.
> I see my words appear.
> The tutor responds naturally.
> I make a mistake, but nobody interrupts me.
> After I finish, I subtly see what I should have said.
> I can understand why if I want to.
> I can reveal translation if I need it.
> Then I keep talking.

That loop is the product primitive. When deciding whether something belongs in the prototype, ask:

> **Does this make the live language-learning conversation meaningfully better?**

If not, it belongs later.
