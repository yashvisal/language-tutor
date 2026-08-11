# Tutor frontend

Next.js app: the conversation surface, plus the LiveKit token endpoint.

| Route                         | What it is                                         |
| ----------------------------- | -------------------------------------------------- |
| `/session`                    | The real session — live LiveKit adapter            |
| `/design-inspo/chat-layout/*` | Phase-1 design exploration, driven by the mock     |
| `/api/token`                  | Standardized token endpoint with explicit dispatch |

Both `/session` and the stage-split design page render the _same_ components
from `components/session/`, folding the same `SessionEvent` contract through
`lib/session/reducer.ts`. Only the producer differs: `lib/session/live-producer.ts`
(LiveKit) or `lib/session/mock-producer.ts` (scripted replay).

## Setup

```shell
pnpm install
```

`frontend/.env.local` (gitignored):

```shell
LIVEKIT_URL=wss://<project>.livekit.cloud
LIVEKIT_API_KEY=...
LIVEKIT_API_SECRET=...
```

## Run

```shell
pnpm dev        # http://localhost:3000
```

`/session` needs the agent worker running too — it is a separate process:

```shell
cd ../backend && lk agent dev
```

Without the worker the page connects and waits: transcripts, translation and
corrections all originate there.

## Checks

```shell
pnpm typecheck
pnpm build
pnpm lint
```
