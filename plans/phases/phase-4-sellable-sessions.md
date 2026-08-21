# Phase 4: Sellable Sessions

*Status: draft, pending Yash's review (2026-08-20). Read `plans/product-vision.md`
(the 2026-08-20 decisions) first. Phases 5 and 6 are outlined at the end so this
phase's seams are built knowing what plugs into them.*

## Goal

**Turn the conversation primitive into a product someone can sign up for, pay
for, and use without us in the room.** A learner signs up, gets one free
10-minute credit, configures a session (or accepts a suggestion), talks, sees
their minutes tick down, and can buy more. Deployed, not local.

Two weeks head-down. Everything that isn't on the path from "stranger" to
"paid second session" waits for phase 5.

## The economics this phase is built against

All-in cost of a 15-minute session (2026-08-20 estimate, see vision doc #3):
**~$1.20–1.40**, dominated by realtime audio — tutor output audio is ~4x the
learner's input per minute (1,200 vs 600 tokens/min at $64 vs $32 per 1M),
context re-reads are cheap only because they're cached, STT is ~20%.

- Credit = 10 minutes (settled 2026-08-20). Pricing re-bases on the measured
  mini cost (~$0.35–0.55/session); defaults TBD with Yash — the >= 3x-cost rule
  stands.
- Free trial: 1 credit per signup (~$1.25 exposure per account, behind auth).
  `gpt-realtime-mini` (~1/3 cost) is the lever for trial credits if abuse
  appears — model per session is already an env-level choice; make it a
  per-session parameter.
- Tutor brevity is a margin policy. The prompt's "short turns" rule stays.

## Workstreams

### 1. Identity and data

- **Auth**: Clerk (recommended — fastest path on Next 16, good DX, free tier
  covers early volume). Email + Google.
- **Database**: Convex (Yash's call, 2026-08-20). Tables: `users` (auth id,
  declared level, target/anchor language), `creditLedger` (append-only:
  grants, purchases, debits — balance is a sum, never a mutable field),
  `sessions` (plan, started/ended, minutes billed, room name), `purchases`
  (Stripe session id, pack, status). The worker's minutes-billed report lands
  via a Convex HTTP action (signed), replacing the Next.js internal endpoint
  sketched in workstream 2.
- *Confirm vendors with Yash before build — these are his accounts.*

### 2. Credits, metering, and the clock

- **Minutes balance** derived from the ledger; credits (10 min) are the purchase
  unit.
- **The worker's clock is authoritative.** At session start the frontend's
  token request carries the user; the token route checks balance > 0 and
  embeds `user_id` + `max_minutes` in the dispatch metadata. The worker runs
  the clock, publishes `tutor.minutes_left` as a participant attribute every
  30s (the frontend displays it; it never computes it), and at ~60s left
  sends the tutor a situation brief through the existing resume-brief seam
  ("about one minute left — bring the conversation to a natural close"). At
  zero: `session.interrupt()`, a short spoken goodbye, disconnect.
- **Debit on session end** (actual minutes, rounded up), written by the worker
  via a signed internal endpoint on the Next.js app — the only writer of
  debit rows. Reserve-at-start is not needed if the balance check gates the
  token and the clock is enforced worker-side.
- Pause time is **not** billed (reversed 2026-08-20 after live use): the clock
  accrues only while the session is unheld. Study is free; speech is metered.

### 3. Payments

- Stripe Checkout for credit packs (no custom card UI); webhook writes the
  ledger grant. Test mode through the whole build; live keys at deploy.
- Buy-more affordance in two places: the balance pill on the session surface
  (when low) and the post-session summary.

### 4. Session pre-configuration and onboarding-lite

- **Onboarding**: one screen — declared level (the vision's regressed
  intermediate is the default framing: "I understand more than I can say"),
  then straight to the first session with the free credit. No assessment.
- **Session plan** (a typed object, the session's declared intent): topic or
  scenario (ordering at a restaurant, catching up with a friend, telling a
  story about last weekend…), focus tenses, vocab themes. A "suggest one"
  default so a learner can start in one tap. Persisted on `sessions`.
- The plan feeds three consumers: the tutor prompt (steer and model the focus
  forms), the analyzer (weight corrections toward the focus), and — in phase
  5 — the Review tab. Build the plan object and its prompt/analyzer wiring now;
  the Review consumer arrives with phase 5.

### 4b. The session arc (added 2026-08-20, after live testing)

Straight role-play for a whole session is bad pedagogy and the tutor fills the
dead space by rambling. A session is a gradual-release ARC owned by the worker,
proportioned 1 / 4 / 4 / 1 of the budget:

1. **Frame** (anchor language): name the situation and focus form, model one
   example, invite one try. Tiny and applied.
2. **Guided bits** (bilingual): intent in the anchor language, production in the
   target, in-character response, next intent. "Doing bits together."
3. **Scene** (target language): the role-play, as BEATS with natural ends
   (arrive → order → a small problem → pay). Entry by consent.
4. **Debrief** (anchor language): two things that went well, one to remember,
   from `SessionFacts` — then the wrap-up/goodbye.

The arc is a guide, never a lock: every gate is skippable, and the learner may
ask anything or steer at any moment; the tutor follows and returns when
natural. Phase transitions ride the clock's active time and land via
instruction updates (no interruptions). The phase-5 Review tab draws its
material from the same plan + arc.

### 5. Session surface additions

- Balance pill (minutes left, live from the attribute), one-minute warning
  state, graceful end. Post-session summary: minutes used, corrections seen
  (from `SessionFacts` — the feedback loop's first visible output), buy-more.
- Sessions list on a minimal account page (date, plan, minutes).

### 6. Deployment

- Frontend on Vercel (env: Clerk, Neon, Stripe, LiveKit).
- Worker on LiveKit Cloud via `lk agent create` (secrets as LiveKit agent
  secrets). This also removes the local-CPU half of the "heavy session"
  problem found in phase 3.
- A landing page that states the thesis in one screen and routes to sign-up.
  Restrained — the product's taste rules apply.

## Non-goals

Subscriptions, assessment, quizzes, reviews, the Review/Ask tabs (phase 5),
other languages, mobile, referral/growth mechanics, admin tooling beyond
reading the ledger in Neon.

## Exit criteria

- A stranger can sign up, get a free credit, configure and complete a session
  on the deployed app, see minutes deplete, buy a pack with a test card, and
  start a second session — with no local processes running.
- The worker's clock ends sessions gracefully (tutor wrap-up, not a cut).
- The ledger reconciles: minutes billed == worker-reported minutes.
- Session plan demonstrably steers the tutor and the analyzer.

---

## Phase 5 outline: the study surface (Pause → Transcript / Review / Ask)

- **Review tab**: generated once per session from the plan (vocab list,
  scenario phrases) plus **deterministic conjugation tables** shipped as JSON
  for the focus tenses — never LLM-generated tables. Interactive, quiet.
- **Ask tab**: a Luna text chat with coaching persona (push back, make the
  learner try first, never ghostwrite), context = transcript to the pause
  point + the session plan + recent corrections. Soft invisible limits
  (questions per session, answer length). Each thread anchored to the
  transcript position it opened at; rendered as quiet markers in the
  Transcript tab.
- **Context return**: on resume, a <=2-line brief through the resume seam
  ("asked how to say X; studied Y"). Never the Ask transcript. This is the
  cost-containment rule for the voice model.
- Textbook corpus parsing is NOT phase 5 — model-generated material plus
  curated tables first; a corpus only if quality demands it.

## Phase 6 outline: the tutoring program (subscription)

Adaptive assessment, pre/post session reviews, quizzes, included minutes,
the learner profile with declared-vs-inferred fields and the feedback loop's
proposals (see phase 3 doc, workstream 4). Other languages scale here.
