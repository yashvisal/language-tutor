# Launch checklist — 2026-09-14

*Written after PR #11 (the landing rework) merged. Four read-only audits ran
against `main` at `ea07eb7`: the frontend production build and runtime, the
Convex backend, the Python worker, and a reconciliation of
`phases/phase-8-launch.md` against the code. This file supersedes the
findings list in `audit-2026-09-06.md` where the code has changed; L1, L2 and
L4 from that audit are confirmed fixed and are not repeated here. Read
`product-vision.md` first; nothing here reopens a settled decision.*

**Verdict.** The conversation product, the session lease, the metering
contract between worker and ledger, route protection, and the landing page
are sound. What stands between this checkout and a public link is: four
functional bugs (two in the worker, two in the ledger), a mobile layout
break on the landing hero, no error boundaries, no metadata or icons, legal
pages that still say "tutor", no error reporting, and a decision about
payments. None of it is a redesign.

**The one decision that shapes everything else:** launch a **closed beta
with free minutes only** (no checkout), or build billing first. Everything
below is written for the beta-first path, which the 2026-09-06 audit and
phase 8's open decision (c) both lean toward. Items that only matter once
money moves are marked *(paid launch)*.

---

## A. Fix before any public link

Functional bugs first, then the things a stranger hits in the first minute.

### Worker (`backend/src`)

- [ ] **A1. A tutor that never speaks leaves a session nobody can end.**
      `clock.start()` is only called when the agent state flips to
      `speaking` (`agent.py:952`, `clock.py:186`). If the first tutor audio
      never arrives, no clock path exists to end the session; `_watchdog`
      publishes `tutor_silent` after 20 s and returns, while `_renew_lease`
      (`agent.py:886`) keeps the lease alive every 60 s. The learner cannot
      start another conversation until they close the tab and the lease
      lapses (3 min). Fix: the watchdog ends the session through
      `_end_session(code="tutor_silent")`, or the clock loop starts at
      `session.start` with only accrual gated on first audio.
- [ ] **A2. Fail-closed refusals leave a frozen stage with no error code.**
      The `no user_id` and `ledger unreachable` refusals (`agent.py:814`,
      `:866`) call `ctx.shutdown()` without `ctx.connect()` and
      `_publish_error()`, unlike the balance refusal which uses
      `_say_and_leave` (`:870`). A production worker with `CONVEX_SITE_URL`
      or the machine key unset produces a room the agent never joins,
      indistinguishable from a dispatch failure. A bad `OPENAI_API_KEY`
      raises per job in `TutorConfig.from_env()` (`config.py:354`) and
      `_prewarm` only logs it (`agent.py:435`). Fix: route both refusals
      through `_say_and_leave` with dedicated codes, add a config-fault code.

### Ledger (`frontend/convex`)

- [ ] **A3. A debit can land on a row the cron already closed.**
      `sessions.debit` (`sessions.ts:288-417`) never checks `endedAt` before
      writing the ledger row; it only guards the `endedAt`/`leaseUntil`
      patches. Worker loses network >3 min → lease expires → `reconcileStale`
      closes the row → learner starts a second conversation → old worker
      reconnects and debits once more before its renew returns `closed`.
      Two spenders on one balance for up to a minute. Fix: refuse (or
      accept-without-billing and log) a debit whose row has `endedAt`, on
      the same terms `open` refuses with `closed` (`:218`). Add the test
      "billing after close" next to `sessions.test.ts:601`.
- [ ] **A4. `debit` and `recordSummary` adopt unknown rooms with a fresh
      lease.** `sessions.ts:337-346` and `:585-599` insert a leased row for
      any room name without consulting `activeSessionFor` or `rateLimited`.
      A worker told `open_session` that did not shut down, or a replayed
      worker token, creates a second billable reservation; a summary for an
      arbitrary room blocks the learner's next start for three minutes.
      Fix: adopt without a lease, or refuse adoption while another session
      is leased for that learner.

