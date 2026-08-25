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

`frontend/.env.local` (gitignored) holds these — names only, values come from
each provider's dashboard:

| Variable                                          | What it is                                               |
| ------------------------------------------------- | -------------------------------------------------------- |
| `LIVEKIT_URL`                                     | LiveKit Cloud project websocket URL                      |
| `LIVEKIT_API_KEY`                                 | LiveKit API key, used to mint room tokens                |
| `LIVEKIT_API_SECRET`                              | LiveKit API secret, signs those tokens                   |
| `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY`               | Clerk instance key for the browser                       |
| `CLERK_SECRET_KEY`                                | Clerk server key (never exposed to the client)           |
| `NEXT_PUBLIC_CLERK_SIGN_IN_URL`                   | Where Clerk sends users to sign in                       |
| `NEXT_PUBLIC_CLERK_SIGN_UP_URL`                   | Where Clerk sends users to sign up                       |
| `NEXT_PUBLIC_CLERK_SIGN_IN_FALLBACK_REDIRECT_URL` | Landing route after sign-in when there is no return path |
| `NEXT_PUBLIC_CLERK_SIGN_UP_FALLBACK_REDIRECT_URL` | Landing route after sign-up when there is no return path |
| `CONVEX_DEPLOYMENT`                               | Which Convex deployment the CLI talks to                 |
| `NEXT_PUBLIC_CONVEX_URL`                          | Convex websocket URL the React client connects to        |
| `NEXT_PUBLIC_CONVEX_SITE_URL`                     | Convex HTTP actions origin                               |
| `OPENAI_API_KEY`                                  | Model key for OpenAI-backed features                     |
| `XAI_API_KEY`                                     | Model key for xAI-backed features                        |

Required vars are read through `lib/env.ts`, so a missing one fails with its
own name rather than somewhere downstream.

### Convex deployment env

`CLERK_FRONTEND_API_URL` is not a `.env.local` var — it lives on the Convex
deployment and is set with `npx convex env set CLERK_FRONTEND_API_URL
https://<your-subdomain>.clerk.accounts.dev`. `convex/auth.config.ts` throws at
load if it is unset or not an absolute `https://` URL. The Clerk JWT template
named `convex` must carry the claims `aud: convex` and `email`; without them
Convex rejects every token as having no matching auth provider.

`TUTOR_DEBIT_SECRET` lives there too (`npx convex env set TUTOR_DEBIT_SECRET
<value>`). It is the bearer token on `POST /tutor/debit` and
`POST /tutor/balance` in `convex/http.ts` — the seam the agent worker meters
seconds through. Deliberately *not* a `.env.local` var and never
`NEXT_PUBLIC_*`: anything the browser can read is a way to spend someone
else's balance. The worker keeps its own copy in `backend/.env.local`.

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
