# Tutor agent worker

The Python [LiveKit Agents](https://docs.livekit.io/agents/) worker behind the
conversation surface. It runs as its own process — not inside Next.js — and
talks to the frontend over a LiveKit room.

Read `plans/product-vision.md` and `plans/phases/phase-2-live-pipeline.md` before
changing behaviour here.

## What it does

```text
learner audio
  ├─ realtime speech-to-speech model  → the tutor's voice          (swappable: xai | openai)
  ├─ openai.STT("gpt-live-transcribe") → live transcripts           (lk.transcription)
  ├─ gpt-realtime-translate WebSocket  → lagging anchor-lang text   (tutor.translation)
  └─ on_user_turn_completed            → background analyzer        (tutor.corrections)
```

Plus pause/resume over RPC, mirrored onto a participant attribute.

Design rules worth keeping:

- **The analyzer never blocks the tutor.** `on_user_turn_completed` fires a
  background task and returns immediately.
- **Translation fails soft.** If the translate socket dies, the session keeps
  going without it.
- **One transcript stream.** The realtime model's own input transcription is
  disabled; the parallel `stt=` plugin owns every transcript the UI shows.
- **Turn-taking is model-independent.** Both realtime models run with
  `turn_detection=None` and LiveKit's audio turn detector does the endpointing,
  so Grok and GPT Realtime feel the same and can be compared fairly.
- **No hardcoded Spanish.** Target and anchor languages are parameters.

## Layout

| File                 | Role                                                        |
| -------------------- | ----------------------------------------------------------- |
| `src/agent.py`       | Entrypoint: `AgentServer`, session wiring, pause/resume RPC  |
| `src/config.py`      | Env config + the swappable realtime-model factory            |
| `src/prompts.py`     | Tutor / STT / analyzer prompts, language-parameterised       |
| `src/analyzer.py`    | Background structured-output corrections                     |
| `src/translation.py` | `gpt-realtime-translate` WebSocket side-task                 |
| `src/state.py`       | Shared pause state                                           |

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
OPENAI_API_KEY=...          # STT, translation, analyzer
XAI_API_KEY=...             # only when TUTOR_REALTIME_MODEL=xai

# optional — defaults shown
TUTOR_REALTIME_MODEL=xai            # xai | openai  ← the model swap
TUTOR_TARGET_LANG=es
TUTOR_ANCHOR_LANG=en
TUTOR_XAI_MODEL=grok-voice-fast-1.0
TUTOR_XAI_VOICE=Ara
TUTOR_OPENAI_REALTIME_MODEL=gpt-realtime
TUTOR_OPENAI_REALTIME_VOICE=marin
TUTOR_STT_MODEL=gpt-live-transcribe
TUTOR_ANALYZER_MODEL=gpt-5.6-luna
TUTOR_ANALYZER_ENABLED=true
TUTOR_TRANSLATION_ENABLED=true
```

Swapping the realtime model is env-only: set `TUTOR_REALTIME_MODEL=openai` and
restart. No code change.

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
| `tutor.translation` (text stream)        | Streaming anchor-language translation of learner speech         |
| `tutor.corrections` (text stream)        | One JSON `analysis.complete` payload per settled learner turn   |
| `tutor.paused` (participant attribute)   | `"true"` / `"false"`                                            |
| `lk.agent.state` (participant attribute) | Agent state, published by the SDK                               |
| RPC `tutor.pause` / `tutor.resume`       | Frontend → worker, one call per state change                    |

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

Pause semantics: the *set of holds* (explicit control, correction inspection,
history scroll) is client-side state. The frontend collapses it and calls
`tutor.pause` once when the set becomes non-empty and `tutor.resume` once when it
empties.

## Checks

```shell
uv run python -m compileall -q src
uv run ruff check src
uv run ruff format src
```