### Landing on a phone (`frontend/app/page.tsx`)

- [ ] **A5. The hero CTA runs off the screen at 390px.** The button row
      (`page.tsx:83`) is `flex items-center gap-2` and buttons are
      `whitespace-nowrap`; the primary label plus "How it works" is 435px in
      a 375px content box. Measured on the production build: the primary
      button's rect runs from x = -30 to 290. Fix: `flex-col sm:flex-row`
      (or `flex-wrap justify-center`), and consider the bare "Start
      speaking" label below `sm` since the grant is stated in Minutes.
- [ ] **A6. The page scrolls sideways on a phone.** The hero wash
      (`page.tsx:58`, 40rem wide) and the closing orb's glow overflow a
      375px viewport (`scrollWidth` 508 vs 375). Fix: `overflow-x-clip` on
      those two sections or the page wrapper; verify at 390×844 and 360×800
      before pushing (per the rendering-fixes rule).

### Error surfaces (`frontend/app`)

- [ ] **A7. No error boundaries.** No `error.tsx`, `global-error.tsx`, or
      `not-found.tsx` anywhere. A throw in `/home` or `/session` renders
      Next's bare "Application error" with no way back, and with no error
      reporting (A9) nobody learns it happened. Add all three in the
      marketing shell with a link home.

### Metadata, icons, crawlers

- [ ] **A8. Root metadata, icons, robots, sitemap.** `app/layout.tsx` exports
      no `metadata`: no `metadataBase`, `title.template`, `openGraph`,
      `twitter`; `/sign-in` and `/sign-up` have no `<title>` at all. A link
      to lengua.chat unfurls as a bare URL. `app/favicon.ico` is the stock
      create-next-app icon (unchanged since `aceb408`). `public/` holds only
      the flags. Add: root `metadata` with `metadataBase: new URL("https://lengua.chat")`
      and `title: { default, template: "%s · lengua" }`; `app/opengraph-image.tsx`;
      `app/icon.svg` + `apple-icon`; `app/robots.ts` (disallow `/home`,
      `/session`, `/design-inspo`); `app/sitemap.ts` for `/`, `/terms`,
      `/privacy`; `export const viewport` with `themeColor`.

### Legal (`frontend/app/terms`, `frontend/app/privacy`)

- [ ] **A9. The product is still "tutor" in both legal pages**, with the
      draft banner on. `terms/page.tsx` lines 21, 30, 36, 38, 99, 123, 141,
      151; `privacy/page.tsx` 21, 26, 165. Placeholders still live: contact
      `hello@ (address: to set)` (terms:164, privacy:175), governing law
      (terms:158), refund window (terms:90), minimum age (privacy:165),
      payment provider (privacy:143). Both pass `draft` to `LegalPage`.
      Yash signs off values; then remove `draft`.
- [ ] **A10. Privacy claims to keep.** Add a cookies section (Clerk session
      cookies, theme in localStorage); add the error reporter to the
      processors list once A11 lands; the processors list is otherwise
      correct (Clerk, Convex, LiveKit, OpenAI, Vercel). *(paid launch)* the
      deletion promise must cover `purchases` (see C4).

### Error reporting

- [ ] **A11. Sentry on all three surfaces.** Nothing is wired: no
      `@sentry/nextjs`, no `sentry_sdk`, `convex/http.ts:516,534,548` and
      `m2m.ts:155` are bare `console.error`. Phase 8 piece 1, not started.
      Highest-value captures: webhook signature failure, M2M rejection,
      failed debit, `reconcileStale` closing a row with billed seconds, a
      balance below zero, dispatch failure, `tutor_silent`.
- [ ] **A12. Stop logging learner text.** The worker logs turn text at INFO
      (`agent.py:306`, first 80 chars), plan prose via `plan.log_fields()`
      (`agent.py:501`), goal text (`agent.py:281`, `goal.py:155`), and
      `user_id` (`clock.py:418`). Phase 8 decision (b) says ids only, never
      transcript. Drop the text field; demote plan/goal prose to DEBUG or
      hash it; give Sentry a `before_send` that scrubs the same.

