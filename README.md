# lengua

**Live voice conversation practice with an AI tutor that never talks over you.**
Live at [lengua.chat](https://lengua.chat).

You speak Spanish (or French, German, Italian, Portuguese); the tutor answers
out loud, naturally, in real time. The teaching happens *around* the
conversation rather than inside it: after each of your turns settles, the
better word appears quietly in place with the reason if you want it, you can
highlight anything the tutor said to see the English, and you can pause to ask
"why?" in English and then pick up exactly where you left off.

```
frontend/   Next.js app + Convex backend (accounts, the minutes ledger, history)
backend/    Python LiveKit Agents worker (the tutor itself)
plans/      product vision, phase plans, audits, launch checklist
```

---

## Why

Connecting a microphone to a language model is not a product. Modern models
already hold a natural multilingual conversation; the opportunity is in what a
good human tutor does *at the same time*: notice the mistake, decide whether it
matters, and choose when to say something. Constant verbal correction destroys
the flow that makes speaking practice work.

So the core bet is one sentence:

> **Conversation and coaching happen in parallel.**

The spoken tutor keeps the conversation going. The interface, quietly and
after the fact, shows what you should have said. You see it, tap for an
explanation, or just keep talking. Everything else in the product exists to
protect that loop: the tutor waits for you to finish a thought, translation is
on demand rather than a running subtitle, and pausing to study is free and
holds the conversation in place.

The target learner is the regressed or early-intermediate speaker: someone who
understands far more than they can produce and reaches for phrases while
getting tenses and structure wrong. The whole product is built and tested
against that person, with Spanish as the test language and nothing
architecturally Spanish-specific.

The long-term direction is a tutor that remembers you across sessions. That
is deliberately not built yet; the first job was to make the live surface
meaningfully better than opening a generic voice assistant and saying
"practice Spanish with me". See [`plans/product-vision.md`](plans/product-vision.md).

---

## How it works

```
learner audio
  ├─ GPT Realtime (speech-to-speech)  → the tutor's voice
  ├─ live transcription               → both sides on screen, one turn clock
  └─ per learner turn, in background  → analyzer: the correction, in place

on demand, while the conversation holds (unbilled)
  ├─ highlight to translate           → one selected span, translated
  ├─ Ask                              → one question, one coaching answer
  └─ Review                           → vocabulary, phrases, conjugation tables
                                        generated from this session's goal

the session clock (the source of truth for money)
  ├─ starts at the tutor's first audio frame, never before
  ├─ debits the ledger every 60 active seconds, idempotently
  ├─ holds at zero rather than ending, and resumes if minutes appear
  └─ a killed worker still bills; a stale row is reconciled by a cron
```

A few design rules the codebase is organised around:

- **The analyzer never blocks the tutor.** Corrections are computed in the
  background and surface only once your turn has settled.
- **One turn clock.** LiveKit's semantic turn detector owns endpointing for
  replies, transcripts and the analyzer alike. Every configuration that broke
  this rule failed in live testing, and one candidate voice model was dropped
  for it.
- **Resume is conversational, not a tape deck.** A realtime model cannot
  resume mid-word, so after a hold the worker hands it a short factual brief
  and lets it re-enter with judgment.
- **The session has a spine.** The first exchange settles a goal for the
  conversation; that goal steers the tutor's instructions, re-weights the
  analyzer, and generates the review material.
- **Money is a ledger, not a field.** Balances are sums of signed rows in
  seconds, debits are idempotent on a per-room sequence, and the worker holds
  a lease on the row so two sessions can never spend the same minutes.
- **Facts are stated, never scripted.** Prompts describe what happened and
  remind the model of its standing rules; the lines it says are its own.

The per-component contracts are documented in depth in
[`frontend/README.md`](frontend/README.md) (the app, the money seam, the
after-session record) and [`backend/README.md`](backend/README.md) (the worker,
the wire protocol, pause semantics, the clock).

---

## The stack

| Layer | Choice | Why |
| --- | --- | --- |
| Realtime audio | [LiveKit](https://livekit.io) Cloud, `livekit-client` in the browser, [LiveKit Agents](https://docs.livekit.io/agents/) 1.8 in Python | Audio transport, turn detection, interruption handling and agent dispatch as one system, with a cloud deploy for the worker |
| Voice model | OpenAI GPT Realtime (speech-to-speech), `gpt-live-transcribe` for transcripts, a text model for the analyzer, Ask, translate and Review | One realtime model that hands turn detection to the agent; text work stays off the voice path |
| Web app | Next.js 16 (App Router, Turbopack), React 19, TypeScript, Tailwind v4, shadcn (base-mira), Motion | The stage is a single-page surface with a lot of state and motion; this is the shortest path to something that feels right |
| Backend | [Convex](https://convex.dev) | Reactive queries for the dashboard and history, transactional mutations for the ledger, HTTP routes with machine-to-machine auth for the worker, a cron for reconciliation, and 130+ tests running in-memory |
| Auth | [Clerk](https://clerk.com) | Sign-in, Google SSO, and machine-to-machine tokens so the worker can prove to the ledger which machine it is and what it is allowed to touch |
| Observability | Sentry on browser, server, edge and the Python worker, with learner text scrubbed at the boundary | Errors are reported with ids and counts, never transcripts |
| Hosting | Vercel (web, with Convex functions deployed as part of the build), LiveKit Cloud (worker, Docker) | Both deploy from the repository on merge |
| Tooling | pnpm, `uv`, ruff, pytest, vitest, GitHub Actions, CodeRabbit on every PR | |

---

## How it was built

This was built in about six weeks, in eight planned phases, with an AI coding
agent doing most of the typing and a human deciding what to build, judging
every result live, and saying no a lot. The record of that is in the repo:

- **`plans/` is the source of truth.** The product vision, one plan per
  phase, two full code audits, a cost model and the launch checklist all live
  there as markdown and were kept current as decisions changed. Settled
  decisions are dated and are not relitigated without new evidence.
- **Phases, not sprints.** Design exploration (seven layout variants against a
  scripted conversation), then the live pipeline, then comprehension on
  demand, then sellable sessions with a real ledger, then the product shell,
  then metering and polish, then launch. Each phase plan says what it is
  trying to learn, and several record what live testing disproved.
- **Live testing decided things.** The candidate voice model was chosen and
  one dropped from real sessions, not benchmarks. History became
  relevance-based rather than a scrolling transcript because the target
  learner cannot read and speak at the same time. The ambient translation
  stream was deleted for the same reason.
- **Every change is a reviewed pull request.** One commit per fix, CI on both
  apps, an automated reviewer whose findings are triaged individually, and a
  rule that visual changes are verified on a real screen before they ship.
- **Audits before launch.** Two written audits (`plans/audit-*.md`) walked the
  money path, the worker's failure modes and the security surface; the launch
  checklist tracks what was fixed and what was consciously deferred.

The interesting problems, if you are reading the code for them: the ledger's
idempotency and lease model (`frontend/convex/sessions.ts`), the session clock
and the hold semantics (`backend/src/clock.py`, `backend/src/agent.py`), the
goal-setting exchange that gives a session its spine (`backend/src/goal.py`),
and the correction reveal on the stage (`frontend/components/session/`).

---

## Status

Live at lengua.chat as a free beta: every account gets five minutes, packs are
priced but checkout is not yet wired. Legal pages are marked as drafts until
their values are signed off. See `plans/launch-checklist-2026-09-14.md` for the
current state and what is next.

---

## Running it

Frontend, from `frontend/`:

```bash
pnpm install
pnpm dev            # needs a Clerk dev instance, a Convex dev deployment and a LiveKit project; see frontend/README.md
pnpm typecheck
pnpm lint
pnpm test
```

Backend, from `backend/`:

```bash
uv sync
uv run ruff check src tests
uv run ruff format --check src tests
uv run pytest -q
lk agent dev        # runs the worker against the LiveKit project; see backend/README.md
```

CI (`.github/workflows/ci.yml`) runs exactly these checks on every pull
request and on pushes to `main`, as two jobs. `pnpm build` is not in CI, since
it needs real Clerk and Convex environment variables to prerender; the build
is verified by the deploy instead.
