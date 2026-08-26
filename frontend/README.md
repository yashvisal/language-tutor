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

Three more live there, and together they are how the worker proves who it is on
`POST /tutor/debit`, `POST /tutor/balance` and `POST /tutor/summary` — the seam
the agent worker meters seconds and records conversations through. There is no
shared secret any more (`TUTOR_DEBIT_SECRET` is gone from both halves); the
bearer is a **Clerk machine-to-machine JWT**, verified offline.

| var (on the Convex deployment) | what it is                                                                                                                  |
| ------------------------------ | --------------------------------------------------------------------------------------------------------------------------- |
| `CLERK_JWT_KEY`                | The Clerk instance's JWKS public key, as a PEM. Verification is local — no secret key on Convex, no network call per debit. |
| `TUTOR_WORKER_MACHINE_ID`      | `mch_…` — the machine the worker mints tokens as. Checked against the token's `subject`.                                    |
| `TUTOR_LEDGER_MACHINE_ID`      | `mch_…` — this ledger's machine. Must appear in the token's `scopes`.                                                       |

Both ends are checked (`convex/m2m.ts`): subject alone would let any machine
scoped to the ledger debit, scope alone would let any token the worker minted
for something else through. Any of the three unset is a `401` on every call —
the seam fails closed, never open. Deliberately _not_ `.env.local` vars and
never `NEXT_PUBLIC_*`: anything the browser can read is a way to spend someone
else's balance.

**Machine setup, per Clerk instance** (dev and prod each get their own pair):
create two machines in the Clerk dashboard (Machines) — `tutor-worker` and
`tutor-ledger` — and give `tutor-worker` a scope on `tutor-ledger`. Copy each
machine's `mch_…` id into the two vars above. The worker holds
`tutor-worker`'s machine secret key (`backend/.env.local`) and mints one
JWT-format token per job; Convex holds no Clerk secret at all.

**Producing `CLERK_JWT_KEY`.** The PEM is the instance's public signing key. Read
it off the Dashboard (API keys -> Show JWT public key -> PEM public key), or
convert the JWKS yourself:

```shell
curl -s https://<your-subdomain>.clerk.accounts.dev/.well-known/jwks.json   | node -e 'const j=JSON.parse(require("fs").readFileSync(0,"utf8"));
      console.log(require("crypto").createPublicKey({ key: j.keys[0], format: "jwk" })
        .export({ type: "spki", format: "pem" }).toString())'
```

Then `npx convex env set CLERK_JWT_KEY "$(cat key.pem)"` — it is multi-line, so
keep the quotes. Rotating the instance's signing key means setting this again:
because verification is offline there is no JWKS cache to expire on its own, and
until the var is updated every worker token is refused.

## The money seam

Three pieces, and they only work together:

**`POST /api/token`** is the only gate. It authenticates with Clerk, reads the
balance, refuses a zero one with **402** and a learner who already has a
conversation open with **409**, mints the room and the participant identity
itself (the request body is read for `session_plan` and nothing else), signs
the learner's Clerk id and balance into the agent's dispatch metadata, and only
then writes the `sessions` row the worker will debit against.

**`convex/http.ts`** is the worker's three routes — `POST /tutor/debit`,
`POST /tutor/balance` and `POST /tutor/summary`, all behind the Clerk M2M
token check in `convex/m2m.ts`, all machine-to-machine with no CORS.
**The comment block at the top of that file is the wire contract**: exact paths,
field names, types, bounds and status codes, written for whoever is on the
Python side. Read it before changing either half. `http.ts` itself keeps only
what needs the runtime — the token check, the body-size ceiling, the parse, the
dispatch; every field rule it documents is enforced in **`convex/wire.ts`**, as
pure functions over a parsed body, so the `400` paths are unit-tested directly
(`convex/wire.test.ts`) instead of through an HTTP round trip.

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

Step 3 added the rest of what History needs to say what was **set up**, what
was **done**, and **why it stopped** — all optional, all on the same terms:

