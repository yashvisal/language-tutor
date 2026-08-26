"""Checks for the goal, the evidence, and the Review it drives (phase 7 step 3).

What is at stake:

- **The pre-seed is deterministic.** No model call decides what the tutor
  restates in its first line, and the plan's own words are what it restates.
- **Never two goals.** The tool and the extraction safety net race by design;
  the first confirmed writer wins and the conversation is never re-aimed.
- **The goal reaches everything.** State, the analyzer's focus, the Review, and
  the after-session record.
- **The Review is versioned and never empties.** It is generated when the goal
  lands, regenerated at a hold once the conversation has moved, and a failed
  regeneration keeps the last good material.
- **The record is complete.** Goal, turns, anchor ratio, asks and lookups reach
  `/tutor/summary`, and every ending path maps to one `reason`.

The model and the ledger are both faked; nothing here opens a socket.

Run either way:

    uv run pytest tests
    uv run python tests/test_goal.py
"""

from __future__ import annotations

import asyncio
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from billing import DEFAULT_END_REASON, END_REASONS, SUMMARY_PATH, BillingClient  # noqa: E402
from config import TutorConfig  # noqa: E402
from goal import GoalKeeper  # noqa: E402
from plan import SessionPlan  # noqa: E402
from review import MIN_TURNS_BETWEEN_GENERATIONS, ReviewMaterial  # noqa: E402
from state import (  # noqa: E402
    MAX_GOAL_CHARS,
    MAX_GOAL_FORM_CHARS,
    MAX_GOAL_FORMS,
    SessionFacts,
    SessionGoal,
    SessionState,
    goal_from_plan,
)
from summary import report_session_summary  # noqa: E402


def cfg() -> TutorConfig:
    return TutorConfig(openai_api_key="x")


# --- the pre-seed ---------------------------------------------------------


def test_the_focus_note_is_the_goal_when_there_is_one() -> None:
    goal = goal_from_plan(SessionPlan(topic="my dog", focus_note="the past tense"))
    assert goal is not None
    assert goal.text == "the past tense"
    assert goal.source == "plan" and not goal.confirmed


def test_the_topic_is_the_goal_when_there_is_no_note() -> None:
    goal = goal_from_plan(SessionPlan(topic="my dog"))
    assert goal is not None and goal.text == "my dog"


def test_the_picked_tenses_are_the_forms() -> None:
    goal = goal_from_plan(SessionPlan(topic="weekends", tenses=["preterite", "imperfect"]))
    assert goal is not None and goal.forms == ("preterite", "imperfect")


def test_quoted_fragments_in_the_note_are_the_forms() -> None:
    goal = goal_from_plan(SessionPlan(focus_note='work on "he comido" vs "comí"'))
    assert goal is not None
    assert goal.forms == ("he comido", "comí")


def test_an_empty_plan_pre_seeds_nothing() -> None:
    assert goal_from_plan(SessionPlan()) is None
    assert goal_from_plan(None) is None


def test_a_goal_is_bounded_wherever_it_came_from() -> None:
    goal = SessionGoal.make(
        "g" * (MAX_GOAL_CHARS + 50),
        ["f" * (MAX_GOAL_FORM_CHARS + 20)] + [f"form {i}" for i in range(MAX_GOAL_FORMS + 5)],
        source="not-a-source",
    )
    assert goal is not None
    assert len(goal.text) == MAX_GOAL_CHARS
    assert len(goal.forms) == MAX_GOAL_FORMS
    assert len(goal.forms[0]) == MAX_GOAL_FORM_CHARS
    # An unknown source is not a reason to lose the goal.
    assert goal.source == "plan"


def test_nothing_to_say_is_no_goal() -> None:
    assert SessionGoal.make("   ") is None
    assert SessionGoal.make(None) is None


# --- never two goals ------------------------------------------------------


def test_a_confirmed_goal_replaces_the_pre_seed() -> None:
    facts = SessionFacts()
    facts.set_goal(goal_from_plan(SessionPlan(topic="my dog")))
    assert facts.set_goal(SessionGoal.make("the past tense", source="tool", confirmed=True))
    assert facts.goal is not None and facts.goal.text == "the past tense"


