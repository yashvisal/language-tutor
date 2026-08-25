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
  ├─ every 5s unheld, and on every hold/resume → tutor.elapsed_s / tutor.remaining_s
  ├─ 30s left                          → nudge brief to the tutor (finish the thought)
  ├─ zero                              → debit, then HOLD (tutor.out_of_minutes) — no ending
  ├─ resume while held at zero         → re-read the balance; continue, or stay held
  └─ 10 min abandoned at zero          → tutor.session_over, disconnect
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
| `src/review.py`    | `tutor.review` RPC: the Review tab's material, made once       |
| `src/conjugation/` | The deterministic conjugation engine (registry + `es`)         |
| `src/state.py`     | Pause state (+ what it interrupted) and rolling session facts  |
| `src/plan.py`      | Dispatch metadata: the balance, the user, and the session plan  |
| `src/clock.py`     | The authoritative session clock + the seconds-billed seam       |
| `src/billing.py`   | The Convex ledger's client: `/tutor/debit`, `/tutor/balance`    |

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
TUTOR_DEBIT_SECRET=...      # bearer token for /tutor/debit and /tutor/balance

# optional — defaults shown
TUTOR_TARGET_LANG=es
TUTOR_ANCHOR_LANG=en
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
```

Without `CONVEX_SITE_URL` and `TUTOR_DEBIT_SECRET` — or for a session
dispatched with no `user_id` — the worker skips every ledger call and meters
against the dispatched `balance_s` alone. Nothing else changes.

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
| `tutor.elapsed_s` (participant attribute) | Active seconds so far, as a string — the stopwatch's only source; it stops while held |
| `tutor.remaining_s` (participant attribute) | `balance_s - elapsed_s`, floored at 0, as a string |
| `tutor.out_of_minutes` (participant attribute) | `"true"` only while the session is held at zero |
| `tutor.turn_seq` (participant attribute) | A counter, bumped on every committed learner turn — the UI closes the bubble on it |
| `tutor.session_over` (participant attribute) | `"true"` immediately before the worker disconnects |
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
| session start (greeting requested) | The clock starts; `tutor.elapsed_s` / `tutor.remaining_s` published |
| every 5s while unheld           | Both republished — a stopwatch counting up, not a countdown |
| every pause and resume          | Republished immediately, so the stopwatch visibly stops and starts with the hold |
| 30s left                        | One nudge brief through the same seam as the resume brief: finish the thought, start nothing new, do **not** say goodbye or mention the time — the surface already shows it |
| 30s left **while paused**       | The nudge is *held* and delivered on `tutor.resume` instead — nobody hears it into a muted session |
| zero                            | `session.interrupt()`, a debit for the seconds so far, then the **same hold a learner pause takes** plus `tutor.out_of_minutes` = `"true"`. The session does not end. |
| `tutor.resume` while held at zero | The balance is re-read (`/tutor/balance`, at most once every 5s). More minutes → the budget grows under the same elapsed time and the conversation continues; still zero → the hold stays, acked as `{"paused": true, "resumed": false, "out_of_minutes": true}` |
| 10 minutes abandoned at zero    | `tutor.session_over` = `"true"`, `session.aclose()`, `ctx.shutdown()` — no goodbye; nobody is there to hear one |

**Pause time is not billed.** The clock accrues only while the session is not
held — a learner studying a correction is not spending minutes (decision
2026-08-20, reversing the earlier 'pause billed' call).

### The ledger seam

`src/billing.py` is the only thing in the worker that talks to Convex, over two
signed calls (`Authorization: Bearer $TUTOR_DEBIT_SECRET`, against
`$CONVEX_SITE_URL`):

| Call | Body | Answer |
| --- | --- | --- |
| `POST /tutor/debit` | `{"room", "userId", "seconds", "seq"}` | `{"balanceSeconds"}` |
| `POST /tutor/balance` | `{"userId"}` | `{"balanceSeconds"}` |

`seconds` is always the session's **cumulative** active seconds and `seq`
increments per call; the action is idempotent per `(room, seq)` and debits only
the delta since the last report, so the worker never tracks what it has already
billed. Debits go out at zero (before the hold) and at teardown, where
`report_seconds_billed()` logs `session seconds billed` and retries once. Every
failure is logged and swallowed — a ledger write must never reach the
conversation. Pack pricing lives in
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
uv run ruff format --check src tests   # drop --check to let it do the fixing

# the conjugation engine — pytest if it is installed, a plain script otherwise
uv run python tests/test_conjugation.py
```