### Footer

- [ ] **A13. A way to reach someone.** `marketing-footer.tsx` has no contact
      link and no copyright line; Terms says the contact is unset. Add the
      support address from A9.

---

## B. Deploy (phase 8, in dependency order, with what the audit added)

Nothing in this section is code except where noted. Production account
state, DNS and quotas were not inspected by any audit.

- [ ] **B1. Clerk production instance.** Custom domain + DNS (`clerk`,
      `accounts`, `clkmail`, DKIM); `pk_live`/`sk_live` → Vercel env; the
      `convex` JWT template with `aud: convex` **and** `email`
      (`convex/users.ts` reads it); Google OAuth prod credentials; bot
      protection + required email verification (this is also the only
      defence against C3); two M2M machines `tutor-worker` and
      `tutor-ledger`, worker scoped to ledger; webhook endpoint
      `<convex prod site url>/clerk/webhook` for `user.deleted`.
- [ ] **B2. Convex production.** Env: `CLERK_FRONTEND_API_URL`,
      `CLERK_JWT_KEY` (prod JWKS as PEM), `TUTOR_WORKER_MACHINE_ID`,
      `TUTOR_LEDGER_MACHINE_ID`, `CLERK_WEBHOOK_SIGNING_SECRET`, Sentry DSN
      once A11 exists. The audit confirmed this list is exactly what the
      code reads; missing any of the middle three turns every `/tutor/*`
      call into a 401. `CONVEX_DEPLOY_KEY` for the Vercel build
      (`npx convex deploy --cmd "pnpm build"`, documented in
      `frontend/README.md:48-61`).
- [ ] **B3. Vercel.** Full env from the `frontend/README.md` table;
      `packageManager`/`engines` already pinned; security headers already in
      `next.config.ts`. Production domain **lengua.chat**; Clerk redirect
      URLs updated; `metadataBase` (A8) matches. Consider a `vercel.json`
      so root directory and build command are in the repo, not only the
      dashboard. Delete the stray `OPENAI_API_KEY`, `XAI_API_KEY` and
      `NEXT_PUBLIC_CONVEX_SITE_URL` from `frontend/.env.local` before anyone
      pushes it wholesale; the frontend never reads them.
- [ ] **B4. Worker (`lk agent create`).** *(code)* Check in the deploy
      artifact: Dockerfile or `livekit.toml`, pinned Python, `uv sync --frozen`
      from `uv.lock`, the start command. Secrets: `LIVEKIT_*`,
      `OPENAI_API_KEY`, `CONVEX_SITE_URL` (prod), `CLERK_WORKER_MACHINE_SECRET_KEY`,
      **`TUTOR_ENV=production`**, Sentry DSN. Never `TUTOR_ALLOW_UNMETERED`
      (the config refuses it in production; verified). Pin dated model
      snapshots via `TUTOR_REALTIME_MODEL` etc. rather than the floating
      aliases in `config.py:278-300`. Rollout order for any schema change is
      Convex → worker → frontend.
- [ ] **B5. Verify model access on the production OpenAI project** for
      `gpt-realtime-2.1`, `gpt-live-transcribe`, `gpt-5.6-luna`; a local
      run proves nothing about production entitlements or quotas.
- [ ] **B6. Load-test one worker instance** before the first link (audit
      §4.11): headroom per instance for a realtime-audio agent is unknown.

---

## C. Before opening the beta wider (SHOULD)

- [ ] **C1. Balance floor.** Nothing enforces a non-negative balance
      (`sessions.ts:361-369`); the zero-hold lives in the worker's clock.
      `viewer` clamps `minutes` to 0 so a deficit is invisible everywhere.
      At minimum alert when `secondsFor` would cross below zero; decide
      whether a later grant clears the deficit.