def test_the_first_confirmed_goal_wins() -> None:
    facts = SessionFacts()
    facts.set_goal(SessionGoal.make("the tool's goal", source="tool", confirmed=True))
    assert not facts.set_goal(SessionGoal.make("a later goal", source="extracted"))
    assert not facts.set_goal(SessionGoal.make("a second tool call", source="tool", confirmed=True))
    assert facts.goal is not None and facts.goal.text == "the tool's goal"


# --- the fan-out ----------------------------------------------------------


class FakeAgent:
    def __init__(self) -> None:
        self.instructions: str | None = None

    async def update_instructions(self, instructions: str) -> None:
        self.instructions = instructions


class FakeAnalyzer:
    def __init__(self) -> None:
        self.goal: SessionGoal | None = None

    def set_goal(self, goal: SessionGoal) -> None:
        self.goal = goal


class FakeReview:
    def __init__(self) -> None:
        self.generated: list[SessionGoal | None] = []

    def generate(self, goal: SessionGoal | None = None, **kwargs: object) -> bool:
        self.generated.append(goal)
        return True

    def snapshot(self) -> dict | None:
        return None


def keeper(facts: SessionFacts, **kwargs: object) -> tuple[GoalKeeper, FakeAgent, FakeReview]:
    agent, analyzer, review = FakeAgent(), FakeAnalyzer(), FakeReview()
    keep = GoalKeeper(
        cfg(),
        facts,
        SessionState(),
        room=None,  # type: ignore[arg-type]
        plan=SessionPlan(topic="weekends"),
        review=review,  # type: ignore[arg-type]
        analyzer=analyzer,  # type: ignore[arg-type]
        **kwargs,  # type: ignore[arg-type]
    )
    keep.attach(agent)  # type: ignore[arg-type]
    keep._analyzer_probe = analyzer  # type: ignore[attr-defined]
    return keep, agent, review


async def test_the_goal_reaches_the_tutor_the_analyzer_and_the_review() -> None:
    facts = SessionFacts()
    keep, agent, review = keeper(facts)
    goal = SessionGoal.make(
        "telling stories about last weekend", ["preterite"], source="tool", confirmed=True
    )

    assert await keep.adopt(goal) is True
    assert facts.goal is not None and facts.goal.confirmed
    assert agent.instructions is not None and "THIS SESSION'S GOAL" in agent.instructions
    assert keep._analyzer_probe.goal is goal  # type: ignore[attr-defined]
    assert review.generated == [goal]


async def test_a_second_goal_changes_nothing_downstream() -> None:
    facts = SessionFacts()
    keep, agent, review = keeper(facts)
    await keep.adopt(SessionGoal.make("the first goal", source="tool", confirmed=True))
    assert await keep.adopt(SessionGoal.make("a late extraction", source="extracted")) is False
    assert review.generated == [facts.goal]
    assert "the first goal" in (agent.instructions or "")


async def test_the_safety_net_waits_for_the_third_turn() -> None:
    facts = SessionFacts()
    keep, _, _ = keeper(facts)
    turns = [{"role": "learner", "text": "I want to practise the past tense"}]
    keep._state.turn_seq = 2
    keep.maybe_extract(turns)
    assert keep._extract_task is None
    keep._state.turn_seq = 3
    calls: list[str] = []

    async def _stub(lines: str) -> object:
        calls.append(lines)
        return {"goal": "  the past  tense ", "forms": ["preterite"], "found": True}

    keep._request = _stub  # type: ignore[method-assign]
    keep.maybe_extract(turns)
    assert keep._extract_task is not None
    await keep._extract_task
    assert calls and "past tense" in calls[0]
    assert facts.goal is not None
    assert facts.goal.text == "the past tense"
    assert facts.goal.source == "extracted"
    # Nobody agreed it out loud, but it is still the session's goal.
    assert not facts.goal.confirmed and facts.goal.settled


async def test_the_safety_net_never_runs_once_the_tool_fired() -> None:
    facts = SessionFacts()
    keep, _, _ = keeper(facts)
    await keep.adopt(SessionGoal.make("the tool's goal", source="tool", confirmed=True))
    keep._state.turn_seq = 5
    keep.maybe_extract([{"role": "learner", "text": "something else"}])
    assert keep._extract_task is None


