# Tutor agent worker

The Python [LiveKit Agents](https://docs.livekit.io/agents/) worker behind the
conversation surface. It runs as its own process — not inside Next.js — and
talks to the frontend over a LiveKit room.

Read `plans/product-vision.md` and `plans/phases/phase-3-comprehension-on-demand.md`
before changing behaviour here.

## What it does

```text
learner audio
  ├─ GPT Realtime (speech-to-speech)   → the tutor's voice          (model via TUTOR_REALTIME_MODEL)
  ├─ openai.STT("gpt-live-transcribe") → live transcripts           (lk.transcription)
  └─ on_user_turn_completed            → background analyzer        (tutor.corrections)

on demand
  ├─ RPC tutor.translate               → one selected span, translated
  ├─ RPC tutor.ask                     → one question, one coaching answer
  ├─ RPC tutor.review                  → this session's study material
  └─ RPC tutor.pause / tutor.resume    → hold, then conversational re-entry

the study surface (while held — voice is idle and unbilled)
  ├─ at session start                  → review material generated once
  └─ per question                      → Luna, coaching persona, invisible cap

the session clock (authoritative)
  ├─ every tick                        → active seconds → the session arc
  ├─ every 30s                         → tutor.minutes_left
  ├─ ~60s left                         → wrap-up brief to the tutor
  └─ zero                              → goodbye, tutor.session_over, disconnect

the session arc (1/4/4/1 of the budget)
  └─ each phase boundary               → Agent.update_instructions() (never an interruption)
```

Design rules worth keeping:

- **The analyzer never blocks the tutor.** `on_user_turn_completed` fires a
  background task and returns immediately.
- **Translation is on demand only.** There is no translation stream. The learner
  selects settled text, the frontend calls `tutor.translate`, and one
  request/response call to the analyzer's text model answers it. (The ambient
  translation socket was deleted in phase 3: the learner cannot read the anchor
  language while producing the target one, and it was the flakiest, costliest
  subsystem in every live session.)
- **Wire strings live in `config.py`.** Topics, attributes and RPC names are
  constants there and must byte-match `frontend/lib/session/protocol.ts`.
- **One transcript stream.** The realtime model's own input transcription is
  disabled; the parallel `stt=` plugin owns every transcript the UI shows.
- **One turn clock.** The realtime model runs with `turn_detection=None`;
  LiveKit's semantic turn detector owns endpointing for replies, transcripts,
  and the analyzer alike. (This is why Grok Voice support was dropped: its
  plugin cannot hand over turn detection, forcing a second, disagreeing turn
  clock. See config.py.)
- **Resume is conversational, not a tape deck.** A realtime model cannot resume
  a truncated reply mid-word, so it doesn't try: the worker hands it a short
  factual brief and lets it re-enter with judgment. See "Pause semantics".
- **Facts are stated, never scripted.** Resume briefs say what happened and
  remind the model of its standing instructions. They never contain the line to
  say — that lives in `TUTOR_INSTRUCTIONS` as policy.
- **The worker owns the phase, not the model.** The arc advances on the
  clock's active seconds and lands as an instruction update, so a phase change
  never interrupts a turn and the model never decides for itself that the
  role-play has started. See "The session arc".
- **The worker owns the clock.** Minutes are money; the browser never decides
  when a session ends. The worker meters active (unheld) time, publishes what
  is left, and ends the session itself. See "The session clock".
- **Study is text; speech is metered.** The pause tabs (Transcript / Review /
  Ask) run entirely on the cheap text model while the realtime model sits idle
  and the clock is stopped. What returns to the voice model on resume is a
  ≤2-line brief — never the Ask thread, never the material.
- **Conjugation tables are shipped, never generated.** A model that invents a
  paradigm teaches a wrong ending and nobody in the loop would catch it. See
  "The Review tab".
- **No hardcoded Spanish.** Target and anchor languages are parameters. That
  includes the session plan: tense names and vocab themes are opaque strings
  from the frontend.

## Layout

