# Backlog: session follow-ups

*Carried forward from live testing and PR #3 review (2026-08-20/21). These are
deferred on purpose — the session playground is good enough to build the
product around (Yash, 2026-08-21). Pick from here when session work resumes.
Read `product-vision.md` first; nothing here reopens a settled decision.*

## Tutor logic

1. ~~**Free conversation should ask.**~~ *Done 2026-08-25 (phase 7 step 3): the conversation opens with goal setting.*
   Original: With `plan_scenario = "free conversation"`
   the frame invents a scenario ("ordering and small talk", a café example)
   instead of asking what the learner wants to talk about. The frame for a
   plan with no scenario should open with the question and build the session
   from the answer. (`backend/src/prompts.py`, frame phase; `arc.py`
   `GENERIC_BEATS`.)
2. ~~**Review should follow the conversation.**~~ *Done 2026-08-25 (phase 7 step 3): Review is generated from the confirmed goal and regenerated from the transcript on hold.*
   Original: `tutor.review` generates once per
   plan at session start, so a session that drifted from restaurants to taxis
   reviews restaurants. Regenerate — or extend — from the transcript-so-far
   when the study surface opens, keeping the deterministic conjugation tables.
   Same principle as #1: the plan is a starting point, the conversation is the
   truth. (`backend/src/review.py`, `frontend/components/session/study-review.tsx`.)
3. ~~**Arc feel.**~~ *Superseded 2026-08-24: there is no arc. See the vision
   doc's "metered conversation" decisions and `phases/phase-6-metered-conversation.md`.*
