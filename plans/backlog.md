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