async def test_an_extraction_that_found_nothing_leaves_no_goal() -> None:
    facts = SessionFacts()
    keep, _, review = keeper(facts)
    keep._state.turn_seq = 3

    async def _stub(lines: str) -> object:
        return {"goal": "a guess", "forms": [], "found": False}

    keep._request = _stub  # type: ignore[method-assign]
    keep.maybe_extract([{"role": "learner", "text": "hola"}])
    assert keep._extract_task is not None
    await keep._extract_task
    assert facts.goal is None
    assert review.generated == []


async def test_a_failed_extraction_is_never_a_raise() -> None:
    facts = SessionFacts()
    keep, _, _ = keeper(facts)
    keep._state.turn_seq = 3

    async def _stub(lines: str) -> object:
        raise RuntimeError("the model is down")

    keep._request = _stub  # type: ignore[method-assign]
    keep.maybe_extract([{"role": "learner", "text": "hola"}])
    await keep._extract_task  # type: ignore[arg-type]
    assert facts.goal is None


# --- the anchor-language ratio -------------------------------------------


def test_the_ratio_counts_a_mixed_turn_as_half() -> None:
    facts = SessionFacts()
    for language in ("target", "target", "mixed", "anchor"):
        facts.record_turn_language(language)
    assert facts.learner_turns_judged == 4
    assert facts.anchor_ratio == 0.375


def test_an_unjudged_turn_is_a_target_turn() -> None:
    facts = SessionFacts()
    facts.record_turn_language(None)
    facts.record_turn_language("klingon")
    assert facts.anchor_ratio == 0.0


def test_no_turns_is_no_ratio() -> None:
    assert SessionFacts().anchor_ratio is None


def test_the_brief_says_nothing_until_the_ratio_means_something() -> None:
    facts = SessionFacts()
    facts.record_turn_language("anchor")
    assert not any("anchor language" in line for line in facts.evidence())
    facts.record_turn_language("anchor")
    facts.record_turn_language("anchor")
    assert any("100% of their talking" in line for line in facts.evidence())


def test_the_brief_leads_with_the_goal() -> None:
    facts = SessionFacts()
    facts.set_goal(SessionGoal.make("the past tense", ["preterite"], source="tool", confirmed=True))
    lines = facts.evidence()
    assert lines[0].startswith("what this session is for")
    assert "preterite" in lines[0]


def test_a_pre_seed_is_never_stated_as_agreed() -> None:
    facts = SessionFacts()
    facts.set_goal(goal_from_plan(SessionPlan(topic="my dog")))
    assert facts.evidence() == []


# --- the Review: versions, cadence, and never emptying --------------------


def material(vocab: str) -> tuple[list[dict[str, str]], list[dict[str, str]]]:
    return ([{"target": vocab, "anchor": "gloss"}], [])


async def a_review(outcomes: list[object]) -> ReviewMaterial:
    review = ReviewMaterial(cfg(), SessionPlan(topic="weekends"))

    async def _request(goal: SessionGoal, transcript: object) -> object:
        outcome = outcomes.pop(0)
        if isinstance(outcome, Exception):
            raise outcome
        return outcome

    review._request = _request  # type: ignore[method-assign]
    return review


async def settle(review: ReviewMaterial) -> None:
    task = review._task
    if task is not None:
        await task


async def test_nothing_is_generated_before_the_goal_lands() -> None:
    review = await a_review([])
    assert review.version == 0 and review.snapshot() is None
    # A hold before the goal still resolves the tab — with the tables alone.
    review.generate(None)
    await settle(review)
    snapshot = review.snapshot()
    assert snapshot is not None
    assert snapshot["vocab"] == [] and snapshot["phrases"] == []
    assert snapshot["tables"], "the deterministic half must always be there"
    assert review.version == 1


async def test_every_snapshot_bumps_the_version_and_is_announced() -> None:
    review = await a_review([material("el fin de semana"), material("el taxi")])
    published: list[int] = []

    async def _handler(version: int) -> None:
        published.append(version)

    review.set_snapshot_handler(_handler)
    goal = SessionGoal.make("weekends", source="tool", confirmed=True)

    review.generate(goal, turn_seq=1)
    await settle(review)
    assert review.version == 1 and published == [1]
    assert review.snapshot()["vocab"][0]["target"] == "el fin de semana"  # type: ignore[index]

    review.generate(goal, transcript=[{"role": "learner", "text": "el taxi"}], turn_seq=9)
    await settle(review)
    assert review.version == 2 and published == [1, 2]
    assert review.snapshot()["vocab"][0]["target"] == "el taxi"  # type: ignore[index]


