"""Checks for prompt assembly (`src/prompts.py`).

What is at stake, all of it found in the 2026-08-25 audit:

- **B7.** The in-character scene block used to be applied whenever ANY plan
  fact existed, so a learner who typed "my dog" got a waiter. It now needs a
  scenario, and nothing in any prompt hardcodes a language's example phrases.
- **The opening is goal setting** (phase 7 step 3). Two shapes, one exchange,
  in `TUTOR_GOAL_LANG`'s language, and never a consent gate.
- **The goal is the spine.** A settled goal reaches the standing instructions
  and the analyzer's focus; a plan pre-seed is a proposal and reaches neither.

No model, no network: these are string assertions about strings.

Run either way:

    uv run pytest tests
    uv run python tests/test_prompts.py
"""

from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from config import TutorConfig  # noqa: E402
from plan import SessionPlan  # noqa: E402
from prompts import (  # noqa: E402
    analyzer_instructions,
    goal_block,
    greeting_instructions,
    tutor_instructions,
)
from state import SessionGoal, goal_from_plan  # noqa: E402


def cfg(**kwargs: object) -> TutorConfig:
    return TutorConfig(openai_api_key="x", **kwargs)  # type: ignore[arg-type]


SCENE_MARKER = "THE SITUATION"
PLAN_MARKER = "WHAT THEY ASKED FOR"
GOAL_MARKER = "THIS SESSION'S GOAL"
TOOL_MARKER = "set_session_goal"


# --- B7: the scene block needs a scene ------------------------------------


def test_a_topic_plan_is_not_a_scene() -> None:
    text = tutor_instructions(cfg(), SessionPlan(topic="my dog", focus_note="past tense"))
    assert PLAN_MARKER in text
    assert SCENE_MARKER not in text
    # The persona's own words, which used to arrive with any plan at all.
    assert "You ARE the other person" not in text


def test_a_scenario_plan_is_a_scene_as_well_as_a_plan() -> None:
    text = tutor_instructions(cfg(), SessionPlan(scenario="ordering in a café"))
    assert SCENE_MARKER in text
    assert "ordering in a café" in text
    assert "You ARE the other person" in text


def test_an_empty_plan_gets_the_no_plan_block() -> None:
    text = tutor_instructions(cfg(), SessionPlan())
    assert "The learner set nothing up" in text
    assert SCENE_MARKER not in text


def test_no_prompt_hardcodes_the_target_language() -> None:
    """`config.py`'s opening rule: nothing here may be Spanish-specific."""
    import prompts

    spanish = ("imagina que", "camarero", "perfecto, gracias", "¿Qué le traigo?")
    for name, value in vars(prompts).items():
        if not isinstance(value, str) or name.startswith("__"):
            continue
        for phrase in spanish:
            assert phrase.casefold() not in value.casefold(), f"{name} hardcodes {phrase!r}"


def test_the_tool_is_always_explained() -> None:
    # The tool is registered for the whole session, so the rule for using it
    # ships whether or not a goal exists yet.
    assert TOOL_MARKER in tutor_instructions(cfg())
    assert TOOL_MARKER in tutor_instructions(cfg(), SessionPlan(topic="my dog"))


# --- the goal block -------------------------------------------------------


def test_a_plan_preseed_is_a_proposal_not_a_goal() -> None:
    seeded = goal_from_plan(SessionPlan(focus_note="the past tense"))
    assert seeded is not None and not seeded.confirmed and seeded.source == "plan"
    assert goal_block(seeded) == ""
    assert GOAL_MARKER not in tutor_instructions(cfg(), None, seeded)


def test_a_confirmed_goal_becomes_the_standing_instructions() -> None:
    goal = SessionGoal.make(
        "telling stories about last weekend",
        ["preterite", "imperfect"],
        source="tool",
        confirmed=True,
    )
    text = tutor_instructions(cfg(), SessionPlan(topic="weekends"), goal)
    assert GOAL_MARKER in text
    assert "telling stories about last weekend" in text
    assert "preterite, imperfect" in text


def test_an_extracted_goal_counts_even_though_nobody_said_yes() -> None:
    goal = SessionGoal.make("ordering food", [], source="extracted", confirmed=False)
    assert goal is not None and goal.settled
    assert GOAL_MARKER in tutor_instructions(cfg(), None, goal)


# --- the opening ----------------------------------------------------------


def test_a_seeded_opening_restates_and_asks_for_a_yes() -> None:
    seeded = goal_from_plan(SessionPlan(focus_note="the past tense"))
    text = greeting_instructions(cfg(), SessionPlan(focus_note="the past tense"), seeded)
    assert "the past tense" in text
    assert "ask if that is right" in text
    assert "set_session_goal" in text
    # No consent gates, ever (audit 2026-08-23) — the confirmation IS the gate.
    assert 'no "are you ready"' in text


def test_an_unseeded_opening_asks_what_they_want_to_work_on() -> None:
    text = greeting_instructions(cfg(), None, None)
    assert "ask what they want to work on" in text
    assert "set_session_goal" in text


def test_the_opening_is_in_the_anchor_language_by_default() -> None:
    # Yash, 2026-09-09: ease in. The greeting and the goal confirmation are
    # in English; the first question after the goal is agreed is in Spanish.
    text = greeting_instructions(cfg(), None, None)
    assert "ONE short line in English" in text
    assert "one easy question about it in Spanish" in text