4. **Review depth** is surface-level (tabled 2026-08-21; #2 is done — revisit after live testing of the goal-driven Review).

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

8. ~~**Measure the text-only calls.**~~ *Worker side done 2026-08-25: analyzer, Review, Ask, translate, goal and about calls are counted in `usage.py`. Still no cost column on `sessions` (phase 7 step 4).*
   Original: The $0.85–0.95 per 10-minute figure is
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

## From the first external session (2026-09-22)

*The first learner who is not Yash ran a five-minute German session on
2026-09-22 (room `lesson-learner-6652d16c-…`, worker logs in Sentry under
`6652d16c`). The German was correct throughout, the target sentence was built
and produced, the review saved cleanly, and every after-session field landed.
These are the things it showed we still owe. Read before wrapping the project.*

10. **The corrections list is mostly noise.** Of 10 saved corrections, 3 were
    real German mistakes (`keinen Zeit`, `eine Meeting`, a dropped noun after
    `mehrere`). 3 came from the transcriber mishearing her (`Zeit für Freunde`
    became `twitter … keine seite verändern`), 2 corrected her *English*
    sentences in English, and 2 were capitalization, which does not exist in
    speech. The analyzer should skip turns whose `turn_language` is `anchor`,
    drop capitalization-only diffs, and probably not correct a span the tutor's
    own reply shows it understood differently from the transcript.
    (`backend/src/analyzer.py`; the outcome's `corrections` array.)
11. **A prompt instruction was spoken aloud.** The tutor said "Cue: very
    basic." before simplifying. The word comes from the struggling-learner
    paragraph in `backend/src/prompts.py` ("one cue … the word they were
    reaching for"); either that wording or the nudge instructions
    (`nudge_instructions`, `agent.py`) is being read as something to say.
    Reword so the model cannot echo a label, and add "never say the word cue"
    style guard only if rewording does not hold.
12. **The opener does not scale to the chosen level.** Second tutor line was a
    relative clause plus compound past ("Was war heute ein Satz, den du sagen
    wolltest, aber die Wortstellung oder eine Präposition haben dich
    gestoppt?"). She asked twice for "very, very basic". The frame should pick
    the opening question's complexity from `plan.level`. (`prompts.py`.)
13. **Not a bug, noted so it is not re-litigated:** the tutor praised turns
    whose *transcript* was garbage ("Ich habe kannen seit freund"). The
    realtime model hears the audio directly; the transcript comes from the
    separate `gpt-live-transcribe` pass. The tutor's reply shows it understood
    "keine Zeit für Freunde", so this was the transcriber failing, not the
    tutor. Transcript text is evidence about the transcriber, not about what
    the tutor heard. It does mean #10's transcription-driven corrections are
    charged to the learner for something she likely said correctly.
14. **Background speech reached the transcript.** Two learner turns were other
    people in the room ("everybody's using AI… This is my five minutes",
    "see you at five thirty-five… Let's go to sleep") and were analyzed and
    corrected. Nothing to do at the model level without speaker separation,
    but #10's anchor-turn skip removes most of the damage.

## From the second external session (2026-09-26)

*A second uninvited learner signed up at 12:36 UTC and ran a three-minute
French self-introduction (room `lesson-learner-d8154fa8-…`, Sentry under
`d8154fa8`). The tutor spoke first, held French throughout, saved 9
corrections, a summary and a review sheet, and the learner ended it himself.
Two organic users, two clean sessions, zero purchases — because there is
nothing to purchase yet (#15). Yash woke to a Sentry email from this session
and assumed a failure; it was #16.*

15. **There is no way to buy minutes.** Both external learners spent, or could
    have spent, the 300-second signup grant and then hit a wall with no
    purchase path behind it. The `purchases` table and the out-of-minutes hold
    exist; the checkout that fills the table does not. Until it does, every
    session after the first is a lost learner, and conversion cannot be
    measured. This is the last piece before the product is whole.
16. **Filter the LiveKit Rust logger out of Sentry.** Issue PYTHON-7
    ("publisher data channel '_reliable' closed unexpectedly", logger
    `livekit`) fired one second before this session's `endedAt`. It is a
    diagnostic in `rtc_session.rs` that fires during normal room teardown
    when the learner leaves before the worker sets its closing flags; it only
    logs. It reached Sentry because the default logging integration forwards
    every ERROR-level record. Add a logger ignore (or raise the threshold) for
    `livekit` in `backend/src/observability.py` so only `report_error` kinds
    page anyone. Otherwise every End click can send an email.
17. **Billed time versus wall time, eyeball only.** 180 seconds billed against
    about 4:20 of wall clock, with per-minute debits stopping at 12:40:49.
    Consistent with a pause or hold near the end, and the held-seconds fix in
    41603be is believed to cover it. Not investigated; check it against the
    next session that shows the same gap before spending time on it.
18. **Reading prod sessions.** The dashboard's `about` column is wide enough
    that a neighbouring row's summary reads as the same session (the German
    line from 2026-09-22 was mistaken for part of this French one). Print
    rows one at a time by `_id` when reading prod; nothing to build.

## Exploratory (decide before building)

19. **Jev (or CLM-8B) as a transcript sanity check.** Yash's idea from
    2026-09-26. Jev is TypeSafe AI's "System One" model, released 15 Sept 2026
    in limited early access (docs.typesafe.ai): it does not generate text, it
    takes a block of state (string or JSON) plus typed questions and returns
    probabilities and confidence scores in 70–500 ms. CLM-8B (Contrastive-LM
    with Hazy Research, 23 Sept 2026, Apache-2.0 on Hugging Face, frozen
    Qwen3-8B encoder plus a 75 MB head) is the open equivalent: same
    state-plus-candidates-in, probabilities-out shape, 16–80 ms in their
    benchmarks, slightly behind Jev on accuracy. Both are text-only; neither
    hears audio, so the check has to work from text the worker already has.
    Two uses, both unproven:
    - **Flag transcriber failures in real time.** #13 established that a
      garbled transcript with a sensible tutor reply means the transcriber
      failed. State = the learner's transcript turn, the tutor's reply and the
      plan; question = "is this transcript what the learner most likely said,
      given the reply?" A low probability marks the turn, so #10 stops
      charging the learner for the transcriber's mistake, and the analyzer
      can skip or soften it.
    - **Infer what was actually said.** For flagged turns, queue a fast text
      model to propose the phrase the learner most likely spoke, then let
      Jev/CLM rank the candidates against the same state. Show the winner in
      the bubble marked as inferred, and analyze that instead.
    The same shape could gate the translation side-task (rank the translation
    against the source and context, retry below a threshold). Before building:
    get Jev access or pull CLM-8B, replay one saved session's transcript
    through it, and measure whether it separates the known-bad turns from the
    good ones in the 2026-09-22 and 2026-09-26 sessions. If it does not, the
    fallback is #10's anchor-turn skip plus a plain tutor-reply cross-check.
