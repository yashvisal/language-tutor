# Phase 2: Live Pipeline

*Status: COMPLETE (2026-08-12). The loop works end-to-end live — see "Live evaluation findings" at the end for what the sessions taught us and what carries into phase 3. Read `plans/product-vision.md` first.*

*Reading note: the sections below are the plan as written before the build. Where live testing diverged — Grok removed (the diagram and "Model choices" still show it as swappable), pause made non-destructive (workstream 2 still lists `clear_user_turn()`), endpointing floors added — the findings section at the end is authoritative and supersedes on conflict.*

## Goal

**Real voice on the stage-split surface.** A learner opens the app, talks to the tutor over LiveKit, sees live Spanish transcription with lagging English translation, and gets structured corrections on settled turns — the full loop from the vision doc's definition of success, running on real infrastructure instead of the mock replay engine.

Phase 1's mock does not get thrown away: it becomes one *producer* of the canonical event contract, and LiveKit becomes the other. The design playground survives as a permanent replay/demo mode.

## Architecture

```text
┌─ Next.js app ─────────────────────────────────────────────┐
│  /api/token  → mints access token, embeds explicit agent  │
│                dispatch, unique room per session          │
│  session UI  → stage-split surface driven by the event    │
│                contract (same reducer the mock drives)    │
└───────────────────────────────────────────────────────────┘
                     │ LiveKit Cloud (room)
┌─ Python agent worker (separate process, `lk agent dev`) ──┐
│  AgentSession                                             │
│    llm  = realtime speech-to-speech model (SWAPPABLE:     │
│           xai Grok Voice ↔ openai GPT Realtime)           │
│    stt  = openai.STT("gpt-live-transcribe") in parallel   │
│           → live Spanish interims/finals on               │
│             lk.transcription text streams                 │
│  side task: gpt-realtime-translate WebSocket              │
│           → live English translation text stream          │
│  on_user_turn_completed → semantic analyzer (fast LLM,    │
│           structured output) → tutor.corrections stream   │
│  RPC: pause/resume commands from frontend                 │
│  participant attributes: paused state, agent state        │
└───────────────────────────────────────────────────────────┘
```

## Model choices (and the swap requirement)

- **Core realtime model: swappable by config.** Grok Voice and GPT Realtime share OpenAI-typed config shapes; the worker reads a `TUTOR_REALTIME_MODEL` env/config value (`xai` | `openai`) and constructs the right plugin. A structured price/feel comparison between the two is an explicit deliverable of this phase's evaluation step — the scaffold must make switching a one-line (or zero-line, env-only) change. Reference per-minute costs (LiveKit calculator, 2026-08): GPT Realtime ≈ $0.068/min, GPT Realtime mini ≈ $0.022/min; Grok TBD in our comparison.
- **Live transcription: `gpt-live-transcribe`** ($0.017/min) as the AgentSession `stt=` plugin. Verified supported in `livekit-plugins-openai` source (ahead of the docs — pin a version that includes it and confirm at build time). Config: `language=["es","en"]` (code-switching is expected in a tutoring session), `prompt` describing the tutoring context. The realtime model's own `input_audio_transcription` is disabled so we get exactly one transcript stream.
  - *Known caveat:* interims are throttled to cumulative updates every ~500ms — captions cadence, not per-word. The stage-split word ticker renders arrivals in small bursts. If that feels bad in practice, Deepgram Nova-3 multilingual (~$0.006/min via LiveKit Inference, true word-level interims) is the fallback; the `stt=` slot makes this swap trivial too.
- **Live translation: `gpt-realtime-translate`** ($0.034/min). No LiveKit plugin exists — this is a custom side-task in the worker: subscribe to the learner's audio track, stream PCM16 to `wss://api.openai.com/v1/realtime/translations`, forward `session.output_transcript.delta` to the frontend as a text stream with a `language: "en"` attribute. We drop its audio output (nobody wants spoken English over the tutor). Tutor-speech translation can come from the same mechanism on the agent's output track, or be deferred (see open questions).
  - *Cost note:* the translate session also emits a source-language input transcript. If cost pressure appears, it could theoretically replace `gpt-live-transcribe` entirely (~$0.017/min saved), but the in-session `stt=` slot is what drives turn finalization plumbing and auto-published transcription streams, so v0 runs both (~$0.051/min for the pair) and treats consolidation as a later optimization.
