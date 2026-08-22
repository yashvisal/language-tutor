# Phase 5: the product shell — landing, auth, minutes, packs

*Status: proposed 2026-08-21, pending Yash's review. Phase 5 by Yash's call (2026-08-21): the product shell around the session.
It takes over workstreams 1, 2, 3, 5 and 6 of `phase-4-sellable-sessions.md` — everything around the session that turns the
playground into a product. Vendors are settled there: Clerk (email + Google),
Convex, Stripe Checkout. Read `product-vision.md` first; the taste rules
("Notion-like restraint", no SaaS dashboard, no gamification) apply to every
screen below.*

## Decisions (2026-08-21, Yash)

- **Auth is modal-based**: Clerk's modal components from every CTA; the
  `/sign-in`/`/sign-up` routes stay only as redirect fallbacks. Restyling the
  auth UI is deferred.
- **Theme**: stay faithful to the installed shadcn theme — no base typography
  or token changes. The product accent is the Aura's light blue; the landing
  pages key off it.
- **Two landing pages to compare**: (1) a conventional one, blue-accented;
  (2) an orb-centered one built around the Aura and a mocked conversation —
  creative latitude, scroll may grow the orb into a demo. Yash picks which
  becomes `/`.
- **Navigation**: signed-in pages get a sidebar plus a header with the Clerk
  user button (shadcn primitives throughout). Home is `/home` (not `/app`).
- **No `/minutes` route and no Stripe yet** — pricing appears only as the
  static pack numbers in the landing's pricing section. Payments and the
  session-length rule are deferred.
- The account page is `/settings`.

## The one idea

**The learner thinks in minutes; we sell credits.** Every screen shows
minutes ("23 minutes left"), never credits, points or tokens. A credit is the
purchase unit (10 minutes) and appears only on the packs screen. Speech is
metered; everything else — study, review, the app itself — is free and says so.

## Routes and flows

```
/                landing (public)            → Start speaking → sign-up modal
/sign-in         redirect fallback only      → /home
/sign-up         redirect fallback only      → /welcome (first time only)
/welcome         onboarding-lite: level      → /home
/home            home = session pre-flight   → Start → /session
/session         the live session (exists)   → summary → /home
/settings        email, level, sessions, sign out
/terms /privacy  stubs until real copy exists

Auth is modal (see Decisions); pricing is static copy in the landing's pricing
section, so there is no /minutes route and no checkout until payments land.
```

### 1. Landing (`/`)

One screen, typography-led, no hero illustration, no feature grid.

- **Thesis** in one line and one paragraph: you speak Spanish with a tutor who
  doesn't interrupt; afterwards you see what you should have said, and why.
- **One call to action:** "Start speaking — your first 10 minutes are free",
  opening Clerk's sign-up modal in place. A signed-in visitor sees "Continue"
  → `/home` instead.
- **How it works**, three short lines, not cards: *speak* / *see your words* /
  *see what you should have said*. Optionally the Definition-of-Success
  sentence from the vision doc as the copy, verbatim — it is already the
  product.
- **Pricing**, quietly, at the bottom: the three packs with minutes and price,
  and "pausing to study is free". No comparison table. Static copy — this is
  where pricing lives, in the absence of a `/minutes` route.
- Footer: sign in, terms, privacy. Nothing else.

What it deliberately lacks: a demo video, testimonials, a chat-style mockup
(vision: do not default to chat UI), a second CTA.

### 2. Auth (modal)

Clerk's `<SignInButton mode="modal">` / `<SignUpButton mode="modal">` from every
CTA: the learner never leaves the page they were reading. Email + Google only,
and restyling the Clerk UI is deferred. The `/sign-in` and `/sign-up` routes
exist only as redirect fallbacks for links Clerk itself generates.

`middleware.ts` protects `/home`, `/session`, `/settings`, `/welcome`, and the
token route. Landing, auth and legal routes are public.

### 3. Onboarding-lite (`/welcome`)

Shown once, after the first sign-up (the `users` row has no `level`).

- One question: self-declared level, the existing three `LEVELS`, middle one
  preselected ("I understand more than I can say").
- One line under it: "You have 10 free minutes. Pausing to study doesn't use
  them."
- Continue → writes `users.level`, grants the signup credit (idempotent), →
  `/home`.

No assessment, no goals, no language choice (Spanish only until monetized).

### 4. Home (`/home`)

The session pre-flight *is* the home screen — there is nothing else a learner
comes here to do. Layout, top to bottom:

- **Balance line**, not a pill, not a card: "23 minutes left". Plain text at
  the top, in the muted foreground. See "Balance states". The "· Add minutes"
  half arrives with payments; until then there is nowhere for it to go.
