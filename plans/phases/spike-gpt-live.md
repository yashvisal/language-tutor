# Spike: GPT-Live as the voice engine

*Approved 2026-09-10 (Yash). Branch `spike/gpt-live`, off main after PR #7.
Throwaway: the branch is deleted whichever way it goes. A win becomes its
own phase against main; a loss leaves main exactly as it was. Read
`product-vision.md` first; nothing here reopens a settled decision.*

## Why

Every defect from the three live runs of 2026-09-08/09/10 was turn-taking
or transcription: sentences split into several turns on a word search,
"mucho gusto" committed alone, room tone transcribed as "0" and "Dime",
"hay" heard as "I", a double-committed turn tripping the realtime API.
All of it comes from gluing three things that do not share a brain — a
separate transcriber, LiveKit's turn detector, and the realtime model.
GPT-Live-1 is one full-duplex model doing all three: it listens and
speaks at once, handles pauses and backchannels itself (0.8 s turn-taking
latency against 1.4 s for gpt-realtime-2.1), transcribes natively, and
delegates tools to a backend model. Yash tried it in the playground and
found the turn-taking itself better.

## What it changes, in our terms (from the plugin on LiveKit main, 2026-09-10)

1. It slots in where the realtime model sits: `AgentSession(llm=GPTLiveModel())`,
   no separate STT, VAD or turn detector. The framework wraps it in a
   duplex adapter so `on_user_turn_completed`, agent state and transcripts
   still flow.
2. Turn-taking and barge-in are the model's own. The adapter's `interrupt`
   is a no-op by design.
3. Instructions are frozen at session start. Mid-session changes are
   `append_instructions` — a standing rule capped at 500 tokens. Startup
   history is capped at 128 items / 8192 tokens; the chat context is
   append-only after start.
4. Tools run on a backend Responses model (`gpt-5.6-luna` by default) and
   the voice continues on its own once a tool returns.
5. Pause: `mute_input` replaces the mic with silence while the model keeps
   generating. Cutting the tutor's audio at the room means it may talk into
   the void during a hold.
6. Voice sessions are $0.05/min billed per second, plus backend tokens.
   Today's stack runs ≈ $0.09–0.11 per billed minute all-in.

## The five questions

| Question | Evidence |
| --- | --- |
| Fewer split sentences; "hay" stays Spanish? | Same conversation on both engines; turns per sentence, analyzer mixed-language ratio |
| Meter starts on first tutor audio? | `first tutor audio` log line; clock starts |
| Pause works? | Pause a minute on Review, resume: the tutor picks up, not mid-monologue |
| Goal round-trip? | English opening → confirm → backend goal tool → Spanish |
| Analyzer still gets turns? | Corrections after learner turns, as today |

## Steps

1. Upgrade `livekit-agents[openai]` 1.6.10 → 1.8.1; the 188 tests still pass
   on the current engine; `GPTLiveModel` imports.
2. `TUTOR_VOICE_ENGINE=realtime|live`, default `realtime`. Nothing changes
   for the current path.
3. The live path in the session constructor: GPT-Live with the tutor prompt
   as frozen instructions, the greeting as the opening reply, the goal tool
   delegated, the goal-confirmed switch as an appended rule. No STT, VAD or
   turn detector on this path.
4. The hold on the live path: mute input rather than interrupt; observe the
   model's output during a pause.
5. Billing, analyzer, Ask, Review, translate and summary untouched. A break
   is a finding, not a fix.
6. Instrument: every turn commit logs its length and the gap since the last,
   so "how often did it split" is a number.
7. Yash runs the same conversation twice, once per engine. Compare
   transcripts, splits, first-audio time, mixed-language ratio, cost/min.

## Out of scope

Production code on the realtime path, billing, study surfaces, a merge.

## Result

*(filled in after the two runs)*