async def test_a_hold_regenerates_only_once_the_conversation_has_moved() -> None:
    review = await a_review([material("el fin de semana")])
    goal = SessionGoal.make("weekends", source="tool", confirmed=True)
    # Nothing generated yet: the first hold always regenerates.
    assert review.should_regenerate(goal, 1) is True
    review.generate(goal, turn_seq=4)
    await settle(review)
    assert review.should_regenerate(goal, 4) is False
    assert review.should_regenerate(goal, 4 + MIN_TURNS_BETWEEN_GENERATIONS - 1) is False
    assert review.should_regenerate(goal, 4 + MIN_TURNS_BETWEEN_GENERATIONS) is True
    # No goal, no model call — the tables-only fallback is not a regeneration.
    assert review.should_regenerate(None, 100) is False


async def test_a_tables_only_snapshot_is_replaced_as_soon_as_a_goal_exists() -> None:
    """The no-goal fallback must not look like material about the goal."""
    review = await a_review([])
    review.generate(None, turn_seq=2)
    await settle(review)
    assert review.version == 1
    goal = SessionGoal.make("weekends", source="tool", confirmed=True)
    assert review.should_regenerate(goal, 2) is True


async def test_a_failed_regeneration_keeps_the_last_good_material() -> None:
    review = await a_review([material("el fin de semana"), RuntimeError("the model is down")])
    goal = SessionGoal.make("weekends", source="tool", confirmed=True)
    review.generate(goal, turn_seq=1)
    await settle(review)
    review.generate(goal, turn_seq=9)
    await settle(review)
    assert review.version == 1
    assert review.snapshot()["vocab"][0]["target"] == "el fin de semana"  # type: ignore[index]


async def test_a_generation_in_flight_is_not_started_twice() -> None:
    review = await a_review([material("el fin de semana")])
    goal = SessionGoal.make("weekends", source="tool", confirmed=True)
    assert review.generate(goal, turn_seq=1) is True
    assert review.generate(goal, turn_seq=1) is False
    await settle(review)


async def test_the_goal_and_the_transcript_are_what_the_review_is_made_from() -> None:
    seen: dict[str, object] = {}
    review = ReviewMaterial(cfg(), SessionPlan(topic="weekends"))

    class FakeResponses:
        async def create(self, **kwargs: object) -> object:
            seen.update(kwargs)

            class R:
                output_text = '{"vocab": [], "phrases": []}'
                usage = None

            return R()

    class FakeClient:
        responses = FakeResponses()

    review._client = FakeClient()  # type: ignore[assignment]
    goal = SessionGoal.make("telling stories", ["preterite"], source="tool", confirmed=True)
    review.generate(goal, transcript=[{"role": "learner", "text": "fui al parque"}], turn_seq=3)
    await settle(review)
    prompt = str(seen["input"])
    assert "telling stories" in prompt
    assert "preterite" in prompt
    assert "fui al parque" in prompt
    assert seen["reasoning"] == {"effort": "none"}


# --- the after-session record --------------------------------------------


class Ledger:
    def __init__(self) -> None:
        self.calls: list[tuple[str, dict]] = []

    async def __call__(self, path: str, payload: dict) -> object:
        self.calls.append((path, payload))
        return {"ok": True, "balanceSeconds": 100}


def billing_client(ledger: Ledger) -> BillingClient:
    client = BillingClient(
        room="room_xyz",
        user_id="user_abc",
        job_id="JOB_1",
        site_url="https://example.convex.site",
        machine_key="ak_test_not_a_real_key",
    )
    client._post_json = ledger  # type: ignore[method-assign]
    return client


class FakeItem:
    def __init__(self, role: str, text: str) -> None:
        self.role = role
        self.text_content = text
        self.type = "message"
        self.id = "item"


class FakeHistory:
    def __init__(self, n: int) -> None:
        self.items = [
            FakeItem("user" if i % 2 == 0 else "assistant", f"turn {i}") for i in range(n)
        ]


class FakeCoach:
    questions = ["why is it fui and not fue?"]


class FakeTranslator:
    lookups = [{"source": "no me acuerdo", "translation": "I don't remember"}]


