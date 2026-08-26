# Phase 8: Launch — Sentry, deployment, billing

*Status: proposed 2026-08-25, starts after phase 7 is merged. Sequence
agreed with Yash: phase 7 step 5 → Yash's e2e test → CodeRabbit triage →
merge → this. Read `product-vision.md` and `phase-7-product-polish.md`
(the contracts) first; nothing here reopens them.*

## The three pieces, in dependency order

1. **Error reporting (Sentry).** Next.js (server routes + client), the
   Python worker (native integration), Convex (a `captureException` in the
   `catch` paths that today only `console.error`). One DSN per environment.
   Goes first because everything after it is easier to debug with it on.
2. **Deployment.** Clerk prod → Convex prod → Vercel → `lk agent create`.
   The ordering is forced: Convex prod fails to deploy until
   `CLERK_FRONTEND_API_URL` is set (`auth.config.ts` throws), which needs
   the Clerk prod instance; Vercel needs the Convex prod URL; the worker
   needs both.
3. **Billing.** Rail to decide (Stripe-direct fits one-off minute packs;
   Clerk Billing is subscription-shaped and would be a payment rail only —
   the ledger stays the entitlement either way). Then checkout, the
   webhook → ledger grant idempotent on the payment id, `purchases` in
   seconds (schema still says `minutes` — fix first), the client half of
   buy-and-continue (`study-overlay.tsx` refuses to close while
   `outOfMinutes`; `out-of-minutes.tsx` offers only "Back to home"), Terms'
   refund clause finalized. Test mode first, then live with one real card.

## Launch checklist (dependency order)

### Clerk production instance
- [ ] Custom domain + DNS (CNAMEs for `clerk`, `accounts`, `clkmail`, DKIM).
- [ ] `pk_live` / `sk_live` → Vercel env.
- [ ] The `convex` JWT template recreated with `aud: convex` **and** `email`
      (`users.ts` reads `email`; `route.ts`, `viewer-server.ts` 401 without it).
- [ ] Google OAuth production credentials.
- [ ] Bot protection + required email verification (the dashboard half of
      audit B12; the code half — 12 starts/hour — is in phase 7).
- [ ] Two M2M machines (`tutor-worker`, `tutor-ledger`), worker scoped to
      ledger; the worker's machine key → worker secrets; both ids +
      `CLERK_JWT_KEY` (prod JWKS as PEM) → Convex prod env.
- [ ] Webhook endpoint `<convex prod site url>/clerk/webhook`, event
      `user.deleted`, signing secret → Convex prod env
      (`CLERK_WEBHOOK_SIGNING_SECRET`).

### Convex production deployment
- [ ] `CLERK_FRONTEND_API_URL`, `CLERK_JWT_KEY`, `TUTOR_WORKER_MACHINE_ID`,
      `TUTOR_LEDGER_MACHINE_ID`, `CLERK_WEBHOOK_SIGNING_SECRET`, Sentry DSN.
- [ ] `CONVEX_DEPLOY_KEY` for the Vercel build
      (`npx convex deploy --cmd "pnpm build"`).

### Vercel
- [ ] Full env (`frontend/README.md` table); `packageManager`/`engines`
      already pinned; security headers already in `next.config.ts`.
- [ ] Production domain; Clerk redirect URLs updated.

### Worker (`lk agent create`)
- [ ] Secrets: `LIVEKIT_*`, `OPENAI_API_KEY`, `CONVEX_SITE_URL` (prod),
      `CLERK_WORKER_MACHINE_SECRET_KEY`, **`TUTOR_ENV=production`**, Sentry
      DSN. Never `TUTOR_ALLOW_UNMETERED`.
- [ ] Load-test one instance before the first public link (audit §4.11 —
      headroom per instance for a realtime-audio agent is unknown).

### Legal
- [ ] Yash signs off Terms + Privacy (placeholders: contact email, governing
      law, minimum age, refund window); remove the "Draft — under review"
      line.

### The stranger's smoke test (on the production stack)
1. Fresh incognito sign-up → `/welcome` (proves the prod JWT template).
2. `/welcome` → `/home` shows the free minutes (proves `ensureUser` + grant).
3. Start → the tutor speaks within ~5 s with the goal line (proves dispatch
   and the worker env).
4. Talk ~60 s, end → `creditLedger` debit equals the worker's billed line;
   `/home` shows the balance down by that; History has the row with its
   `about`, goal, Review, transcript.
5. Buy the smallest pack live → balance rises; `purchases` paid; a replayed
   webhook grants nothing.
6. Burn to zero → out-of-minutes hold → buy in-session → the *same*
   conversation continues.
7. Kill the worker mid-session → seconds still billed (periodic debit); the
   row closes (`final`) or the cron sweeps it.
8. Delete the account in Clerk → the Convex rows are gone.

## Open decisions

(a) the payment rail; (b) Sentry sampling and whether to capture the
learner's Clerk id (recommend: yes, ids only, never transcript text); (c)
whether the first public link is a closed beta (recommend yes — the
free-minute exposure is ~$0.90 per account).
