# Tutor frontend

Next.js app: the conversation surface, plus the LiveKit token endpoint.

| Route                         | What it is                                                          |
| ----------------------------- | ------------------------------------------------------------------- |
| `/`                           | Landing page — signed out                                           |
| `/go`                         | Post-auth router: to `/welcome` or `/home` depending on the account |
| `/welcome`                    | Onboarding: declare a level, receive the signup grant               |
| `/home`                       | The dashboard — balance, the plan pre-flight, History               |
| `/session`                    | The real session — live LiveKit adapter                             |
| `/terms`, `/privacy`          | Legal (currently stubs)                                             |
| `/design-inspo/chat-layout/*` | Phase-1 design exploration, driven by the mock                      |
| `/api/token`                  | The token endpoint, and the money gate — see below                  |

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

Required vars are read through `lib/env.ts`, so a missing one fails with its
own name rather than somewhere downstream.

No model keys here. Every OpenAI call this product makes is made by the agent
worker (`backend/`), never by the browser or by a Next route.

### Deploying (Vercel)

`CONVEX_DEPLOY_KEY` belongs on Vercel, not in `.env.local`. It is what lets the
build run `npx convex deploy` — pushing `convex/` to the production deployment
and generating the `NEXT_PUBLIC_CONVEX_URL` the client build bakes in — so the
build command is:

```shell
npx convex deploy --cmd "pnpm build"
```

Generate the key in the Convex dashboard (Settings -> Deploy keys) for the
_production_ deployment. Without it the build either fails or, worse, ships a
client pointed at the dev deployment.

Node and pnpm are pinned in `package.json` (`engines`, `packageManager`) so the
build platform resolves the same versions this repo is developed against.

### Convex deployment env

`CLERK_FRONTEND_API_URL` is not a `.env.local` var — it lives on the Convex
deployment and is set with `npx convex env set CLERK_FRONTEND_API_URL
https://<your-subdomain>.clerk.accounts.dev`. `convex/auth.config.ts` throws at
load if it is unset or not an absolute `https://` URL. The Clerk JWT template
named `convex` must carry the claims `aud: convex` and `email`; without them
Convex rejects every token as having no matching auth provider.

`TUTOR_DEBIT_SECRET` lives there too (`npx convex env set TUTOR_DEBIT_SECRET
<value>`). It is the bearer token on `POST /tutor/debit`,
`POST /tutor/balance` and `POST /tutor/summary` in `convex/http.ts` — the seam
the agent worker meters seconds and records conversations through. Deliberately _not_ a `.env.local` var and never
`NEXT_PUBLIC_*`: anything the browser can read is a way to spend someone
else's balance. The worker keeps its own copy in `backend/.env.local`.

## The money seam

Three pieces, and they only work together:

**`POST /api/token`** is the only gate. It authenticates with Clerk, reads the
balance, refuses a zero one with **402** and a learner who already has a
conversation open with **409**, mints the room and the participant identity
itself (the request body is read for `session_plan` and nothing else), signs
the learner's Clerk id and balance into the agent's dispatch metadata, and only
then writes the `sessions` row the worker will debit against.

**`convex/http.ts`** is the worker's three routes — `POST /tutor/debit`,
`POST /tutor/balance` and `POST /tutor/summary`, all behind a constant-time
bearer check on `TUTOR_DEBIT_SECRET`, all machine-to-machine with no CORS.
**The comment block at the top of that file is the wire contract**: exact paths,
field names, types, bounds and status codes, written for whoever is on the
Python side. Read it before changing either half.

In short: the worker reports the room's _cumulative_ billed seconds under the
ref `<room>:<jobId>:<seq>`; `sessions.debit` writes only the delta against
`sessions.secondsBilled`. That is what makes a retry, a duplicate delivery, an
out-of-order report and a redispatched job all safe. The teardown report also
carries `final: true`, which closes the `sessions` row if the client never got
to `sessions.finish` — a crashed worker or a killed tab must not leave the
learner locked out by the one-open-session guard.

## The after-session record

The meter is only half of what the worker knows. `POST /tutor/summary` is the
other half: at teardown the worker writes onto the same `sessions` row a one-
line `about` (what the conversation was actually about, read off the transcript
rather than off the plan), the `transcript` itself, and the `review` snapshot
(vocab, phrases, conjugation tables — the `tutor.review` payload minus `ready`).

It exists because all three used to live only in browser memory: the summary
screen rendered them, the tab closed, and they were gone — while
`out-of-minutes.tsx` promised the learner they were saved. Now
`sessions.byRoom` is the one record BOTH the post-session summary and the
History modal read, so the two cannot disagree about what happened, and closing
the tab loses nothing.

It also carries `corrections` — the analyzer's findings as the worker saw
them, the backstop for a tab that never reached `sessions.finish`. They are
written into `outcome` only where there is none: the client's record always
wins, in either order, because only the browser knows the exact `secondsTalked`
and whether the clock ended the session.

The fields are optional and independently written (a field absent from
the body is left untouched, sending one again replaces it wholesale), and the
call is order-independent with the final debit — either may be the one that
creates the row. Bounds and exact field names are in the `http.ts` contract
block.

**Balance is `sum(creditLedger.seconds)`** — always summed, never a mutable
field on `users`. Every writer checks `by_ref` first, so a replayed grant or a
retried debit finds its own row and does nothing.

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
pnpm lint
pnpm test     # vitest + convex-test, against the real schema in memory
pnpm build
```

`pnpm test` covers the money seam and the after-session record
(`convex/sessions.test.ts`): room ownership, the one-open-session guard, ref
idempotency, the high-water delta, the reconciliation cron, and — for
`recordSummary` / `byRoom` / `history` — clamping, cross-learner refusal,
order-independence with the final debit, and paging finished rows past a run of
abandoned ones.
