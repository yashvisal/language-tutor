# Phase 7: Product Polish — from audited to shippable

*Status: in build (2026-08-25), branch `phase-7-product-polish`. Phase 6
shipped the dashboard, the modals, and the metered conversation (PR #6).
Phase 7 is everything `audit-2026-08-25.md` says stands between that and a
stranger with a credit card — in the audit's §8 order. Read the vision doc
first; nothing here reopens a settled decision.*

## Steps (each one reviewed hand-off; each leaves the app working)

1. **Money-seam correctness.** Audit B1–B4, B10, §3.1.6, §4.1, §4.9, plus
   `pytest` and clock/billing tests, and the `next` / `livekit-agents`
   bumps (B9, §4.10). *Exit: the ledger reconciles with the worker's billed
   line; a replayed room name and a second tab are refused; a killed worker
   still bills; a dropped learner stops the clock.*
2. **Session lifecycle.** B5, B6, §4.2–4.5 — the failed states a stranger
   hits in their first session.
3. **Prompt + Review.** B7 first, then the §3.2 decisions and build: goal
   crystallization, Review from goal + transcript, support-on-evidence, the
   ordinary-hold idle timeout. The arc residue goes with it.
4. **Quick quality.** §4.13–19 and the §5 polish; dead code.
5. **Ship.** §7 sequence: Clerk prod → Convex prod → Vercel → worker →
   payments (§3.1, rail per Yash's decision) → legal → Sentry → the
   stranger's smoke test.

## Contracts fixed in step 1 (so later steps build on one shape)

- The token route mints the room; the client never names one.
- One open session per learner: `sessions.start` refuses while the caller
  has a row with no `endedAt` younger than 15 minutes; the route returns
  409 and the client says so.
- Debit ref = `<room>:<jobId>:<seq>`. The worker's reported seconds are
  **room-cumulative**: at job start it reads the room's `secondsBilled`
  from Convex and reports `billedBefore + active`, so a redispatched job
  neither double-bills nor bills zero.
- The worker debits every 60 active seconds, at the zero hold, and at
  teardown. A Convex cron closes rows with no `endedAt` and no debit for
  two hours.
- The clock accrues from the first tutor audio frame, and holds when the
  learner's participant leaves the room (a short grace, then shutdown).
- A worker with a `user_id` and no reachable ledger refuses the job unless
  `TUTOR_ALLOW_UNMETERED=1` (local development only).

## Decisions still needed from Yash

(a) payment rail — Stripe-direct or Clerk Billing; (b) goal capture and
whether the tutor says the goal out loud (audit §3.2); (c) minimum
startable balance; (d) ordinary-hold idle timeout.
