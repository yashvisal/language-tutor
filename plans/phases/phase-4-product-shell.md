# Phase 4, the product shell: landing, auth, minutes, packs

*Status: proposed 2026-08-21, pending Yash's review. This is the design and
build plan for workstreams 1, 2, 3, 5 and 6 of
`phase-4-sellable-sessions.md` — everything around the session that turns the
playground into a product. Vendors are settled there: Clerk (email + Google),
Convex, Stripe Checkout. Read `product-vision.md` first; the taste rules
("Notion-like restraint", no SaaS dashboard, no gamification) apply to every
screen below.*

## The one idea

**The learner thinks in minutes; we sell credits.** Every screen shows
minutes ("23 minutes left"), never credits, points or tokens. A credit is the
purchase unit (10 minutes) and appears only on the packs screen. Speech is
metered; everything else — study, review, the app itself — is free and says so.

## Routes and flows

```
/                landing (public)            → Start speaking → /sign-up
/sign-in         Clerk, embedded             → /app
/sign-up         Clerk, embedded             → /welcome (first time only)
/welcome         onboarding-lite: level      → /app
/app             home = session pre-flight   → Start → /session
/session         the live session (exists)   → summary → /app | /minutes
/minutes         packs, Stripe Checkout      → Stripe → /minutes?paid=1
/account         email, level, purchases, sign out
```

### 1. Landing (`/`)

One screen, typography-led, no hero illustration, no feature grid.

- **Thesis** in one line and one paragraph: you speak Spanish with a tutor who
  doesn't interrupt; afterwards you see what you should have said, and why.
- **One call to action:** "Start speaking — your first 10 minutes are free"
  → `/sign-up`. A signed-in visitor sees "Continue" → `/app` instead.
- **How it works**, three short lines, not cards: *speak* / *see your words* /
  *see what you should have said*. Optionally the Definition-of-Success
  sentence from the vision doc as the copy, verbatim — it is already the
  product.
- **Pricing**, quietly, at the bottom: the three packs with minutes and price,
  and "pausing to study is free". No comparison table.
- Footer: sign in, terms, privacy. Nothing else.

What it deliberately lacks: a demo video, testimonials, a chat-style mockup
(vision: do not default to chat UI), a second CTA.

### 2. Auth (`/sign-in`, `/sign-up`)

Clerk's embedded `<SignIn/>` / `<SignUp/>` on our own routes, restyled to the
app's type and spacing (Clerk's appearance API), not the hosted pages — the
hosted pages look like Clerk, and the first screen after the landing should
look like us. Email + Google only.

`middleware.ts` protects `/app`, `/session`, `/minutes`, `/account`, and the
token route. Landing and auth routes are public.

### 3. Onboarding-lite (`/welcome`)

Shown once, after the first sign-up (the `users` row has no `level`).

- One question: self-declared level, the existing three `LEVELS`, middle one
  preselected ("I understand more than I can say").
- One line under it: "You have 10 free minutes. Pausing to study doesn't use
  them."
- Continue → writes `users.level`, grants the signup credit (idempotent), →
  `/app`.

No assessment, no goals, no language choice (Spanish only until monetized).

### 4. Home (`/app`)

The session pre-flight *is* the home screen — there is nothing else a learner
comes here to do. Layout, top to bottom:

- **Balance line**, not a pill, not a card: "23 minutes left · Add minutes".
  Plain text at the top, in the muted foreground. See "Balance states".
- **The plan picker** (exists: `session-preflight.tsx` — scenario chips, topic,
  tenses, level). Level is prefilled from `users.level`.
- **Start** (primary). Disabled with "Get minutes" in its place at zero.
- **Recent sessions**, below a hairline, only if there are any: date, scenario
  or topic, minutes, number of corrections. Three to five rows, "All sessions"
  → `/account`. Text rows, no cards.

The Clerk `<UserButton/>` sits top-right on every signed-in screen; it is the
only chrome.

### 5. Session (`/session`) — exists

Unchanged inside. Two seams:

- The token route reads the balance from Convex and embeds `user_id` and
  `max_minutes = min(10, balance)` in the dispatch metadata (replaces the
  `SESSION_MAX_MINUTES` constant). Balance 0 → 402, and the client sends the
  learner to `/minutes` instead of connecting.
- The post-session summary's **"Buy more minutes"** becomes live → `/minutes`.
  It is the primary button when the balance after this session is under 10,
  secondary otherwise.

### 6. Packs (`/minutes`)

Three packs, prices from the existing placeholder (`session-summary.tsx`),
which already satisfy the ≥3× rule against the measured ~$0.90 per credit:

| Pack | Minutes | Price | Per credit | Margin |
|---|---|---|---|---|
| 1 credit | 10 | $3.99 | $3.99 | 4.4× |
| 5 credits | 50 | $15.99 | $3.20 | 3.5× |
| 12 credits | 120 | $34.99 | $2.92 | 3.2× |

