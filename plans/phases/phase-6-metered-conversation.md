# Phase 6 (part 2): the metered conversation

*Status: proposed 2026-08-24 from Yash's decision (see `product-vision.md`,
"Decisions Settled (2026-08-24)"). Replaces the arc rewrite and absorbs the
money seam (phase-5 step 2). Built alongside the dashboard in phase 6. Prices and
the free grant are placeholders until Yash sets them.*

## The idea

You buy minutes; you talk; the clock counts the seconds you talk. A
conversation is as long as you want it and your balance allows. Thirty
seconds before the balance runs out the tutor finishes the thought and the
surface says so; at zero the conversation holds — buy more and continue, or
go home. No container to fill, so nothing to fill it with: no phases, no
scripted wrap-up, no goodbye.

## What the learner sees

- **Dashboard**: "23 minutes left" (phase 6, unchanged in shape). Start a
  conversation.
- **In the session**: a **stopwatch**, not a countdown — the time you have
  talked counts up at the top, and it visibly stops while you are on hold
  (asking, reviewing, reading), because that time is free. Nothing counts
  down until the last 30 seconds of your balance, when the pill turns to
  "0:30 left" and the tutor wraps the thought without announcing anything
  mechanical.
- **At zero**: the stage holds — the same pause surface, with one card: "You're
  out of minutes." Buy a pack → the balance rises → resume in the same
  conversation. Or "Back to home". Until payments exist, only the second door
  is live.
- **Summary** (unchanged): minutes used, corrections — the look-back the
  spoken debrief used to attempt.

## Pricing (placeholders — Yash decides)

Cost is ~$0.09 per talking minute on `gpt-realtime-2.1` (audit 2026-08-23),
so 5 minutes ≈ $0.45. The ≥3×-cost rule from the vision doc gives:

| Pack | Price | Per minute | Margin |
|---|---|---|---|
| 5 minutes | $1.99 | $0.40 | 4.4× |
| 20 minutes | $5.99 | $0.30 | 3.3× |
| 60 minutes | $16.99 | $0.28 | 3.1× |

Free grant on signup: **10 minutes** (recommended — two units, a real first
taste, ~$0.90 exposure per account) or 5. Minutes never expire; holds are
free.

## What changes in the worker (`backend/`)

- **Clock** (`clock.py`): today it caps a session at `max_minutes` and
  warns at 60 s. It becomes: start with the learner's balance in seconds
  (dispatch metadata from the token route), meter active seconds as it does
  now, publish `tutor.minutes_left` as it does now, **nudge at 30 s** via the
  existing brief seam (wording: finish the thought; nothing new; no goodbye;
  the minutes are nearly out), and **at zero hold, don't end**: interrupt,
  set the paused attribute plus a new `tutor.out_of_minutes` attribute, and
  wait. A hold idle timeout (10 minutes, Yash to confirm) ends an abandoned
  room.
- **Continue after purchase**: on resume the worker re-reads the balance
  (Convex query, signed) and continues the same session; the clock's budget
  is the new balance.
- **Debit**: actual seconds, reported at teardown *and* on the zero hold, via
  the Convex HTTP action (phase-5 seam, still to build), idempotent on room +
  a sequence number so a session that continues after a purchase debits
  correctly.
- **Arc removed** (`arc.py`, the phase blocks in `prompts.py`, wrap-up and
  goodbye instructions): the tutor's standing instructions become one block —
  open in the target language with one easy question (for a null plan, ask
  what they want to talk about and make the answer the subject), stay in
  character or on topic, hand one anchor-language cue only when the learner
  stalls, never correct out loud. `turn_seq`, correction density and the
  anchor-language ratio are available as evidence for a light "support"
  mode; keep it to one exchange when it triggers.
- **Review** (backlog #2) regenerates from the transcript-so-far on hold —
  natural here, since there is no plan-phase to review against.

## What changes in the app (`frontend/` + `convex/`)

- **Ledger unit → seconds** (`creditLedger.minutes` → `seconds`; balance
  helper and every display rounds to minutes). Pre-launch, so no migration
  beyond the dev deployment.
- **Token route**: Clerk auth → balance → 402 at zero → dispatch metadata
  carries `user_id` and `balance_s`; inserts the `sessions` row. (Phase-5
  step 2, unchanged in shape.)
- **Minutes pill**: real-time countdown from the attribute; the 0:30 state.
- **Out-of-minutes hold**: a card on the pause surface — buy (when Stripe
  exists) or back home; the resume RPC after a purchase.
- **Copy**: landing ("Ten minutes of Spanish, out loud" → talk for what you
  use), pricing section as the packs above, welcome ("You have N free
  minutes"), the dashboard's minutes card.
- **Stripe** (phase-5 step 3, unchanged): checkout for the packs; the webhook
  grants seconds; the in-session buy is the same checkout, returning to the
  held session.

## Order

1. Ledger to seconds; token route gating + `sessions` row; the debit action.
   *Exit: the ledger reconciles with the worker's billed seconds.*
2. Clock: balance-driven, 30 s nudge, zero → hold; the pill and the
   out-of-minutes card; `/session` refuses at zero.
3. Arc removed; the single standing prompt; Review from the transcript.
4. Copy everywhere; landing pricing.
5. Stripe, including buy-and-continue.

## Decisions needed

(a) the three pack prices; (b) free grant 10 or 5; (c) at zero before
Stripe: hold + back home (recommended) or end; (d) idle timeout on the hold
(10 min?); (e) whether the Review-from-transcript change rides in step 3 or
waits.