| File               | Role                                                          |
| ------------------ | ------------------------------------------------------------- |
| `src/agent.py`     | Entrypoint: `AgentServer`, session wiring, pause/resume RPC    |
| `src/config.py`    | Env config + the realtime-model factory                        |
| `src/prompts.py`   | Tutor / STT / analyzer / translate / resume prompts            |
| `src/analyzer.py`  | Background structured-output corrections + shared turn context |
| `src/translate.py` | `tutor.translate` RPC: one selected span → one translation     |
| `src/ask.py`       | `tutor.ask` RPC: the Ask tab's coaching chat + its invisible cap |
| `src/review.py`    | `tutor.review` RPC: the Review tab's material, made once       |
| `src/conjugation/` | The deterministic conjugation engine (registry + `es`)         |
| `src/state.py`     | Pause state (+ what it interrupted) and rolling session facts  |
| `src/plan.py`      | Dispatch metadata: minutes budget, user, and the session plan   |
| `src/clock.py`     | The authoritative session clock + the minutes-billed seam       |
| `src/arc.py`       | The session arc: phase windows, scenario beats, phase changes    |

## Setup

Requires Python 3.10–3.13 and [uv](https://docs.astral.sh/uv/).

```shell
uv sync
```

Environment lives in `backend/.env.local` (gitignored, loaded by `agent.py`):

```shell
# required
LIVEKIT_URL=wss://<project>.livekit.cloud
LIVEKIT_API_KEY=...
LIVEKIT_API_SECRET=...
OPENAI_API_KEY=...          # realtime model, STT, analyzer, translate

# optional — defaults shown
TUTOR_TARGET_LANG=es
TUTOR_ANCHOR_LANG=en
TUTOR_REALTIME_MODEL=gpt-realtime-2.1
TUTOR_REALTIME_REASONING=minimal           # minimal | low — see config.py
TUTOR_REALTIME_SPEED=1.0               # output audio speed multiplier
TUTOR_REALTIME_VOICE=marin
TUTOR_MIN_ENDPOINT_S=1.2            # must outlast the STT flush lag (~0.5s)
TUTOR_MAX_ENDPOINT_S=6.0            # patience for a learner mid-word-search
TUTOR_STT_MODEL=gpt-live-transcribe
TUTOR_ANALYZER_MODEL=gpt-5.6-luna
TUTOR_ANALYZER_ENABLED=true
TUTOR_TRANSLATE_MODEL=gpt-5.6-luna
```

`TUTOR_ANALYZER_ENABLED=false` is published to the frontend as the
`tutor.analyzer` attribute, so the UI skips the analyzing phase rather than
waiting for corrections that will never arrive. It does **not** disable
`tutor.translate`, which owns its own client for exactly that reason.

`TUTOR_REALTIME_MODEL` takes any OpenAI Realtime model id (e.g. a pinned
snapshot); any `gpt-realtime-2*` id gets `reasoning.effort` from `TUTOR_REALTIME_REASONING`.

## Run

```shell
lk agent dev          # dev mode against the LiveKit Cloud project
```

`lk` is the [LiveKit CLI](https://docs.livekit.io/agents/start/voice-ai/#livekit-cli)
(`winget install LiveKit.LiveKitCLI`), authenticated once with `lk cloud auth`.
Equivalent without the CLI:

```shell
uv run python src/agent.py dev       # dev
uv run python src/agent.py console   # terminal-only, no frontend needed
uv run python src/agent.py start     # production mode
```

The agent registers under the dispatch name **`tutor`** and is *explicitly
dispatched* — it only joins rooms whose token carries a matching
`RoomAgentDispatch`. The frontend's `/api/token` route must set this, or the
agent will never join.

## Frontend contract

| Channel                                  | Carries                                                        |
| ---------------------------------------- | -------------------------------------------------------------- |
| `lk.transcription` (text stream, SDK)    | Interim + final transcripts, both speakers                      |
| `tutor.corrections` (text stream)        | One JSON `analysis.complete` payload per settled learner turn   |
| `tutor.paused` (participant attribute)   | `"true"` / `"false"`                                            |
| `tutor.analyzer` (participant attribute) | `"on"` / `"off"` — whether corrections are enabled at all       |
| `tutor.minutes_left` (participant attribute) | Whole minutes remaining, as a string — the balance pill's only source |
| `tutor.session_over` (participant attribute) | `"true"` once the clock ended the session and the goodbye finished |
| `lk.agent.state` (participant attribute) | Agent state, published by the SDK                               |
| RPC `tutor.pause` / `tutor.resume`       | Frontend → worker, one logical call per state change (retries are idempotent) |
| RPC `tutor.translate`                    | Frontend → worker, one selected span → its anchor translation   |
| RPC `tutor.ask`                          | Frontend → worker, one learner question → one coaching answer   |
| RPC `tutor.review`                       | Frontend → worker, a poll for this session's study material     |

Corrections payload:

```json
{
  "type": "analysis.complete",
  "turnId": "item_...",
  "text": "Ayer yo fue al supermercado",
  "language": "es",
  "corrections": [
    {
      "id": "c_1a2b3c",
      "original": "yo fue",
      "replacement": "yo fui",
      "category": "tense",
      "severity": "error",
      "explanation": "\"Ir\" in the first-person preterite is \"fui\"."
    }
  ]
}
```

`category` and `severity` mirror `CorrectionCategory` / `CorrectionSeverity` in
`frontend/lib/design/mock-conversation.ts`. Keep them in sync. Corrections whose
`original` is not an exact substring of the utterance are dropped worker-side,
so the frontend can highlight by plain substring match.

`tutor.translate` payloads:

```json
// request
{ "text": "no me acuerdo", "speaker": "learner", "turn_id": "item_..." }
// response — one or the other, never both
{ "translation": "I don't remember" }
{ "error": "translation timed out" }
```

`speaker` is `"learner"` or `"tutor"`; `turn_id` is optional and used only for
logging. The span is target-language text and the translation comes back in the
anchor language. The worker budgets 4s (the frontend times out at 5s) and every
worker-side failure is an `error` field. Transport failures (RPC timeout,
no tutor connected) reject the RPC itself — the frontend handles both.

## The study surface: Ask and Review

The pause overlay's tabs (phase 4, WS4c). Both are text-only and both run while
the session is held — the realtime model is idle and the clock is stopped, so
studying costs the learner nothing and costs us pennies. Neither ever speaks:
what reaches the voice model is the resume brief, and only the resume brief.

### `tutor.ask` — the coach

```json
// request — the CLIENT owns the thread; the worker keeps nothing
{
  "question": "why is it fui and not fue?",
  "turn_id": "item_...",
  "history": [
    { "role": "learner", "text": "how do I say I went?" },
    { "role": "coach", "text": "..." }
  ]
}
// response — one shape, plus the cap flag
{ "answer": "..." }
{ "answer": "...", "limit": true }
{ "error": "ask timed out" }
```

Luna answers through the Responses API at `reasoning.effort: none`, in the
anchor language, with short target-language examples. Its context is the session
plan, the current arc phase, `SessionFacts.summary()`, the last ~10 turns of the
spoken conversation, and the client-sent thread (last 16 messages, re-trimmed
worker-side because it is untrusted input on its way into a prompt).

**The coaching rule** — the whole reason the tab is its own module and its own
prompt (`ASK_INSTRUCTIONS`): the coach explains and scaffolds, it does not
ghostwrite.

- Explain the pattern or the distinction, then at most one short example — and
  a different sentence from the one the learner is about to say.
- Make them try first: most answers end in a small, concrete invitation ("how
  would you start it?", "what would the yo form be?").
- Hand over a whole finished sentence only when they ask outright, or when they
  have already tried and want to compare. Otherwise: the verb, the tense, the
  frame with the gap left in it.
- Push back on "just tell me" once, warmly, then give it and move on — this is a
  study surface, not a standoff.
- **Never write the learner's next spoken turn.** They are about to say it out
  loud; that is the session.
- ≤ ~120 words, plain prose, no markdown.

**Invisible caps.** 25 answered questions per session. Past that the tab does
not error and does not grey out: it returns a warm one-line redirect back to
speaking with `"limit": true`, and the client renders it as the answer it is.
The redirect is picked from a static list rather than generated — the point of a
cap is not paying for the request — and never repeats twice running. Only a real
answer spends one of the 25; a timeout or a failure does not.

The worker budgets 4.5s (the frontend times out at 5s, `ASK_TIMEOUT_MS`) and
every worker-side failure is an `error` field, never a raise.

### `tutor.review` — the material

```json
// request
{}
// response — poll until ready; a session's material is made once and never changes
{ "ready": false }
{
  "ready": true,
  "vocab":   [{ "target": "la cuenta", "anchor": "the bill" }],
  "phrases": [{ "target": "¿Qué me recomienda?", "anchor": "What do you recommend?" }],
  "tables":  [{ "verb": "querer", "tense": "Preterite · pretérito",
                "rows": [{ "person": "yo", "form": "quise" }] }]
}
```

Generation starts in the background immediately after session start, so the
first Review open is usually instant. `ready: false` always means "poll again",
never an error.

`vocab` (~12) and `phrases` (~8) are generated once by Luna as strict JSON for
the plan's scenario, topic and vocab themes. **`tables` are not generated at
all** — they come from `src/conjugation/`, a shipped engine:

- A registry keyed by language code (`conjugation/tables_for`); only `es` is
  implemented, and nothing above the engine module knows a word of Spanish.
- Regular -ar/-er/-ir paradigms for present, preterite, imperfect, future,
  conditional, present subjunctive and present perfect, plus the orthographic
  fixes an -ar verb needs before a front vowel (`llegar` → `llegué`).
- Hand-written overrides for the 25 highest-frequency irregular verbs, each
  supplying only the cells that are actually irregular.
- Tables returned = the plan's focus tenses × 3–4 verbs chosen from a small
  scenario→verbs map (generic fallback: ser/estar/tener/hacer), with the width
  shrinking as the focus widens so every form the learner picked is represented.
  `commands` has a different person set and is dropped rather than guessed at.

If the generated half fails or times out, the material still resolves — with the
tables alone, which cannot fail. A tab that polls forever is the worse outcome.

The engine is checked in `tests/test_conjugation.py`: every regular paradigm and
every irregular override, spot-checked against reference forms.

## Dispatch metadata

The agent is *explicitly dispatched*: the frontend's `/api/token` route attaches
a `RoomAgentDispatch` for the `tutor` agent, and its `metadata` is one JSON
string carrying everything the worker needs to know about *this* session:

```json
{
  "max_minutes": 10,
  "user_id": "user_2abc...",
  "plan": {
    "topic": "last weekend",
    "scenario": "ordering at a restaurant",
    "tenses": ["preterite", "imperfect"],
    "vocab": ["food", "travel"],
    "level": "early intermediate"
  }
}
```

Every field is optional and the whole payload is parsed defensively in
`src/plan.py`: an absent, empty, or unparseable payload runs a 10-minute session
with no plan, and wrong-typed fields are dropped rather than fatal.
`max_minutes` is clamped to 1–120; plan strings are whitespace-collapsed,
length-capped, and deduplicated.

The plan feeds four consumers, and each reads it differently:

| Consumer                | What it does with the plan                                    |
| ----------------------- | ------------------------------------------------------------- |
| `tutor_instructions`    | A "this session" block: steer towards the topic/scenario, use and elicit the focus forms, work the vocab in — never announced, never a drill. An empty plan asks the tutor to suggest something light itself. |
| `arc.py` (the session arc) | Picks the scene's beats from the scenario (or the topic, or a generic fallback) and names the situation in every phase brief. |
| `greeting_instructions` | With a scenario, the tutor opens *inside* it (it plays its side of the scene lightly); with a topic, it opens on the topic; otherwise the standing greeting. |
| `analyzer_instructions` | A focus note: weight corrections towards the focus tenses and vocab, still report clear errors elsewhere. The scenario is deliberately excluded — it tells the tutor who to be, not the analyzer what to look at. |

Tense names and vocab themes are opaque strings chosen by the frontend for the
configured target language and passed straight through. Nothing here is
Spanish-specific.

## The session arc

Straight role-play for a whole session is bad pedagogy, and a realtime model
asked to sustain one rambles to fill the time. So a session is a gradual
release through four phases, proportioned **1 / 4 / 4 / 1** of `max_minutes`
(a two-minute test session walks all four in the same proportions):

| Phase       | Share | Language                                     | What the tutor does                                                                 |
| ----------- | ----- | -------------------------------------------- | ----------------------------------------------------------------------------------- |
| **frame**   | 1     | anchor (one modelled target-language line)   | Name the situation and the focus form in a sentence or two, model ONE example, invite ONE try. Applied, never a lecture. |
| **guided**  | 4     | bilingual, exactly split                      | Hand ONE intent in the anchor language ("tell the waiter you'd like the soup"), the learner produces the target language, the tutor answers in character. "Doing bits together." |
| **scene**   | 4     | target (anchor only as a short bridge)        | The role-play for real, played through BEATS with natural ends. Entry by consent. The in-scene rule from the plan block applies: be the person, say only their line. |
| **debrief** | 1     | anchor                                        | Two things that went well, one thing to remember, drawn from `SessionFacts.summary()`. No goodbye — that is the clock's. |

Mechanics, all in `src/arc.py`:

- **Time-driven, on ACTIVE time.** The clock's `on_tick` hands the arc its
  active (unheld) seconds each tick — one elapsed for billing and for the arc,
  so they cannot drift. Paused time advances neither.
- **Transitions are instruction updates.** A boundary rewrites the standing
  prompt's `CURRENT PHASE` block via `Agent.update_instructions()`, which does
  not interrupt an in-flight turn: the model picks the new phase up on its next
  one. Nothing is spoken to force a transition.
- **Paused at a boundary defers.** The phase change is held and applied on
  `tutor.resume`, immediately before any re-entry line — the same deferral the
  clock uses for its wrap-up brief.
- **Consent lives in the brief, not the worker.** The worker cannot hear the
  learner say "yes", so the gated phases' briefs carry the whole gate: ask if
  they are ready; if yes, begin; if they want to skip ahead, skip; if they want
  to stay, stay a little and move on.
- **The arc is a guide, never a lock.** Every brief — and the standing
  instructions — tell the tutor to follow a learner who asks a question,
  switches language, skips ahead, or wanders off, including mid-scene, and to
  come back when it is natural.
- **Beats are backend-side**, keyed by the scenario strings in
  `frontend/lib/session/plan.ts`. Language-neutral English descriptions the
  model renders in the target language; an unknown scenario or a free-text
  topic falls back to a generic three-beat arc (open → develop → close).

Each transition logs `arc phase` with the phase name and the active seconds, so
the arc is visible in live logs.

The greeting is the frame phase's opener: it keeps its own all-English rule
(hardened after a live failure — see `GREETING_*` in `prompts.py`), and the
frame's example-and-one-try follows in the turns after it. At the other end the
debrief hands off to the clock: it says what went well and stops, and the
wrap-up brief and the exact-output goodbye close the session.

## The session clock

The worker's clock is authoritative (phase 4, WS2 — the frontend displays the
number, it never computes it). `src/clock.py` runs plain wall time from session
start:

| Moment                          | What happens                                                |
| ------------------------------- | ----------------------------------------------------------- |
| session start (greeting requested) | `tutor.minutes_left` published; the clock starts          |
| every tick                      | The active elapsed seconds go to `on_tick` — the session arc rides on them |
| every 30s                       | `tutor.minutes_left` republished (whole minutes, rounded up) |
| ~60s left                       | A situation brief through the same seam as the resume brief: "about one minute of session time left, bring it to a natural close" — facts, not a script, and it never mentions the clock to the learner |
| ~60s left **while paused**      | The brief is *held* and delivered on `tutor.resume` instead — nobody hears a wrap-up into a muted session |
| zero                            | `session.interrupt()`, one short bilingual goodbye (exact-output instruction, like the resume bridge), and the worker waits for it to finish playing |
| after the goodbye               | `tutor.session_over` = `"true"`, `session.aclose()`, then `ctx.shutdown()` — the learner keeps the room and their post-session surface |

**Pause time is not billed.** The clock accrues only while the session is not
held — a learner studying a correction is not spending minutes (decision
2026-08-20, reversing the earlier 'pause billed' call).

At teardown — clock, learner leaving, or a crash — the worker calls
`report_minutes_billed(user_id, minutes, room)` with the actual minutes used,
rounded up. Today that only logs `session minutes billed`; it is the seam for
the signed internal debit endpoint on the Next.js app, which will be the only
writer of ledger debit rows. Credit pricing and the economics behind
`max_minutes` live in `plans/phases/phase-4-sellable-sessions.md`.

## Pause semantics

The *set of holds* (explicit control, correction inspection, select-to-translate,
history scroll) is client-side state. The frontend collapses it and calls
`tutor.pause` once when the set becomes non-empty and `tutor.resume` once when it
empties. Holds that open and close within ~400ms are debounced client-side and
never reach the worker at all.

Pause is non-destructive: the worker interrupts the tutor and disables audio in
and out, but deliberately does not `clear_user_turn()` — a hold opened
mid-utterance must not discard what the learner already said.

`tutor.resume` carries an optional brief:

```json
{
  "held_ms": 12400,
  "reasons": ["correction"],
  "correction": { "original": "yo fue", "replacement": "yo fui", "category": "tense" },
  "tab": "ask",
  "asks": ["why is it fui and not fue?"]
}
```

`tab` (`"transcript"` | `"review"` | `"ask"` | null) and `asks` are the study
surface's contribution, and they are the whole of it: the tab that was open when
the hold released, and the questions asked during *this* hold, oldest first,
capped at 5 and length-capped worker-side. **The answers never travel** — what
returns to the voice model is a brief, never the Ask transcript (vision doc,
2026-08-20 #4). They render as at most two extra fact lines ("they were in the
Review tab"; `they asked: "…", "…"`), and a hold with questions counts as
*studied* for template selection, exactly as an inspected correction does: both
mean there is a specific thing a comprehension check can land on.

Every field is optional and the whole payload is parsed defensively; an empty,
absent, or unparseable payload simply resumes with no brief. With a brief, the
worker composes a short factual situation brief and calls `generate_reply` —
but **only** if the hold actually interrupted the tutor. That decision is read
off the session at pause time:

| Session state at pause                   | On resume                                     |
| ---------------------------------------- | --------------------------------------------- |
| `user_state == "speaking"`               | Silent — the learner keeps the floor           |
| `agent_state == "speaking"` (or a live `current_speech`) | Re-enters: the tutor was mid-sentence |
| `agent_state == "thinking"`              | Re-enters: a committed turn's reply was killed |
| anything else                            | Silent                                         |

The brief states facts only — hold duration, hold reasons, the study tab, the
inspected correction, the questions asked, whether the tutor was mid-reply, and
one line of rolling session facts ("corrections shown to them so far this session: 3 tense, 1 word-order").
It never scripts a line; how to re-enter is `TUTOR_INSTRUCTIONS`' job.

`SessionFacts` (`src/state.py`) is the seam for that last line: the analyzer
reports its *published* corrections into it and it renders one summary. Future
sources (prior-session summaries, a reflection agent, goal tracking) plug into
the same object. It is evidence that is *observed*, deliberately separate from
the phase-4 learner profile, which is configuration that is *set*.

The resume response is `{"paused": false, "resumed": <bool>}`, where `resumed`
reports whether a re-entry reply was *requested* — generation is
fire-and-forget; completion is not awaited or reported.

## Checks

```shell
uv run python -m compileall -q src
uv run ruff check src tests
uv run ruff format src tests

# the conjugation engine — pytest if it is installed, a plain script otherwise
uv run python tests/test_conjugation.py
```
