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

the goal (the session's spine)
  ├─ before the first word             → pre-seeded from the plan, deterministically
  ├─ the opening exchange              → restate + confirm, or ask; one exchange
  ├─ set_session_goal (function tool)  → the confirmed goal, silently
  ├─ no tool call by the 3rd turn      → one Luna extraction from the transcript
  └─ when it lands                     → standing instructions, analyzer focus,
                                         Review, tutor.goal, the ledger

the study surface (while held — voice is idle and unbilled)
  ├─ when the goal lands               → review material generated from it
  ├─ at a hold, 3+ new learner turns    → regenerated from the transcript
  ├─ every new snapshot                → tutor.review_version rises (push, not poll)
  └─ per question                      → Luna, coaching persona, invisible cap

the session clock (authoritative)
  ├─ first tutor audio frame           → the clock starts (never before)
  ├─ every 5s unheld, and on every hold/resume → tutor.elapsed_s / tutor.remaining_s
  ├─ every 60 active s                 → periodic debit (a killed worker still bills)
  ├─ 30s left                          → nudge brief to the tutor (finish the thought)
  ├─ zero                              → debit, then HOLD (tutor.out_of_minutes) — no ending
  ├─ resume while held at zero         → re-read the balance; continue, or stay held
  ├─ learner's participant leaves      → hold + debit, 60s grace, then shutdown
  ├─ any hold older than TUTOR_HOLD_IDLE_S → tutor.session_over, disconnect
  ├─ realtime model dies unrecoverably → tutor.error="model", hold, debit, end
  └─ 10 min abandoned at zero          → tutor.session_over, disconnect

teardown (the shutdown callback, every step guarded)
  ├─ final debit ("final": true, "reason") → Convex sets endedAt
  ├─ POST /tutor/summary               → about + transcript + review + corrections
  │                                      + goal + turns + anchorRatio + asks + lookups
  │                                      + estCostUsd (what it cost US to run)
  └─ usage summary                     → tokens, talk share, estimated cost (log)
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
- **The tutor has ONE standing instruction block.** The timed session arc
  (frame / guided / scene / debrief) was deleted 2026-08-24: phases riding on
  elapsed seconds could not see whether the learner had produced a sentence, so
  consent had to be written into every brief — four English consent gates in the
  first 90 seconds. The tutor now opens in the target language with one question
  and supports on evidence. `Agent.update_instructions()` survives as a seam.
- **The worker owns the clock.** Minutes are money; the browser never decides
  when the time runs out. The worker meters active (unheld) time, publishes what
  is spent and what is left, and holds the session at zero. See "The session
  clock".
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
| `src/review.py`    | `tutor.review` RPC: the Review tab's material, from the goal + transcript |
| `src/goal.py`      | The session's goal: the extraction safety net and the fan-out  |
| `src/conjugation/` | The deterministic conjugation engine (registry + `es`)         |
| `src/state.py`     | Pause state (+ what it interrupted), the `SessionGoal`, rolling session facts |
| `src/plan.py`      | Dispatch metadata: the balance, the user, and the session plan  |
| `src/clock.py`     | The authoritative session clock + the seconds-billed seam       |
| `src/billing.py`   | The Convex ledger's client: `/tutor/debit`, `/tutor/balance`, `/tutor/summary` |
| `src/summary.py`   | The after-session record: the `about` line, the transcript, the Review snapshot |
| `src/usage.py`     | Per-session token/dollar accounting: the log line and `estCostUsd` |

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
CONVEX_SITE_URL=https://<deployment>.convex.site   # the ledger's HTTP actions
CLERK_WORKER_MACHINE_SECRET_KEY=ak_...   # mints the M2M token for /tutor/*

# optional — defaults shown
TUTOR_TARGET_LANG=es
TUTOR_ANCHOR_LANG=en
TUTOR_GOAL_LANG=target              # target | anchor — the opening goal exchange
TUTOR_REALTIME_MODEL=gpt-realtime-2.1
TUTOR_REALTIME_REASONING=minimal           # minimal | low — see config.py
TUTOR_REALTIME_SPEED=1.0               # output audio speed multiplier
TUTOR_REALTIME_VOICE=marin
TUTOR_MIN_ENDPOINT_S=1.2            # must outlast the STT flush lag (~0.5s)
TUTOR_MAX_ENDPOINT_S=3.0            # patience for a learner mid-word-search
TUTOR_STT_MODEL=gpt-live-transcribe
TUTOR_ANALYZER_MODEL=gpt-5.6-luna
TUTOR_ANALYZER_ENABLED=true
TUTOR_TRANSLATE_MODEL=gpt-5.6-luna
TUTOR_HOLD_IDLE_S=600               # any hold this long ends the session
TUTOR_ALLOW_UNMETERED=0             # local development ONLY — see below
TUTOR_ENV=                          # set to `production` on the prod worker
CLERK_API_URL=https://api.clerk.com # only for a Clerk instance on another host
```

`TUTOR_ENV` is a free string and only `production` means anything. Set it on
the production worker and nowhere else: with it set, `TUTOR_ALLOW_UNMETERED`
makes `TutorConfig.from_env()` raise `UnmeteredProductionError` and the worker
**refuses to boot**. Without it, a worker that holds a machine key
(`CLERK_WORKER_MACHINE_SECRET_KEY`) — i.e. one that can debit a real ledger —
logs one warning at boot that its environment is undeclared. Explicit over heuristic (phase 7):
dev and prod share LiveKit Cloud and a `*.convex.site` host, and a Clerk
machine key carries no test/live marker, so nothing here can be inferred.

`TUTOR_GOAL_LANG` picks the language of the opening goal exchange and nothing
else: `target` (the default — the vision doc's rule is that the conversation
opens in the target language) or `anchor`. The standing one-anchor-line
allowance applies either way, so a learner who stalls on the first question
still gets help. It exists so a later "which language" card can flip it without
a prompt change; there is no language picker now.

`OPENAI_API_KEY` is asserted non-empty at config load: the worker refuses to
start rather than failing inside a plugin mid-session. `TUTOR_MIN_ENDPOINT_S`
and `TUTOR_MAX_ENDPOINT_S` warn and fall back to their defaults on an
unparseable or out-of-range value, exactly like `TUTOR_REALTIME_SPEED` — as
does `TUTOR_HOLD_IDLE_S` (bounded 60s–4h, default 600).

**Metering fails closed** (audit B10, 2026-08-25). A job dispatched with a
`user_id` and no reachable ledger — `CONVEX_SITE_URL` or
`CLERK_WORKER_MACHINE_SECRET_KEY` unset, or the opening balance read failing —
is **refused**: an error log, then
`ctx.shutdown()`. It used to fail open, which meant one wrong variable in
production gave every learner unlimited free sessions and nothing paged.
`TUTOR_ALLOW_UNMETERED=1` overrides that (a warning per session, nothing
billed) and belongs nowhere but a laptop. A job with **no** `user_id` is a
different case entirely — the worker run straight from the CLI, with no token
route in front of it — and still meters against the dispatched `balance_s`.

The opening balance read is also where the budget comes from: `balanceSeconds`
as read at job start beats the `balance_s` the token route signed into dispatch
metadata minutes earlier, and metadata is only the fallback. It is also the
job's first ledger call, so it is what mints the M2M token — and it is
deliberately **outside** the debit failure ceiling below, because a failure
here already refuses the whole job.

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

**Deprecated:** `uv run python src/agent.py dev | console | start` still works
(it is the same `agents.cli` entrypoint) but is no longer the supported form —
`lk agent dev` is what the deploy path and the LiveKit tooling assume.
`console` has no `lk` equivalent, so keep that one for a terminal-only smoke
test and nothing else.

Tests:

```shell
uv run pytest -q                     # the whole suite
uv run python tests/test_clock.py    # any file, standalone, no pytest needed
```

The agent registers under the dispatch name **`tutor`** and is *explicitly
dispatched* — it only joins rooms whose token carries a matching
`RoomAgentDispatch`. The frontend's `/api/token` route must set this, or the
agent will never join.

### Worker options and the boot line

`AgentServer` is configured explicitly rather than left bare (audit §4.11).
Three things to know:

- **`num_idle_processes=1`** (`agent.py`). The framework's own defaults are 0 in
  dev and `ceil(cpu_count)` in production. One warm process is the number that
  matches this worker: a cold job process spends ~2.5s importing
  `livekit.agents.inference` (the native VAD / end-of-turn library) before any
  of our code runs, and that is silence the first learner of an idle instance
  sits through. `ceil(cpu_count)` would hold that memory per core for jobs that
  are almost entirely I/O (a realtime socket, an STT socket, some short text
  calls). Raise it when a load test says what one instance can hold.
- **A prewarm hook** — `server.setup_fnc = _prewarm`, the 1.6.10 name for
  `prewarm_fnc`. It runs once per job process, before any job is assigned, and
  builds the two models that are per-process rather than per-session: the
  local-inference Silero VAD (a native singleton) and the semantic turn
  detector (which keeps only per-stream state). Both are handed to
  `AgentSession`; a session in a process whose prewarm failed builds its own
  and says so, so a broken prewarm costs latency and never a job.
- **`load_threshold` is deliberately left at its default** (0.7 of the server's
  5-second average CPU; infinity in dev, which is what keeps a laptop taking
  jobs). LiveKit Cloud ignores it entirely — it is a self-hosting knob — and
  headroom per instance for a realtime-audio agent is unknown until one is
  load-tested. Load-test before the first public link, then set it together
  with a `load_fnc`.

The prewarm hook also emits the **boot line**: one INFO record named
`worker boot`, carrying the whole resolved configuration
(`TutorConfig.log_fields()`) — `tutor_env`, `convex_site_url`, every model id,
the endpointing bounds, `allow_unmetered`, and the two secrets as **presence
booleans only** (`machine_key`, `openai_key`; neither value is ever logged). A
deploy pointed at the wrong Convex, running the wrong model, or holding no
machine key is then visible in the first log line rather than in the first
learner's session. If the configuration is unusable at all (no
`OPENAI_API_KEY`, or `TUTOR_ALLOW_UNMETERED` on a `TUTOR_ENV=production`
worker) the line is an ERROR saying so, and every job the process takes is
refused for the same reason.

## Frontend contract

| Channel                                  | Carries                                                        |
| ---------------------------------------- | -------------------------------------------------------------- |
| `lk.transcription` (text stream, SDK)    | Interim + final transcripts, both speakers                      |
| `tutor.corrections` (text stream)        | One JSON `analysis.complete` payload per settled learner turn   |
| `tutor.paused` (participant attribute)   | `"true"` / `"false"`                                            |
| `tutor.analyzer` (participant attribute) | `"on"` / `"off"` — whether corrections are enabled at all       |
| `tutor.elapsed_s` (participant attribute) | Active seconds so far, as a string — the stopwatch's only source; it stops while held |
| `tutor.remaining_s` (participant attribute) | `balance_s - elapsed_s`, floored at 0, as a string |
| `tutor.out_of_minutes` (participant attribute) | `"true"` only while the session is held at zero |
| `tutor.turn_seq` (participant attribute) | A counter, bumped on every committed learner turn — the UI closes the bubble on it |
| `tutor.review_version` (participant attribute) | An integer as a string, `"0"` at session start and bumped on every new Review snapshot — the tab refetches `tutor.review` when it rises |
| `tutor.goal` (participant attribute) | The one line the learner agreed this session is for. Absent until the goal is captured |
| `tutor.session_over` (participant attribute) | `"true"` immediately before the worker disconnects |
| `tutor.error` (participant attribute) | `""` (nothing wrong, published at start), `"model"` (the realtime model died unrecoverably — the session is ending), or `"tutor_silent"` (no tutor audio 20s after the session started; nothing was billed) |
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
plan, `SessionFacts.summary()`, the last ~10 turns of the
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
// response — `version` rises with every new snapshot (see tutor.review_version)
{ "ready": false, "version": 0 }
{
  "ready": true,
  "version": 2,
  "vocab":   [{ "target": "la cuenta", "anchor": "the bill" }],
  "phrases": [{ "target": "¿Qué me recomienda?", "anchor": "What do you recommend?" }],
  "tables":  [{ "verb": "querer", "tense": "Preterite · pretérito",
                "rows": [{ "person": "yo", "form": "quise" }] }]
}
```

**Generation follows the goal, not the plan** (phase 7 step 3). Nothing is
generated at session start any more: the material is made when the goal lands
(a session that drifted from restaurants to taxis used to review restaurants —
backlog #2 — and with the picker no longer setting tenses or scenarios, every
session got the same four generic tables). A hold or a poll before the goal
exists still resolves the tab, with the tables alone. At a hold, once at least
3 learner turns have committed since the last generation, it is regenerated
from the goal **and the transcript so far**; the last good material keeps being
served while that is in flight, so the tab never empties, and a failed
regeneration keeps it for good. `ready: false` always means "poll again", never
an error.

`version` starts at 0 and rises by one per snapshot. The same number is
published as the `tutor.review_version` participant attribute the moment a
snapshot lands, so the tab is *told* to refetch instead of polling something
that used to never change.

`vocab` (~12) and `phrases` (~8) are generated by Luna as strict JSON from the
goal, the plan behind it, and the recent transcript. **`tables` are not
generated at all** — they come from `src/conjugation/`, a shipped engine:

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

## The goal: the session's spine

The conversation starts with goal setting (phase 7 step 3, Yash 2026-08-25).
There is no arc, no phases and no consent gates — one exchange, then the
conversation.

```text
plan cards (topic / focusNote / note)
  └─ goal_from_plan()            deterministic, no model call → an UNCONFIRMED
                                 proposal: focusNote else topic else scenario
                                 else note; forms = picked tenses, else the
                                 quoted fragments in the note
the opening (one generate_reply, in TUTOR_GOAL_LANG's language)
  ├─ with a proposal             one line restating it + "is that right?"
  └─ without                     "what do you want to work on today?"
the learner answers
  ├─ set_session_goal(...)       the tutor's own tool → source "tool", confirmed
  └─ nothing by the 3rd turn     one Luna call over the opening turns, 6s,
                                 strict JSON → source "extracted", unconfirmed
when a goal lands (first writer wins — never two goals)
  ├─ Agent.update_instructions() a GOAL block in the standing rules, pushed to
  │                              the live realtime session
  ├─ analyzer.set_goal()         the focus re-weights to the goal's forms
  ├─ review.generate(goal)       the Review is finally about something
  ├─ tutor.goal                  published for the surface
  └─ POST /tutor/summary         the goal alone, immediately
```

`set_session_goal(goal, forms, why)` is the worker's only function tool
(`TutorAgent`, `src/agent.py`; everything downstream is `src/goal.py`). The
standing instructions say to call it exactly once, at the moment the learner
confirms, and never to narrate the call; the tool result is itself an
instruction to carry on without acknowledging it, because a realtime model
speaks after a tool result. Realtime models at `reasoning=minimal` are weak
tool-callers, which is what the extraction safety net is for — and why the
goal records its own `source`.

`Agent.update_instructions()` on the OpenAI realtime plugin sends a
`session.update` over the already-open socket (`update_instructions` →
`RealtimeSession.send_event`, agents 1.6.10): no reconnect, no restart, no
interrupted turn, and it takes effect from the model's next response. It is
also recorded as an `AgentConfigUpdate` in the chat context. This is the seam
the deleted arc left behind, and the goal is the one thing that rides it.

The goal then feeds four surfaces, which is what "spine" means: the tutor's
standing instructions, the analyzer's focus, the Ask context (it leads the
session facts), and the Review. The resume brief carries it too, along with the
turn count and the anchor-language ratio.

