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
  └─ RPC tutor.pause / tutor.resume    → hold, then conversational re-entry

the session clock (authoritative)
  ├─ every 30s                         → tutor.minutes_left
  ├─ ~60s left                         → wrap-up brief to the tutor
  └─ zero                              → goodbye, tutor.session_over, disconnect
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
- **The worker owns the clock.** Minutes are money; the browser never decides
  when a session ends. The worker meters wall time, publishes what is left, and
  ends the session itself. See "The session clock".
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
| `src/state.py`     | Pause state (+ what it interrupted) and rolling session facts  |
| `src/plan.py`      | Dispatch metadata: minutes budget, user, and the session plan   |
| `src/clock.py`     | The authoritative session clock + the minutes-billed seam       |

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
TUTOR_REALTIME_MODEL=gpt-realtime-2.1-mini
TUTOR_REALTIME_REASONING=low           # minimal | low — see config.py
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

## Dispatch metadata

The agent is *explicitly dispatched*: the frontend's `/api/token` route attaches
a `RoomAgentDispatch` for the `tutor` agent, and its `metadata` is one JSON
string carrying everything the worker needs to know about *this* session:

```json
{
  "max_minutes": 15,
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
`src/plan.py`: an absent, empty, or unparseable payload runs a 15-minute session
with no plan, and wrong-typed fields are dropped rather than fatal.
`max_minutes` is clamped to 1–120; plan strings are whitespace-collapsed,
length-capped, and deduplicated.

The plan feeds three consumers, and each reads it differently:

| Consumer                | What it does with the plan                                    |
| ----------------------- | ------------------------------------------------------------- |
| `tutor_instructions`    | A "this session" block: steer towards the topic/scenario, use and elicit the focus forms, work the vocab in — never announced, never a drill. An empty plan asks the tutor to suggest something light itself. |
| `greeting_instructions` | With a scenario, the tutor opens *inside* it (it plays its side of the scene lightly); with a topic, it opens on the topic; otherwise the standing greeting. |
| `analyzer_instructions` | A focus note: weight corrections towards the focus tenses and vocab, still report clear errors elsewhere. The scenario is deliberately excluded — it tells the tutor who to be, not the analyzer what to look at. |

Tense names and vocab themes are opaque strings chosen by the frontend for the
configured target language and passed straight through. Nothing here is
Spanish-specific.

## The session clock

The worker's clock is authoritative (phase 4, WS2 — the frontend displays the
number, it never computes it). `src/clock.py` runs plain wall time from session
start:

| Moment                          | What happens                                                |
| ------------------------------- | ----------------------------------------------------------- |
| session start (greeting requested) | `tutor.minutes_left` published; the clock starts          |
| every 30s                       | `tutor.minutes_left` republished (whole minutes, rounded up) |
| ~60s left                       | A situation brief through the same seam as the resume brief: "about one minute of session time left, bring it to a natural close" — facts, not a script, and it never mentions the clock to the learner |
| ~60s left **while paused**      | The brief is *held* and delivered on `tutor.resume` instead — nobody hears a wrap-up into a muted session |
| zero                            | `session.interrupt()`, one short bilingual goodbye (exact-output instruction, like the resume bridge), and the worker waits for it to finish playing |
| after the goodbye               | `tutor.session_over` = `"true"`, `session.aclose()`, then `ctx.shutdown()` — the learner keeps the room and their post-session surface |

**Pause time is billed.** The session is live and the agent is allocated whether
or not the learner is talking, so the clock never stops (product decision,
2026-08-20 — say so in the UI, revisit if it feels unfair). Each transition
fires exactly once: the warning cannot repeat, and the end sequence cannot run
twice.

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
  "correction": { "original": "yo fue", "replacement": "yo fui", "category": "tense" }
}
```

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

The brief states facts only — hold duration, hold reasons, the inspected
correction, whether the tutor was mid-reply, and one line of rolling session
facts ("corrections shown to them so far this session: 3 tense, 1 word-order").
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
uv run ruff check src
uv run ruff format src
```
