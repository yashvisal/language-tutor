# Phase 7: Product Polish — from audited to shippable

*Status: in build (2026-08-25), branch `phase-7-product-polish`. Phase 6
shipped the dashboard, the modals, and the metered conversation (PR #6).
Phase 7 is everything `audit-2026-08-25.md` says stands between that and a
stranger with a credit card — in the audit's §8 order. Read the vision doc
first; nothing here reopens a settled decision.*

## Status (2026-08-25)

Steps 1–3 built and pushed (`51e6cab`, `20dfccf`, step 3 on top) with the
M2M swap (`d91a968`). Not yet run live — Yash tests end to end when there
is quiet. Next: step 4 (quick quality), then step 5 pending the payment
rail decision.

## Steps (each one reviewed hand-off; each leaves the app working)

1. **Money-seam correctness.** Audit B1–B4, B10, §3.1.6, §4.1, §4.9, plus
   `pytest` and clock/billing tests, and the `next` / `livekit-agents`
   bumps (B9, §4.10). *Exit: the ledger reconciles with the worker's billed
   line; a replayed room name and a second tab are refused; a killed worker
   still bills; a dropped learner stops the clock.*
2. **Session lifecycle.** B5, B6, §4.2–4.5 — the failed states a stranger
   hits in their first session. Plus **the after-session seam** (Yash,
   2026-08-25, not in the audit): today the outcome written to Convex is
   only corrections + seconds + `endedByClock`, so the post-session summary
   shows time and fixes, and the History modal shows the plan's topic and
   the same fixes — the Review material and what was actually talked about
   are gone when the tab closes (`out-of-minutes.tsx` even promises they are
   "saved"). The summary *is* the review: the outcome should carry a
   one-line "what this was about" (from the transcript, not the plan), the
   Review snapshot (vocab / phrases / tables), and the summary and the
   History modal render the same record. Persist now, in a shape step 3's
   goal-driven Review can fill.
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
- `secondsBilled` is a high-water mark: a report below it bills nothing
  and moves nothing (never "set"). A redispatched job whose `billed_before`
  read landed before the old job's teardown debit under-bills by at most
  that old job's last periodic-to-teardown window — accepted,
  learner-favouring, **not fenced** (Yash, 2026-08-25).
- **One call may add at most 3 600 s to `secondsBilled`.** The cadence is
  60 s, so a larger delta is a bug or an attack; Convex rejects it (400)
  and bills nothing.
- **When debits fail.** A 401 re-mints the M2M token once; a failed
  re-mint counts as a failure. **Five consecutive debit failures hold the
  clock and end the session** — there is no ceiling-free retry loop, because
  that is how a worker runs for hours unbilled. Consequence, accepted
  (Yash, 2026-08-25): the teardown debit of that session fails too, so its
  last ~5 minutes never bill and the reconciliation cron closes the row.
  Bounded, learner-favouring. Do not turn this into a retry loop that keeps
  the job alive.
- `TUTOR_ENV=production` is set on the prod worker (the ship step's
  secrets). With it set, `TUTOR_ALLOW_UNMETERED` refuses to start. Without
  it, a worker that has a machine key logs at boot that its environment is
  undeclared. Explicit over heuristic: dev and prod share LiveKit Cloud and
  `*.convex.site`, and machine keys carry no test/live marker.
- The clock accrues from the first tutor audio frame, and holds when the
  learner's participant leaves the room (a short grace, then shutdown).
- A worker with a `user_id` and no reachable ledger refuses the job unless
  `TUTOR_ALLOW_UNMETERED=1` (local development only).

### Worker → Convex auth is Clerk M2M (Yash, 2026-08-25), its own commit after step 2

Replaces `TUTOR_DEBIT_SECRET`. Two Clerk machines per instance —
`tutor-worker` and `tutor-ledger`, worker scoped to ledger. Dev instance:
created 2026-08-25 (`mch_3IRAojvF…` worker, `mch_3IRAoYry…` ledger); prod
gets its own two when we get there.

- **Mint**: the worker creates one JWT-format M2M token per job
  (`POST https://api.clerk.com/v1/m2m_tokens`, bearer = the worker's
  machine secret key `CLERK_WORKER_MACHINE_SECRET_KEY`, body
  `{ token_format: "jwt", seconds_until_expiration: 10800 }`) and sends it
  as the bearer on `/tutor/*`. A **401 from Convex re-mints once** and
  retries; a failed re-mint counts toward the five-failure ceiling above
  (which does end the job). JWTs cannot be revoked individually —
  revocation is rotating the worker's machine key, and the 3 h expiry is
  the window.
- **Verify** (Convex `http.ts`): `@clerk/backend`'s `m2m.verify` with
  `CLERK_JWT_KEY` (the instance's public JWKS key as PEM — no secret key
  on Convex; offline, no per-call cost). Fall back to hand-rolled WebCrypto
  RS256 only if the import fights the Convex runtime — and then with a
  JWKS cache TTL and key-rollover handling, never cached forever. Then
  **both ends**: `sub === TUTOR_WORKER_MACHINE_ID` **and** `scopes`
  includes `TUTOR_LEDGER_MACHINE_ID`. Otherwise any machine scoped to the
  ledger later could debit.
- **Request guards stay, same commit** — M2M proves *who*, not that a
  given debit is legit: the `<room>:<jobId>:<seq>` idempotency ref, the
  cumulative ceiling (86 400 s), plus a **hard cap on what one call may add
  to `secondsBilled`** (the periodic debit is every 60 s, so a single delta
  above 3 600 s is a bug or an attack — reject it).

## Edges found while building (the "connect the edges" list)

Places where conversation data still fails to reach a surface. Found by the
step-2 agents on 2026-08-25; assigned, not forgotten.

- **Why a session ended.** The worker now knows zero-hold abandonment,
  hold-idle timeout, learner disconnect, model error; the wire carries only
  `final: true`. History cannot tell a crash from a clean end. One `reason`
  field on the final debit. → step 3 (small).
- **Turn count and the anchor-language ratio.** `turn_seq` is published
  live and discarded; nothing measures the target/anchor mix — exactly the
  input support-on-evidence needs. → step 3, with the goal work.
- **Plan drift.** `about` records what the conversation became; nothing
  records that it diverged from what was set up ("you set up X and did
  Y"). → step 3, with the goal object.
- **Ask and translate vanish.** The questions asked and every
  select-to-translate lookup are the sharpest study record the session
  produces and none of it is stored. → step 3 (add to `/tutor/summary`).
- **Cost.** `est_cost_usd` now counts the `about` call but analyzer / Ask /
  Review / translate still contribute zero (`record_text_usage` seam exists,
  one line each), and there is no cost column on `sessions`. → step 4.
- **Review is still the four generic tables** for most sessions (generated
  once from the plan; the picker no longer sets tenses/scenario). The stored
  snapshot has the right shape; step 3 fills it.
- `users.ts` functions lack `returns` validators. → step 4.

## Step 3 decisions (Yash, 2026-08-25)

- **The conversation starts with goal setting.** If the plan cards gave
  enough (topic / focusNote / note), the tutor restates the goal in one
  line and asks for confirmation; if not, it asks what they want to work
  on, then restates and confirms. One exchange, then the conversation —
  no turn counting, no second negotiation.
- **The confirmed goal is the session's spine.** It drives the tutor's
  standing instructions, the analyzer's focus, the Ask context, and the
  Review, which is generated from the goal once confirmed and regenerated
  from the transcript at a hold when there is enough new material. The
  tab is told through a `tutor.review_version` attribute (push, not poll).
- **Capture** (Fable's call): a function tool on the realtime model
  (`set_session_goal`) the tutor calls when the learner confirms; a silent
  transcript extraction as the safety net if the tool never fires. The
  goal object records its source (plan / tool / extracted).
- **Language of the goal exchange**: the target language, with the
  standing one-anchor-line allowance if the learner stalls; a config
  parameter, so a later "which language" card flips it. No language picker
  now — the target language is already `TUTOR_TARGET_LANG`; generalizing
  beyond Spanish is a later card, not this step.
- The goal, the end reason, turn count, anchor-language ratio, and the
  Ask questions / translate lookups ride the after-session record (the
  edges list above), so History can say what was set up and what was done.

## Decisions still needed from Yash

(a) payment rail — Stripe-direct or Clerk Billing; (b) goal capture and
whether the tutor says the goal out loud (audit §3.2); (c) minimum
startable balance; (d) ordinary-hold idle timeout.