- **Semantic analyzer: `gpt-5.6-luna`** ($0.20/$1.20 per 1M tokens, structured outputs supported), called from `on_user_turn_completed` as a background task with structured output matching the `Correction` schema. Independent of the voice pipeline; swappable.
  - *Critical config:* Luna is a reasoning model — at default effort its time-to-first-token is unusable for a per-utterance hot path. Call it with `reasoning: {effort: "none"}` (or `"minimal"`) and verify real latency (<~1.5s target) early in the build. The fixed correction-rubric system prompt benefits from Luna's 90% cached-input discount.
  - *Decision posture (2026-08-11):* start with Luna, take a call later. No published Spanish-grammar benchmarks exist for it, so once the pipeline works, run a small eval (gold set of learner utterances → correction accuracy, explanation quality, p95 latency) against 1–2 alternatives (Claude Haiku 4.5: predictable non-reasoning latency; Gemini flash-class: best measured TTFT) before locking in.

All keys/billing: LiveKit Cloud project, OpenAI API key, xAI API key. Yash provides these when build starts.

## Workstreams

### 1. Promote the event contract

Extract the stage-split mock schema into `lib/session/` as the canonical frontend contract:

- `Turn`, `Correction` (already well-shaped in `lib/design/mock-conversation.ts`), plus transcript events (`transcript.delta` / `transcript.final` with segment IDs, speaker, language), `analysis.complete` (corrections keyed by segment ID), `session.paused` / `session.resumed` (hold-set semantics, client-side), and agent state.
- The stage-split reducer consumes only this contract. Two producers: the mock replay engine (moved out of the design-inspo page into a reusable module) and the live LiveKit adapter (workstream 4).
- Segment IDs are the join key everywhere: LiveKit's `lk.segment_id` on transcription streams ↔ correction payloads ↔ translation lines.

### 2. Python agent worker (`agent/`)

- `AgentServer` + `@server.rtc_session(agent_name="tutor")`, current SDK (`livekit-agents` ≥1.6; the v1.5+ API surface only — no pre-1.5 patterns).
- Realtime model factory keyed off config (Grok ↔ GPT Realtime), parallel `gpt-live-transcribe` STT, LiveKit audio turn detector (`inference.TurnDetector()` — consistent behavior across both realtime models).
- Tutor system prompt v0, parameterized target/anchor language (nothing hardcoded-Spanish).
- Translation side-task (the `gpt-realtime-translate` WebSocket described above).
- Pause/resume RPC handlers: `session.interrupt()` + `session.input.set_audio_enabled(False)` + `clear_user_turn()` on pause; re-enable on resume; paused state mirrored via participant attributes so it survives reconnects.
- Analyzer hook: `on_user_turn_completed` → background LLM call → `send_text` JSON on `tutor.corrections` topic with the turn's segment ID attribute.
- Local dev via `lk agent dev` against the LiveKit Cloud project.

### 3. Next.js session plumbing

- `app/api/token/route.ts` (`livekit-server-sdk`): unique room per session (`lesson-{userId}-{ts}`), participant identity, explicit dispatch via `RoomAgentDispatch` in the token's room config.
- Client: `TokenSource.endpoint` → `useSession` / `SessionProvider`; env setup documented in README.

### 4. Wire the stage-split surface live

- A live adapter translating LiveKit primitives into contract events: `useTranscriptions` (interim/final Spanish), the `tutor.corrections` and translation text-stream handlers, `useAgent()` state, pause attributes.
- The real session page (promoted out of design-inspo; design-inspo pages remain as reference) renders the same stage-split UI from the same reducer.
- Real Aura: agent audio track into `AgentAudioVisualizerAura` replacing `MockAura`.
- Pause UX preserved exactly: hold-set stays client-side; any hold → one RPC "pause" to the agent; last hold released → "resume".

### 5. Analyzer v0

- Structured-output call against the existing `Correction` schema (span, replacement, category, severity, short explanation) with recent conversation context.
- Corrections render on the settled hero turn via the existing mark treatment.
- Prompt treats target/anchor languages as parameters.

### 6. Evaluate (closes the phase)

- The phase-1 leftover: things only real voice can settle — turn-taking feel, transcription cadence on the word ticker, translation lag realism, correction arrival timing, pause/resume feel mid-utterance.
- **Grok vs GPT Realtime comparison:** feel, latency, instruction-following (does it respect the language-mixing policy?), cost per 10-minute conversation. Recorded as a decision in the vision doc.
- Running cost check: full stack is roughly realtime model (+$0.02–0.07/min) + transcribe ($0.017) + translate ($0.034) + analyzer (negligible). Confirm the real number and whether translate earns its cost (see open questions).

## Open questions — resolved 2026-08-11 (Yash: "start with whatever feels cheap to get something working, optimize from there")