- [ ] **C2. `users.secondsFor` collects the whole ledger per read**
      (`users.ts:29-38`), called on every balance read and three times per
      debit. One row per active minute; a heavy user will hit Convex's
      per-query document limit and their dashboard, token route and every
      future debit break at once. Audit L9. Fix with a checkpoint row and
      read newest checkpoint + rows after it.
- [ ] **C3. Free-grant farming.** The signup grant is keyed on `clerkId`
      (`users.ts:162`); delete-and-resignup is a new 300 s. Either key on a
      verified-email hash as well, or accept it explicitly with B1's bot
      protection + email verification and a beta cap.
- [ ] **C4. Tests for the only money entry point.** `ensureUser`, `viewer`,
      `ledger`, `balanceByClerkId` have no tests; `users.test.ts` covers
      only `setBalance` and `deleteByClerkId`. Add: grant exactly once
      across two concurrent `ensureUser` calls; an existing row without a
      grant gets one; `viewer` for a rowless identity.
- [ ] **C5. Worker tests.** `agent.py` is effectively untested: `_open_ledger`
      (the L4 guard was closed by a probe, not a test), hold/resume RPC,
      disconnect grace, `_watch_session_errors`. `analyzer.py`, `ask.py`,
      `translate.py` have no test module. Regression tests for A1 and A2
      belong here too.
- [ ] **C6. Cap select-to-translate.** Ask is capped at 25 before the model
      call (`ask.py:296`); translate has no per-session count
      (`translate.py:138`), and lookups happen during free holds including
      the zero-balance hold. Mirror Ask's invisible cap.
- [ ] **C7. Pins.** `livekit-agents[openai]~=1.8.1` and `openai>=2.0.0,<3`
      float on minor versions; deploy from `uv.lock` only (B4). Frontend:
      `shadcn` is a production dependency and drags the `fast-uri`/`qs`
      advisories from audit L6 into the prod tree; move it to dev and
      re-run `pnpm audit --prod`.
- [ ] **C8. `.env.example` files** for `frontend/` and `backend/`, and a
      `!.env.example` negation in `.gitignore:31`. The env contract exists
      only as README tables today.
- [ ] **C9. HSTS** in `next.config.ts` headers (Vercel adds it on a custom
      domain, but it isn't in the config's own contract).
- [ ] **C10. Landing heading semantics.** The `<h2>`s are the uppercase
      eyebrows and the section sentences are `<p>`; a screen reader's
      heading list is three shouted labels. Make the sentence the `<h2>`
      and the eyebrow a `<p>` (or `aria-hidden`).
- [ ] **C11. Small hygiene.** Four unused-import lint warnings
      (`app-header.tsx:32`, `settings-dialog.tsx:15`, `start-session.tsx:20,38`);
      `README.md:1` and `frontend/package.json` name still "tutor"/
      "language-tutor"; raw `throw new Error` in `sessions.ts:217,312,487,581`
      and `users.ts:220` reach the client as "Server Error" (use
      `ConvexError` where the UI should branch); `reconcileStale`'s legacy
      filter sits after the `take(100)` (`sessions.ts:1059-1072`); stale
      doc lines at `translate.py:11` and the greeting docstring.

---

## D. Paid launch (deferred if the beta is free-minutes only)

- [ ] **D1. Choose the rail** (phase 8 open decision (a)). The schema
      presumes Stripe (`purchases.stripeSessionId`).
- [ ] **D2. `purchases.minutes` → seconds** (`schema.ts:213`) before any
      writer exists.
- [ ] **D3. Checkout + webhook + grant**, idempotent on the payment id via
      a `creditLedger` row with `ref = <payment intent id>`; refunds, replay,
      out-of-order events.
- [ ] **D4. Deletion sweeps `purchases`** (`users.ts:287-318` deletes ledger,
      sessions, user only). Ship with D3 in the same commit.
- [ ] **D5. Buy-and-continue**: `study-overlay.tsx` refuses to close at
      zero, `out-of-minutes.tsx` offers only "Back to home",
      `billing-dialog.tsx:83-86` is "Coming soon". The worker already
      supports balance refresh on resume.