## Dispatch metadata

The agent is *explicitly dispatched*: the frontend's `/api/token` route attaches
a `RoomAgentDispatch` for the `tutor` agent, and its `metadata` is one JSON
string carrying everything the worker needs to know about *this* session:

```json
{
  "balance_s": 1380,
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

`balance_s` is the learner's balance in seconds at session start — the budget
the clock meters against. Every field is optional and the whole payload is
parsed defensively in `src/plan.py`: an absent, empty, or unparseable payload
runs a 10-minute development session with no plan, and wrong-typed fields are
dropped rather than fatal. `balance_s` is clamped to 0–86400; plan strings are
whitespace-collapsed, length-capped, and deduplicated.

The plan feeds three consumers, and each reads it differently:

| Consumer                | What it does with the plan                                    |
| ----------------------- | ------------------------------------------------------------- |
| `tutor_instructions`    | A "this session" block: steer towards the topic/scenario, use and elicit the focus forms, work the vocab in — never announced, never a drill. An empty plan asks the tutor to suggest something light itself. |
| `greeting_instructions` | With a scenario, the tutor opens *inside* it in the target language, with one easy question; with a topic, it opens on the topic. With no plan it asks — in the anchor language, the one anchor-language opening left — what they want to talk about, and the answer becomes the subject. |
| `analyzer_instructions` | A focus note: weight corrections towards the focus tenses and vocab, still report clear errors elsewhere. The scenario is deliberately excluded — it tells the tutor who to be, not the analyzer what to look at. |

Tense names and vocab themes are opaque strings chosen by the frontend for the
configured target language and passed straight through. Nothing here is
Spanish-specific.

## The session clock

Minutes are metered, not scheduled (vision doc, 2026-08-24). The learner arrives
with a balance in seconds and talks for as long as they want and it allows;
`src/clock.py` ticks on an interval and adds each elapsed interval to its active
time only while the session is unheld. The clock is authoritative — the frontend
displays its numbers and never computes its own.

| Moment                          | What happens                                                |
| ------------------------------- | ----------------------------------------------------------- |
| first tutor audio frame          | The clock starts; `tutor.elapsed_s` / `tutor.remaining_s` published. **Not** when the greeting is *requested*: a session where the model never speaks must be billed nothing. The frame is `agent_state_changed` → `"speaking"`, which the framework flips from the playout task's first-frame callback. No tutor audio within 20s is logged at **error** level and published as `tutor.error` = `"tutor_silent"` — nothing has been billed, so this is an alarm the learner can act on (reload), not an ending |
| every 60 **active** seconds      | A debit for the seconds so far. Cumulative, so the ledger takes only the delta; a worker killed at minute 45 has lost at most a minute of revenue (audit §4.1) |
| every 5s while unheld           | Both republished — a stopwatch counting up, not a countdown |
| every pause and resume          | Republished immediately, so the stopwatch visibly stops and starts with the hold |
| 30s left                        | One nudge brief through the same seam as the resume brief: finish the thought, start nothing new, do **not** say goodbye or mention the time — the surface already shows it |
| 30s left **while paused**       | The nudge is *held* and delivered on `tutor.resume` instead — nobody hears it into a muted session |
| zero                            | `session.interrupt()`, a debit for the seconds so far, then the **same hold a learner pause takes** plus `tutor.out_of_minutes` = `"true"`. The session does not end. |
| `tutor.resume` while held at zero | The balance is re-read (`/tutor/balance`, at most once every 5s). More minutes → the budget grows under the same elapsed time and the conversation continues; still zero → the hold stays, acked as `{"paused": true, "resumed": false, "out_of_minutes": true}` |
| the learner's participant leaves | The meter is **held** — a hold source of its own, never `state.paused`, which is the UI's boolean and edge-triggered by the pause RPC — the seconds so far are debited while the worker is certainly still alive, and a 60s grace starts. A reconnect inside the grace releases the hold and the same conversation carries on in the same room; otherwise `ctx.shutdown()`. `close_on_disconnect` does not cover this: a wifi drop, a tab crash and a closed laptop are none of the disconnect reasons it fires on (audit B4) |
| any hold older than `TUTOR_HOLD_IDLE_S` (default 600s) | The same ending: `tutor.session_over` = `"true"`, `session.aclose()`, `ctx.shutdown()`, and the teardown debits what was actually used. A hold is free, which is exactly why an abandoned one is expensive to us — it held the room, the worker slot and the realtime socket indefinitely, because the idle timeout was only ever checked at zero balance (audit §3.3). The hold's age is wall time and resets on every resume; the learner-absent hold has its own, shorter (60s) grace |
| the realtime model dies unrecoverably | `tutor.error` = `"model"`, the meter is **held** (a third hold source, `state.model_failed`), the seconds so far are debited, and the session ends through the ordinary `session_over` path so the client's `finish` runs and the learner lands on a summary rather than a frozen stage (audit §4.2). Recoverable errors are logged and nothing else — the plugin retries |
| 10 minutes abandoned at zero    | `tutor.session_over` = `"true"`, `session.aclose()`, `ctx.shutdown()` — no goodbye; nobody is there to hear one |

**Pause time is not billed.** The clock accrues only while the session is not
held — a learner studying a correction is not spending minutes (decision
2026-08-20, reversing the earlier 'pause billed' call).

### The ledger seam

`src/billing.py` is the only thing in the worker that talks to Convex, over
three authenticated calls against `$CONVEX_SITE_URL`:

| Call | Body | Answer |
| --- | --- | --- |
| *auth, every call* | `Authorization: Bearer <Clerk M2M JWT>` | 401 → one re-mint, one retry |
| `POST /tutor/debit` | `{"room", "userId", "jobId", "seconds", "seq"}` | `{"balanceSeconds"}` |
| `POST /tutor/balance` | `{"userId", "room"}` (room optional) | `{"balanceSeconds", "secondsBilled"}` |
| `POST /tutor/summary` | `{"room", "userId", "jobId", "about"?, "transcript"?, "review"?, "corrections"?, "goal"?, "turns"?, "anchorRatio"?, "asks"?, "lookups"?, "estCostUsd"?}` | `{"ok": true}` |

Convex keys the debit on `ref = <room>:<jobId>:<seq>` and answers a replay with
the same body. `secondsBilled` is the **room's** already-billed high-water mark
(0 for a room nobody has billed, or when `room` is omitted). `seconds` is
bounded 0–86400 and the whole body stays well under Convex's 4 KB limit, and
**one call may add at most 3600s** to `secondsBilled` (the cadence is 60s, so a
larger delta is a bug or an attack): Convex answers 400 and bills nothing. A
400 is never retried unchanged — the same body would only be refused again — it
is logged at error level with Convex's reason and counted toward the ceiling
below. A 500 means the room belongs to another learner or the id is unknown;
also a refusal, also error level.

#### Auth: Clerk machine-to-machine (2026-08-25)

Replaces the shared `TUTOR_DEBIT_SECRET`. **Two Clerk machines per instance** —
`tutor-worker` and `tutor-ledger`, with the worker **scoped to** the ledger.
The dev instance's pair was created 2026-08-25; production gets its own two,
and its own `CLERK_WORKER_MACHINE_SECRET_KEY`, at the ship step.

At job start the worker POSTs its machine secret key (`ak_…`, environment only,
never logged) to `POST $CLERK_API_URL/v1/m2m_tokens` with
`{"token_format": "jwt", "seconds_until_expiration": 10800}` and sends the JWT
that comes back as the bearer on every `/tutor/*` call — one token per job, 5s
budget on the mint. Convex verifies it offline against the instance's JWKS
(`CLERK_JWT_KEY`; no secret key on Convex, no per-call cost) and checks **both
ends**: subject is the worker machine *and* scopes include the ledger machine.
Anything it rejects is a 401.

A **401 re-mints once and retries that one call** — an expired JWT under a
four-hour session is the ordinary case, not a fault, and it never kills the
job. A failed re-mint, or a 401 on the retry (a fresh token the ledger still
refuses is a *configuration* fault: wrong machine, or missing scope), is a
failed call. Individual JWTs cannot be revoked: revocation is rotating the
worker's machine key, and the 3h expiry is the window.

#### When debits fail

Consecutive failed debits are counted — any non-200, any timeout, any
exception; **one success resets the count**. At **five** (about five minutes at
the 60s cadence) the worker logs an ERROR, sets the `ledger_failed` hold on
`SessionState` (so `clock_held` stops the meter, like `model_failed`), **stops
debiting for good**, and ends the session through the ordinary
`tutor.session_over` path so the learner lands on a summary.

The consequence is accepted and deliberate (Yash, 2026-08-25): the teardown
debit of that session does not go out either — neither it nor its single retry
— so its **last ~5 minutes never bill** and Convex's reconciliation cron closes
the row. Bounded, learner-favouring, and the alternative is worse: a ceiling-
free retry loop is exactly how a worker runs for hours unbilled with nobody
paging. **Do not turn this into a retry loop that keeps the job alive.** The
`/tutor/summary` post at teardown is still attempted once (it may fail too;
that costs a History entry, not money).

The balance read is outside the count — see the fail-closed note above.

`seconds` is the **room's** cumulative active seconds, not the job's:
`billed_before + this job's active seconds`, where `billed_before` is the
`secondsBilled` read once at job start. That is audit B3 — a LiveKit
redispatch after a crash starts a second job whose clock begins at zero, and a
job-cumulative report would sit under the room's high-water mark from its first
second, making the whole second conversation free. `billed_before` is read
**once** and never refreshed: every later balance read already contains this
job's own debits.

`seq` increments per debit, and the ledger debits only the delta above the
high-water mark — so reporting the same total twice is free and the worker
never tracks what it has already billed. Debits are serialized behind one lock
(a periodic debit and a teardown debit must never interleave) and go out:

- **every 60 active seconds**, from the clock (audit §4.1);
- **when the learner's participant leaves** the room (audit B4);
- **at the zero hold**, before the hold, so the balance the frontend re-reads is
  already right by the time the out-of-minutes card is on screen;
- **at teardown**, where `report_seconds_billed()` logs `session seconds billed`
  and retries once — and this one alone carries `"final": true`, which is what
  tells Convex to set the session's `endedAt`. The periodic and zero-hold
  debits must NOT: they leave the row open so a purchase can resume the same
  conversation. A crashed worker's final debit is what lets the learner start a
  new conversation immediately instead of waiting out the one-open-session
  window.

### Why the session ended

The final debit — the teardown one, the only one carrying `"final": true` —
also carries `"reason"`, one of:

| `reason` | What happened |
| --- | --- |
| `ended` | The ordinary end: the learner left the page, or the job simply finished. The default. |
| `out_of_minutes_idle` | Held at zero and abandoned for 10 minutes. |
| `hold_idle` | An ordinary hold that outlasted `TUTOR_HOLD_IDLE_S`. |
| `learner_left` | The learner's participant left the room and did not come back inside the 60s grace. |
| `model_error` | The realtime model died unrecoverably (`tutor.error="model"`). |
| `ledger_failure` | Five consecutive failed debits: the clock is held and the session ends. (This debit does not go out either — the accepted under-bill.) |
| `tutor_silent` | The first-audio watchdog fired and nothing better was ever recorded. Set *weakly*: any real ending overwrites it. |

Only the final debit carries it; a periodic or zero-hold debit has nothing to
report, because nothing has ended. Before this, History could not tell a crash
from a clean end (the "edges" list, phase 7 step 3).

### The after-session record

`POST /tutor/summary`, once, from the teardown callback beside the final debit
and independent of it (either may land first). Until it existed, everything the
conversation *was* died with the tab: the outcome written to Convex was
corrections + seconds + `endedByClock`, so the summary screen showed time and
fixes and History showed the plan's topic (phase 7 step 2).

Ten optional fields, each independent and each degrading to absent (absent =
"leave that column alone", so a field the worker could not produce never
overwrites one it produced earlier):

- `about` — one line, ≤200 chars, in the **anchor** language, saying what the
  conversation was actually about. One `TUTOR_ANALYZER_MODEL` call on the
  transcript, `reasoning: none`, 6s budget (`src/summary.py`,
  `ABOUT_INSTRUCTIONS` in `prompts.py`). It goes by the transcript, not by the
  plan: if the learner drifted, the line follows them. A model that answers
  `NONE`, fails, or hangs simply omits the field, and its tokens are counted
  into `usage.py` through `record_text_usage` — the one seam out-of-band model
  calls have for the cost line (the analyzer, Ask, translate and Review still
  contribute zero; audit §4.7).
- `transcript` — `session.history` as `{"role": "learner"|"tutor", "text"}`,
  the **most recent** 200 turns of ≤500 chars each (oldest dropped first: a
  long session's opening pleasantries are the part nobody comes back for, and
  `about` already carries the shape of the whole thing). System prompts, tool
  calls and empty turns never travel.
- `review` — this session's Review material (`vocab` / `phrases` / `tables`),
  exactly the `tutor.review` payload minus `ready`, if it ever became ready.
  Bounded to the ledger's `SUMMARY_LIMITS` before it goes: the conjugation
  engine can build twelve tables and Convex takes eight, and an over-long
  review would 400 the whole record, transcript and all.
- `corrections` — every finding the analyzer actually *published* this session,
  kept on `SessionFacts` as the same six-field element the client receives
  (`id`, `original`, `replacement`, `category`, `severity`, `explanation`),
  most recent 200. The client writes the same list through `sessions.finish`;
  this is the copy that survives a tab that closed first.

- `goal` — `{ text (<=200), forms (<=8 x <=60), source: "plan"|"tool"|"extracted" }`,
  what the conversation was FOR. With `about` beside it, History can finally say
  what was set up and what was actually done (the plan-drift edge). It is also
  posted **once, early** — the moment the goal is captured — so a session whose
  teardown never runs still says what it was for; `/tutor/summary` upserts, and
  the teardown post fills in the rest.
- `turns` — how many learner turns committed (`tutor.turn_seq`'s final value).
- `anchorRatio` — 0..1, how much of the learner's talking was in the anchor
  language. The analyzer returns a `language` verdict (`target` / `anchor` /
  `mixed`, defaulting to `target` when absent) with every turn it reviews, and
  a mixed turn counts half. Absent when the analyzer is off.
- `asks` — the questions the learner typed in Ask that got a real answer
  (<=25 x <=400).
- `lookups` — every select-to-translate lookup as `{source, translation}`
  (<=100 x <=200 each).
- `estCostUsd` — what this session cost **us** to run, in dollars, from
  `usage.py`: a finite number 0–1000, 4 dp, clamped worker-side so a runaway
  estimate can never 400 the record. It is computed *after* the `about` call,
  so the teardown's own model call is inside the number, and it is read against
  the same `seconds_billed` the ledger just settled against. It is an estimate
  for pricing decisions and nothing else — the ledger bills seconds, never
  tokens, and nothing renders this. Before phase 7 step 4 it was logged and
  discarded (audit §4.7).

The body is bounded at 256 KB: over that, the review snapshot goes first, then
the transcript is trimmed from the oldest end, then the corrections, and
`about` is never dropped.
The whole seam — model call plus POST — runs under one 8s budget
(`SUMMARY_BUDGET_S`) inside the guarded teardown, and shares the debit lock, so
it can neither delay a shutdown nor interleave with a debit's sequence number.
A session with no learner id (`billing.enabled` false) posts nothing and spends
no model call.

A failed *zero-hold* debit is remembered (`zero_debit_unacked`). Those seconds
are still sitting in the learner's balance, so budgeting a resume from that
balance would spend them twice (audit §3.1.6) — instead `tutor.resume` retries
the debit first and refuses the resume (`{"out_of_minutes": true}`) for as long
as it keeps failing. `clock.apply_balance()` is only ever called with a number
a *successful* debit or balance read returned.

Every failure is logged and swallowed — a ledger write must never reach the
conversation — but at **error** level, not warning: a 401 or a dropped debit is
revenue on the floor, and the log is the only thing that will ever notice
(audit B10). Pack pricing lives in
`plans/phases/phase-6-metered-conversation.md`.

## Pause semantics

The *set of holds* (explicit control, correction inspection, select-to-translate,
history scroll) is client-side state. The frontend collapses it and calls
`tutor.pause` once when the set becomes non-empty and `tutor.resume` once when it
empties. Holds that open and close within ~400ms are debounced client-side and
never reach the worker at all.

Pause is non-destructive: the worker interrupts the tutor and disables audio in
and out, but never `clear_user_turn()` — a hold opened mid-utterance must not
discard what the learner already said. It does *close* that turn, though: once
the input is detached the STT gets no audio to endpoint on, so an open segment
would still be open when the learner speaks again and their next words would be
appended to it (one utterance, two transcript messages — live, 2026-08-21). So
the worker calls `commit_user_turn(skip_reply=True)` right after detaching,
which flushes the STT with silence and finalizes the segment; anything said
after resume starts a fresh one. A turn closed this way is analyzed and counts
as a reply the tutor owes, but it does not take the floor away from a learner
who was mid-sentence. The flush is bounded (~1s, 2s ceiling): a hold that hangs
is worse than a split transcript.

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
| pending learner text, closed by the flush | Re-enters: that turn is owed an answer (unless the learner was still speaking — they keep the floor) |
| anything else                            | Silent                                         |

The brief states facts only — hold duration, hold reasons, the study tab, the
inspected correction, the questions asked, whether the tutor was mid-reply, and
then the rolling evidence: what the session is for, how many turns the learner
has taken and how much of their talking was in the anchor language (once there
are at least 3 judged turns), and the corrections so far ("corrections shown to
them so far this session: 3 tense, 1 word-order"). It never scripts a line; how
to re-enter is `TUTOR_INSTRUCTIONS`' job.

`SessionFacts` (`src/state.py`) is the seam for those lines: the analyzer
reports its *published* corrections and each turn's language into it, the goal
lands on it, and `evidence()` renders the lot. Future sources (prior-session
summaries, a reflection agent) plug into the same object. It is evidence that
is *observed*, deliberately separate from the phase-4 learner profile, which is
configuration that is *set*.

The resume response is `{"paused": false, "resumed": <bool>}`, where `resumed`
reports whether a re-entry reply was *requested* — generation is
fire-and-forget; completion is not awaited or reported.

## Checks

```shell
uv run python -m compileall -q src
uv run ruff check src tests
uv run ruff format --check src tests   # drop --check to let it do the fixing

uv run pytest -q            # the whole suite

# every test file also runs as a plain script, without pytest
uv run python tests/test_conjugation.py
uv run python tests/test_prompts.py
uv run python tests/test_goal.py
```