1. **Tutor-side translation:** learner-only in v0. Tutor translation ships later if the learner-side version earns it (would reuse the same pipeline on the agent's track).
2. **Translate-model latency vs turn-taking:** try `gpt-realtime-translate` as planned; if it lags or garbles short conversational turns, fall back to post-hoc translation of finalized turns by a cheap text model (loses the live-lag effect, keeps the toggle).
3. **Correction targets:** settled hero + history only in v0; pinned-context marks are a build-time UI detail.
4. **Analyzer model:** start with `gpt-5.6-luna` at `effort: "none"` (see Model choices); run the comparative eval only after the loop works end-to-end.

## Non-goals

Persistence, auth, session history storage, post-conversation coaching, pronunciation analysis, mobile, deployment hardening (worker runs locally via `lk agent dev` for this phase).

## Exit criteria

- The definition-of-success loop works end-to-end with real voice, reliably enough to demo.
- Realtime model swap is env-level; Grok vs GPT Realtime comparison done and recorded.
- Event contract is canonical: mock and live drive the identical UI.
- A written shortlist of UX findings that feed Phase 3 (polish/iteration priorities).

---

## Live evaluation findings (2026-08-12, ~8 live sessions)

The definition-of-success loop works: imperfect Spanish spoken, no verbal
interruption, quiet corrections after each settled turn, lagging English beside
the right sentences, and the tutor handling "¿cómo se dice helpful?" per the
language-mixing policy (brief answer, modeled form, conversation kept moving).

### Decisions settled by live testing

1. **Grok Voice support removed.** Its plugin cannot hand turn detection to the
   agent (`can_disable_turn_detection = False`), which forces a second,
   disagreeing turn clock and degrades transcript segmentation, translation
   binding, and the analyzer trigger. The planned A/B comparison is off until
   xAI ships agent-side turn detection; the worker is single-model
   (`gpt-realtime-2.1`, env-swappable to any OpenAI Realtime snapshot).
2. **One turn clock is the load-bearing architecture decision.** LiveKit's
   semantic turn detector owns endpointing for replies, transcripts, analyzer,
   and translation alike. Every session that violated this (STT-fallback
   endpointing, model-owned VAD) broke in a different way.
3. **Segments are not turns.** STT emits a segment per VAD phrase; a hesitant
   learner produces several per conversational turn. The reducer coalesces
   consecutive same-speaker segments; display normalizes casing at joins and
   strips filled pauses. Corrections merge per segment (replacement erased
   them — see `frontend/scripts/repro-corrections.ts`).
4. **Endpointing floors:** `min_delay` must outlast the STT flush (~0.5s) or
   late transcripts double-commit the turn and interrupt the reply. Running
   1.2s min / 6.0s max; learner-feel tuning stays env-level.
5. **Reasoning models in the hot path get minimal effort** (both the realtime
   model and the Luna analyzer). Higher effort surfaces as spoken stall
   phrases ("déjame pensar…") — the model narrating its own latency.
6. **Analyzer works and is fast enough:** gpt-5.6-luna at effort "none",
   0.7–4.4s observed (first call cold), 0–4 corrections per turn, quality
   subjectively good. The comparative eval (Haiku 4.5 / Gemini flash) remains
   optional, not urgent.
7. **Translate endpoint realities:** rejects unknown session fields (a
   rejected update silently discards the whole payload including output
   language); sends one endless stream (no item ids, no done events). The
   frontend routes arriving text to the live learner turn by time, with a 2s
   post-final grace window.

### Known issues carried to phase 3

- **Translation segmentation/attribution is the weakest link.** Sentence
  boundaries drift, mishearings occur, and arrival-time routing occasionally
  splits a turn's translation. ~~The structural fix is worker-side
  attribution~~ **Superseded (same day): phase 3 removes live translation
  entirely in favor of select-to-translate — see
  `phase-3-comprehension-on-demand.md`.**
- **Afterthought turns:** a learner completing a thought after the turn
  committed ("…para ayudar" → "Las clases.") renders as a separate turn and
  the tutor answers the fragment. Open product question: should afterthoughts
  merge and revise?
- **Tutor-side translation** still absent (learner-only v0, by decision).
- **STT stray-script leakage** (Japanese/Thai chars for Spanish-sounding
  syllables) reduced by prompt but not eliminated.
- **UI polish debt:** tutor text renders slightly ahead of/behind voice at
  times; history-peek a11y (dialog semantics); correction popover motion.
- **Deployment:** worker runs via `python src/agent.py dev` locally; `lk agent`
  CLI setup and cloud deploy are untouched.

### Exit criteria status

- Loop works end-to-end live: **yes**.
- Model swap env-level: **yes** (within OpenAI Realtime snapshots); Grok
  comparison: **cancelled with cause, documented above**.
- Contract canonical, mock and live drive identical UI: **yes** (mock verified
  after every refactor).
- UX findings shortlist for phase 3: **this section**.