- [ ] **D6. Validate economics** (audit L8): `usage.py` applies one price
      set regardless of model and text prices are unverified; reconcile
      several real sessions against provider usage before setting packs.
      Terms' refund clause depends on this.

---

## E. The stranger's smoke test, on the production stack

Run in order once A and B are done. Steps 5 and 6 only apply to a paid launch.

1. Fresh incognito sign-up → `/home` shows the free minutes (proves the prod
   JWT template and `ensureUser` + grant).
2. Start → the tutor speaks within ~5 s with the goal line (dispatch and
   worker env).
3. Talk ~60 s, end → `creditLedger` debit equals the worker's billed line;
   `/home` balance down by that; History has the row with `about`, goal,
   Review, transcript.
4. Reload `/` and `/home` several times: no orb flash, no hydration warning.
5. *(paid)* Buy the smallest pack live → balance rises; replayed webhook
   grants nothing.
6. *(paid)* Burn to zero → hold → buy in-session → the same conversation
   continues.
7. Kill the worker mid-session → seconds still billed; the row closes
   (`final`) or the cron sweeps it; the learner can start again within
   3 min. Then the A3 case: reconnect the old worker and confirm no extra
   debit lands.
8. Block the microphone; unset `CONVEX_SITE_URL` on a staging worker: the
   learner sees an error with a way home, not a frozen stage (A2).
9. Delete the account in Clerk → Convex rows gone; replay the webhook → 200,
   nothing changes.
10. A real conversation in each of the five languages, including
    code-switching to English and a mid-word pause (audit L10).
11. Phone (390 wide) and keyboard-only pass over `/`, sign-in, `/home`, a
    session; dark mode on each.

---

## F. Verified OK (do not re-audit)

- `pnpm typecheck`, `pnpm lint` (0 errors), `pnpm test` (120 pass),
  `pnpm build` (zero errors and warnings, Next 16.3.3). Backend
  `uv run pytest` 192 pass; ruff lint and format clean.
- Production server: `/`, `/sign-in`, `/sign-up`, `/terms`, `/privacy` 200;
  `/home` and `/session` 307 to sign-in when signed out; `/design-inspo`
  404 in production; `/api/token` 401/405 and never 500; security headers
  on every response; no console errors or hydration warnings on `/`,
  `/sign-in`, `/terms`.
- Layout at 1440×900, 1024×768, 768×1024 is clean.
- No secrets in tracked files; no `TODO`/`console.log` in app code; no
  hardcoded localhost or dev keys; reduced motion respected throughout.
- Every public Convex function checks identity first and ownership before
  the first write; every function has args and returns validators; every
  query uses an index; M2M verifies subject and scope and fails closed; the
  Clerk webhook verifies signatures, fails closed without the secret, and
  logs no PII. Debit idempotency is doubly guarded (ref + high-water mark)
  and the Python side serialises debits under one lock; the contract
  matches on both halves.
- Worker: `interruption={"mode": "vad"}`, agent-owned turn detection, one
  realtime model, no Grok remnants; `TUTOR_ENV=production` refuses
  `TUTOR_ALLOW_UNMETERED`; every outbound call has a timeout; malformed LLM
  JSON is dropped field by field; prompts are fully parameterised on
  target/anchor language.
- Route protection (`proxy.ts`), auth-before-read (`use-authed-query.ts`),
  server-side viewer creation with redirect on null.

## G. Open decisions for Yash

- (a) Beta with free minutes only, or build D first. The checklist assumes
  the former.
- (b) Sentry: capture Clerk ids (recommend yes, ids only) and a sampling rate.
- (c) Beta exposure cap: at 300 free seconds per account (~$0.45), how many
  accounts before the link comes down.
- (d) Legal values: support address, governing law, minimum age, refund
  window.
- (e) Portugal's flag for Portuguese: keep, or swap for Brazil's.