- **The plan picker** (exists: `session-preflight.tsx` — scenario chips, topic,
  tenses, level). Level is prefilled from `users.level`.
- **Start** (primary). Disabled with "Get minutes" in its place at zero.
- **Recent sessions**, below a hairline, only if there are any: date, scenario
  or topic, minutes, number of corrections. Three to five rows, "All sessions"
  → `/settings`. Text rows, no cards.

The Clerk `<UserButton/>` sits top-right on every signed-in screen; it is the
only chrome.

### 5. Session (`/session`) — exists

Unchanged inside. Two seams:

- The token route reads the balance from Convex and embeds `user_id` and
  `max_minutes = min(10, balance)` in the dispatch metadata (replaces the
  `SESSION_MAX_MINUTES` constant). Balance 0 → 402, and the client says so
  instead of connecting.
- The post-session summary's **"Buy more minutes"** stays inert until payments
  land. It is the primary button when the balance after this session is under
  10, secondary otherwise.

### 6. Pricing (static, in the landing)

No `/minutes` route and no Stripe in this phase (see Decisions) — these three
packs appear only as copy in the landing's pricing section. Prices from the
existing placeholder (`session-summary.tsx`), which already satisfy the
≥3× rule against the measured ~$0.90 per credit:

| Pack | Minutes | Price | Per credit | Margin |
|---|---|---|---|---|
| 1 credit | 10 | $3.99 | $3.99 | 4.4× |
| 5 credits | 50 | $15.99 | $3.20 | 3.5× |
| 12 credits | 120 | $34.99 | $2.92 | 3.2× |

Presented as three rows or three quiet bordered tiles — one highlighted
(5 credits) by border, not color. Each: minutes large, price, per-10-minutes
price small. One line above: "Minutes never expire. Pausing to study is free."
No buttons: nothing is buyable yet.

Deferred with payments, and written down so the later step has one reference:
Stripe Checkout (hosted; settled) returning to a paid state, the webhook
writing the grant, and Convex's reactivity updating the balance line without
polling — "Confirming your purchase…" while the grant is in flight, never a
spinner page.

### 7. Settings (`/settings`)

Minimal: email (Clerk-managed, read-only — the `<UserButton/>` dropdown owns
changing it), level (editable, same three options), all sessions (date, plan,
minutes), sign out. Purchases join the page when payments do. Text, hairlines,
no cards.

## Balance states

Everywhere the balance appears it has exactly three states:

| State | Rule | Treatment |
|---|---|---|
| Fine | ≥ 10 min | Muted text: "23 minutes left" |
| Low | 1–9 min | Foreground text + "Add minutes" link gains the accent; the summary's buy button becomes primary |
| Empty | 0 | Start is disabled and says so; `/session` refuses to connect; summary leads with buy (inert until payments) |

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
  **Balance = sum(minutes).** Never a mutable field. When debits land and a
  learner's ledger grows past what is sane to scan on every read, the ledger
  stays authoritative and the fix must not break the sum: either a separate
  `ledgerCheckpoints` table (balance as of a ledger entry; reads sum only the
  entries after the newest checkpoint) — checkpoints never live in the ledger
  itself, or they double-count — or a denormalized balance maintained in the
  same transaction as every write. Never a balance that can be written
  independently of an entry.
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
1. **Identity** — modal auth (with the `/sign-in`, `/sign-up` fallbacks),
   `/welcome`, `users` row on first sign-in, signup grant, `<UserButton/>`.
   `/home` renders the existing pre-flight behind auth with a static balance
   line.
2. **Minutes** — balance query, the three balance states, token route gated
   and carrying `user_id`/`max_minutes`, worker debit via the Convex HTTP
   action, `sessions` rows. *Exit check: the ledger reconciles with the
   worker's `session minutes billed` log line.*
3. **Packs** — *deferred past this phase.* When it lands: a checkout surface,
   Stripe Checkout action, webhook, `purchases`, live balance on return,
   summary's buy button live. Test mode throughout.
4. **Settings + deploy** — `/settings`, sessions list, Vercel (frontend) and
   `lk agent create` (worker) with secrets, landing polish, a stranger runs
   the exit criteria from the phase-4 plan. Real, reviewed `/terms` and
   `/privacy` copy is a launch blocker — the stubs ship, but nothing takes
   money until they are replaced.

## Decisions needed from Yash before step 0

*Kept as a record. 1–3 are settled by the Decisions block at the top; 4 stands
minus the Stripe keys, which wait for payments.*

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
