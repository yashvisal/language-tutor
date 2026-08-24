# Backlog: session follow-ups

*Carried forward from live testing and PR #3 review (2026-08-20/21). These are
deferred on purpose — the session playground is good enough to build the
product around (Yash, 2026-08-21). Pick from here when session work resumes.
Read `product-vision.md` first; nothing here reopens a settled decision.*

## Tutor logic

1. **Free conversation should ask.** With `plan_scenario = "free conversation"`
   the frame invents a scenario ("ordering and small talk", a café example)
   instead of asking what the learner wants to talk about. The frame for a
   plan with no scenario should open with the question and build the session
   from the answer. (`backend/src/prompts.py`, frame phase; `arc.py`
   `GENERIC_BEATS`.)
2. **Review should follow the conversation.** `tutor.review` generates once per
   plan at session start, so a session that drifted from restaurants to taxis
   reviews restaurants. Regenerate — or extend — from the transcript-so-far
   when the study surface opens, keeping the deterministic conjugation tables.
   Same principle as #1: the plan is a starting point, the conversation is the
   truth. (`backend/src/review.py`, `frontend/components/session/study-review.tsx`.)
3. **Arc feel.** Yash: "the overall experience isn't as cute as I want." Needs
   2–3 concrete moments he wished had happened before anything is designed.
   Not a prompt-tweak task until then.
4. **Review depth** is surface-level (tabled 2026-08-21, after #2).

## Transcript and hold

5. **Learner fragments.** DONE (2026-08-23). One spoken turn arrives as several
   STT finals ("Yo quiero pagar con" → "Plástico.") and used to show as several
   bubbles. The worker now publishes the turn detector's commit as a monotonic
   `tutor.turn_seq` attribute (`_publish_turn_commit` in `backend/src/agent.py`,
   from both `on_user_turn_completed` and the hold flush); the live producer
   turns each rise into a `learner.turn_committed` event, and the reducer joins
   consecutive learner segments into one turn until that event arrives. An
   earlier attempt keyed the join on the analyzer settling instead — that lands
   ~2s after the commit, so the learner's next sentence landed in the previous
   bubble, and it was reverted (4af9632 → 1172dcd).
6. **Hold flush unproven live.** `_flush_open_user_turn` closes the open STT
   segment at hold; every hold in testing was `result: empty`. One deliberate
   test: start a sentence, hit Space mid-word, resume, finish it — the
   `hold: open user turn flushed` log line reports `committed`.
7. **Pause/resume serialization** (CodeRabbit, declined for PR #3). A resume
   inside the ~1s flush window while the learner was mid-speech can lose one
   owed reply; a failed resume-ack skips `notify_resumed` on retry. Only worth
   a lock + completion state if a live session ever shows a lost reply.

## Cost

8. **Measure the text-only calls.** The $0.85–0.95 per 10-minute figure is
   realtime audio only; the analyzer, Review and Ask (Luna) are not in it.
   Add their usage to `usage.py`'s summary so pricing rests on the complete
   number. Text-token prices for `gpt-realtime-2.1` are also unverified.
9. **Talk share.** Guided-phase cues were trimmed (2026-08-21); the next
   session's `tutor_talk_share` should read ~35% (was 49%). If not, the
   prompt needs another pass — output audio is half the bill.

## Declined review findings (so they are not re-litigated)

- "`wait_for` cancels the STT flush" — false; the framework's done-callback
  propagates task→future only (`audio_recognition.py:1115-1128`, 1.6.9).
- Allowlist model IDs before sending `reasoning.effort` — both realtime
  models accept it; the effort *value* is validated instead.
- `es.py` TypedDict annotations — cosmetic.