async def test_the_record_carries_the_goal_and_the_evidence() -> None:
    import summary as summary_module

    ledger = Ledger()
    facts = SessionFacts()
    facts.set_goal(SessionGoal.make("the past tense", ["preterite"], source="tool", confirmed=True))
    for language in ("target", "anchor"):
        facts.record_turn_language(language)

    original = summary_module.about_line

    async def _stub(*args: object, **kwargs: object) -> str | None:
        return "Telling stories about last weekend."

    summary_module.about_line = _stub  # type: ignore[assignment]
    try:
        sent = await report_session_summary(
            cfg(),
            history=FakeHistory(6),
            billing=billing_client(ledger),
            facts=facts,
            turns_taken=7,
            coach=FakeCoach(),  # type: ignore[arg-type]
            translator=FakeTranslator(),  # type: ignore[arg-type]
        )
    finally:
        summary_module.about_line = original  # type: ignore[assignment]

    assert sent is True
    (path, body) = ledger.calls[0]
    assert path == SUMMARY_PATH
    assert body["goal"] == {
        "text": "the past tense",
        "forms": ["preterite"],
        "source": "tool",
    }
    assert body["turns"] == 7
    assert body["anchorRatio"] == 0.5
    assert body["asks"] == ["why is it fui and not fue?"]
    assert body["lookups"] == [{"source": "no me acuerdo", "translation": "I don't remember"}]


async def test_the_goal_is_posted_as_soon_as_it_lands() -> None:
    """A worker that is killed mid-session still says what the session was for."""
    ledger = Ledger()
    facts = SessionFacts()
    tasks: list[asyncio.Task] = []
    keep, _, _ = keeper(
        facts,
        billing=billing_client(ledger),
        spawn=lambda coro, name: tasks.append(asyncio.create_task(coro, name=name)),
    )
    await keep.adopt(SessionGoal.make("the past tense", source="tool", confirmed=True))
    await asyncio.gather(*tasks, return_exceptions=True)
    posts = [payload for path, payload in ledger.calls if path == SUMMARY_PATH]
    assert posts and posts[0]["goal"]["text"] == "the past tense"


# --- why the session ended ------------------------------------------------


async def test_the_final_debit_carries_the_reason_and_nothing_else_does() -> None:
    ledger = Ledger()
    billing = billing_client(ledger)
    billing.set_end_reason("model_error")

    await billing.debit(60)
    (_, periodic) = ledger.calls[0]
    assert "reason" not in periodic and "final" not in periodic

    await billing.debit(120, final=True)
    (_, final) = ledger.calls[1]
    assert final["final"] is True
    assert final["reason"] == "model_error"


def test_the_default_reason_is_an_ordinary_ending() -> None:
    billing = billing_client(Ledger())
    assert billing.end_reason == DEFAULT_END_REASON == "ended"


def test_every_ending_path_has_a_reason_on_the_wire() -> None:
    """The enum and the worker's ending paths are one list, checked here."""
    assert set(END_REASONS) == {
        "ended",
        "out_of_minutes_idle",
        "hold_idle",
        "learner_left",
        "model_error",
        "ledger_failure",
        "tutor_silent",
    }


def test_a_suspected_ending_never_overwrites_a_real_one() -> None:
    billing = billing_client(Ledger())
    billing.set_end_reason("tutor_silent", weak=True)
    assert billing.end_reason == "tutor_silent"
    billing.set_end_reason("learner_left")
    assert billing.end_reason == "learner_left"
    # The watchdog fires late on a session that already knows how it ended.
    billing.set_end_reason("tutor_silent", weak=True)
    assert billing.end_reason == "learner_left"


def test_an_unknown_reason_is_dropped_not_sent() -> None:
    billing = billing_client(Ledger())
    billing.set_end_reason("exploded")
    assert billing.end_reason == DEFAULT_END_REASON


def main() -> int:
    checks = [value for name, value in sorted(globals().items()) if name.startswith("test_")]
    failures = 0
    for check in checks:
        try:
            result = check()
            if asyncio.iscoroutine(result):
                asyncio.run(result)
        except AssertionError as exc:
            failures += 1
            print(f"FAIL {check.__name__}: {exc}")
        else:
            print(f"ok   {check.__name__}")
    print(f"\n{len(checks) - failures}/{len(checks)} checks passed")
    return 1 if failures else 0


if __name__ == "__main__":
    raise SystemExit(main())
