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


def test_the_opening_is_in_the_target_language_by_default() -> None:
    text = greeting_instructions(cfg(), None, None)
    assert "ONE short line in Spanish" in text


def test_the_opening_language_is_a_config_parameter() -> None:
    text = greeting_instructions(cfg(goal_lang="anchor"), None, None)
    assert "ONE short line in English" in text
    # The conversation itself is still the target language.
    assert "in Spanish" in text


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