| field         | route            | shape                                                                                                                                                                                                                                                                                                                                                                                                          |
| ------------- | ---------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `goal`        | `/tutor/summary` | `{ text (<= 200), forms (<= 8 x 60), source }`, `source` one of `plan` / `tool` / `extracted`. The confirmed goal — the session's spine, sent the moment it is confirmed rather than held to teardown. `source` is how much to trust it: an `extracted` goal was never said back to the learner.                                                                                                               |
| `turns`       | `/tutor/summary` | integer `0..100000`. Learner turns committed — how much they actually spoke, which seconds are not.                                                                                                                                                                                                                                                                                                            |
| `anchorRatio` | `/tutor/summary` | `0..1`. The share of those turns spoken mostly in the anchor language: the learner falling back to English, and the input support-on-evidence reads.                                                                                                                                                                                                                                                           |
| `asks`        | `/tutor/summary` | `<= 25` strings of `<= 400` chars — the Ask tab's questions, in order. Questions only; what the learner did not know is the study record.                                                                                                                                                                                                                                                                      |
| `lookups`     | `/tutor/summary` | `<= 100` of `{ source, translation }`, strings `<= 200` — every select-to-translate lookup. It lived in an overlay that unmounted on resume.                                                                                                                                                                                                                                                                   |
| `endReason`   | `/tutor/debit`   | as `reason` on the **final** report only: `ended`, `out_of_minutes_idle`, `hold_idle`, `learner_left`, `model_error`, `ledger_failure`, `tutor_silent`. `stale` is in the enum too, but it is the reconciliation cron's word, not the worker's.                                                                                                                                                                |
| `estCostUsd`  | `/tutor/summary` | finite, `0..1000`. The worker's estimated MODEL spend for the session in USD (`backend/src/usage.py`) — realtime audio plus every text call. **Internal: no surface renders it.** It is what the conversation cost to RUN, not what the learner was billed (that is `secondsBilled` against the ledger); it exists so "does a ten-minute conversation make money" can be answered without reading worker logs. |

`endReason` is the one field with a rule of its own: **written once, never
overwritten.** The first `final: true` report is the one that was actually
there when it stopped; a redispatched job's teardown is guessing. It is also
written independently of `endedAt`, so a session the client's `sessions.finish`
already closed still gets its explanation — the case History most needs. Absent
means "we do not know", never "it ended cleanly". The one other writer is the
reconciliation cron (`sessions.reconcileStale`), which marks a row nobody ever
closed `stale` — and only where no reason is there already, on the same rule:
whoever was actually present said it first.

Every field is optional and independently written (a field absent from
the body is left untouched, sending one again replaces it wholesale), and the
call is order-independent with the final debit — either may be the one that
creates the row. Bounds and exact field names are in the `http.ts` contract
block; over a bound is a `400` at the wire and a clamp in the mutation, so a
bound raised on one side never turns a teardown report into a `500`.

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
(`convex/sessions.test.ts`) and the wire that guards them
(`convex/wire.test.ts` — the `400` paths of all three routes, field by field:
seconds and seq bounds, a truthy-string `final`, an unknown end reason, an
unknown transcript role, the goal shape and source, the review keys,
`anchorRatio` / `turns` / `asks` / `lookups` / `estCostUsd` bounds, and an
optional `room` on balance). `sessions.test.ts` covers room ownership, the
one-open-session guard, ref idempotency, the high-water delta, the
reconciliation cron (including the `stale` reason it writes and never
overwrites), and — for
`recordSummary` / `byRoom` / `history` — clamping, cross-learner refusal,
order-independence with the final debit, and paging finished rows past a run of
abandoned ones. Step 3 adds the goal / turns / anchor-ratio / asks / lookups
bounds and the `endReason` rules (ignored on a periodic report, written by the
first final one, never moved by a later one, written even onto a row the client
already closed).