def test_the_opening_language_is_a_config_parameter() -> None:
    text = greeting_instructions(cfg(goal_lang="target"), None, None)
    assert "ONE short line in Spanish" in text


def test_a_scenario_opening_still_sets_the_goal_first() -> None:
    plan = SessionPlan(scenario="ordering in a café", topic="cafés")
    text = greeting_instructions(cfg(), plan, goal_from_plan(plan))
    assert "the goal line comes first and comes alone" in text
    assert "ordering in a café" in text


# --- the analyzer's focus -------------------------------------------------


def test_the_focus_note_reaches_the_analyzer() -> None:
    """It never did before 2026-08-25 (audit B7) — the most valuable line."""
    text = analyzer_instructions(cfg(), SessionPlan(focus_note="ser vs estar"))
    assert "ser vs estar" in text


def test_the_goal_leads_the_analyzer_focus() -> None:
    goal = SessionGoal.make("talking about last weekend", ["preterite"], confirmed=True)
    text = analyzer_instructions(cfg(), SessionPlan(tenses=["present"]), goal)
    focus = text.split("declared focus")[1]
    assert focus.index("talking about last weekend") < focus.index("present")
    assert "the forms that goal invites: preterite" in text


def test_the_analyzer_always_judges_the_turn_language() -> None:
    # With and without a focus: the ratio is evidence, not a focus feature.
    for plan in (None, SessionPlan(tenses=["present"])):
        text = analyzer_instructions(cfg(), plan)
        assert "Also report `language`" in text
        assert "`mixed` when" in text


def main() -> int:
    checks = [value for name, value in sorted(globals().items()) if name.startswith("test_")]
    failures = 0
    for check in checks:
        try:
            check()
        except AssertionError as exc:
            failures += 1
            print(f"FAIL {check.__name__}: {exc}")
        else:
            print(f"ok   {check.__name__}")
    print(f"\n{len(checks) - failures}/{len(checks)} checks passed")
    return 1 if failures else 0


if __name__ == "__main__":
    raise SystemExit(main())


def test_learner_text_lowers_fragment_capitals_and_drops_other_scripts() -> None:
    from agent import learner_text

    assert (
        learner_text("Sí, después de Levantarme Yo desayuno. Y me gusta Café")
        == "Sí, después de levantarme yo desayuno. Y me gusta café"
    )
    assert learner_text("Me gusta どうも café con hielo") == "Me gusta café con hielo"
    # A glyph glued between two words does not glue the words together.
    assert learner_text("holaどうもamigo") == "hola amigo"
    # An acronym keeps its capitals; a one-letter word does not.
    assert learner_text("Trabajo en IA Y en la web") == "Trabajo en IA y en la web"
    # A decomposed accent (e + combining acute) is composed, not stripped.
    assert learner_text("Me gusta el café") == "Me gusta el café"


def test_hold_flush_normalizes_the_turn_before_analysis() -> None:
    """A turn committed by a hold bypasses `on_user_turn_completed`; the
    analyzer must still see it as `learner_text` shapes it."""
    import asyncio
    from types import SimpleNamespace

    from livekit.agents import llm

    from agent import _flush_open_user_turn
    from state import SessionState

    seen: list[str] = []

    class Analyzer:
        def analyze_in_background(self, *, turn_id: str, text: str, context: object) -> None:
            seen.append(text)

    async def commit_user_turn(**_: object) -> str:
        return "Sí, después de Levantarme どうも Yo desayuno"

    async def set_attributes(_: dict[str, str]) -> None:
        return None

    session = SimpleNamespace(
        user_state="listening",
        history=llm.ChatContext.empty(),
        commit_user_turn=commit_user_turn,
    )
    room = SimpleNamespace(local_participant=SimpleNamespace(set_attributes=set_attributes))

    async def run() -> None:
        await _flush_open_user_turn(session, SessionState(), Analyzer(), room)  # type: ignore[arg-type]
        await asyncio.sleep(0)

    asyncio.run(run())
    assert seen == ["Sí, después de levantarme yo desayuno"]


def test_hold_flushed_turn_is_normalized_in_history_once_it_lands() -> None:
    import asyncio

    from livekit.agents import llm

    from agent import _normalize_flushed_turn

    raw = "Sí, después de Levantarme Yo desayuno"
    history = llm.ChatContext.empty()

    async def run() -> None:
        task = asyncio.create_task(_normalize_flushed_turn(_Session(history), raw))  # type: ignore[arg-type]
        await asyncio.sleep(0.15)  # the framework appends a moment later
        history.add_message(role="user", content=raw)
        await task

    class _Session:
        def __init__(self, h: llm.ChatContext) -> None:
            self.history = h

    asyncio.run(run())
    assert [m.text_content for m in history.items if m.type == "message"] == [
        "Sí, después de levantarme yo desayuno"
    ]


def test_session_state_carries_the_hold_normalize_slot() -> None:
    """The shutdown callback reads it off `SessionState` before any hold has
    run; the field once landed on `SessionFacts` by mistake (PR #9)."""
    from state import SessionState

    assert SessionState().hold_normalize is None