Presented as three rows or three quiet bordered tiles — one highlighted
(5 credits) by border, not color. Each: minutes large, price, per-10-minutes
price small. One line above: "Minutes never expire. Pausing to study is free."
Button per pack → Stripe Checkout (hosted; settled) → returns to
`/minutes?paid=1`.

On return: the webhook has usually already written the grant; Convex is
reactive, so the balance line updates live without polling. Show "Added 50
minutes" once, then the normal screen. If the webhook is slow, the line reads
"Confirming your purchase…" until the grant lands — never a spinner page.

### 7. Account (`/account`)

Minimal: email (Clerk-managed), level (editable, same three options),
purchases (date, pack, status), all sessions (date, plan, minutes), sign out.
Text, hairlines, no cards.

## Balance states

Everywhere the balance appears it has exactly three states:

| State | Rule | Treatment |
|---|---|---|
| Fine | ≥ 10 min | Muted text: "23 minutes left" |
| Low | 1–9 min | Foreground text + "Add minutes" link gains the accent; the summary's buy button becomes primary |
| Empty | 0 | Start → "Get minutes"; `/session` redirects to `/minutes`; summary leads with buy |

During a session the existing `MinutesPill` and one-minute warning stand; they
read the worker's `tutor.minutes_left` attribute and never compute.

## Data (Convex)

Per the phase-4 plan; spelled out so the build has one reference.

- `users` — `clerkId`, `email`, `level`, `targetLang` ("es"), `anchorLang`
  ("en"), `createdAt`.
- `creditLedger` — append-only. `userId`, `kind`
  (`signup_grant` | `purchase` | `debit` | `adjustment`), `minutes` (signed),
  `ref` (Stripe session id, or room name for debits — **unique per ref**, so a
  retried debit or replayed webhook is a no-op), `createdAt`.
  **Balance = sum(minutes).** Never a mutable field.
- `sessions` — `userId`, `room`, `plan` (the bounded `SessionPlan`),
  `startedAt`, `endedAt`, `minutesBilled`, `corrections` (count, from
  `SessionFacts`).
- `purchases` — `userId`, `stripeSessionId`, `pack`, `minutes`, `amountCents`,
  `status` (`pending` | `paid` | `failed`).

Writers:
- Signup grant: a Convex mutation called once from `/welcome`, idempotent on
  `ref = "signup:" + clerkId`.
- Debit: the worker's `report_minutes_billed` (`backend/src/clock.py`) POSTs
  `{room, user_id, minutes}` to a Convex HTTP action signed with a shared
  secret; the action writes the ledger debit and finalizes the `sessions` row.
  Idempotent on `room`.
- Purchase: Stripe webhook → Convex HTTP action → `purchases.status = paid` +
  ledger grant, idempotent on the Stripe session id.

The token route (`frontend/app/api/token/route.ts`) becomes: Clerk auth →
Convex balance → mint LiveKit token with `user_id` + `max_minutes` → insert
the `sessions` row as started.

## Build order

Each step is one reviewed hand-off; each leaves the app working end to end.

0. **Scaffold** — Clerk provider + middleware, Convex provider + schema + dev
   deployment, env validation for every new key, `/` landing. The playground
   keeps working unauthenticated at `/session` only until step 2.
1. **Identity** — `/sign-in`, `/sign-up`, `/welcome`, `users` row on first
   sign-in, signup grant, `<UserButton/>`. `/app` renders the existing
   pre-flight behind auth with a static balance line.
2. **Minutes** — balance query, the three balance states, token route gated
   and carrying `user_id`/`max_minutes`, worker debit via the Convex HTTP
   action, `sessions` rows. *Exit check: the ledger reconciles with the
   worker's `session minutes billed` log line.*
3. **Packs** — `/minutes`, Stripe Checkout action, webhook, `purchases`,
   live balance on return, summary's buy button live. Test mode throughout.
4. **Account + deploy** — `/account`, sessions list, Vercel (frontend) and
   `lk agent create` (worker) with secrets, landing polish, a stranger runs
   the exit criteria from the phase-4 plan.

## Decisions needed from Yash before step 0

1. Pack prices — keep $3.99 / $15.99 / $34.99 (the placeholder; all ≥3× cost)?
2. Embedded Clerk components restyled to the app (recommended) vs Clerk's
   hosted pages (faster, looks like Clerk)?
3. Session length: one credit caps a session at 10 minutes; a balance under 10
   gives a shorter session rather than blocking (recommended), or require a
   full credit to start?
4. Keys: Clerk (publishable + secret), Convex (deployment URL + deploy key),
   Stripe (test publishable + secret + webhook secret) — and a shared secret
   for the worker → Convex debit action.

## Non-goals for the shell

Subscriptions, referral codes, promo codes, email sequences, analytics
dashboards, a blog, multiple languages, mobile layouts beyond "doesn't break".
