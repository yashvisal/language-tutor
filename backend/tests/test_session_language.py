import json

import pytest

from config import TutorConfig
from plan import JobMetadata
from prompts import analyzer_instructions, greeting_instructions, tutor_instructions


@pytest.mark.parametrize("language", ["es", "fr", "de", "it", "pt"])
def test_dispatch_language_reaches_session_prompts(language):
    meta = JobMetadata.parse(json.dumps({"plan": {"target_language": language}}))
    defaults = TutorConfig()
    cfg = defaults.with_session_language(meta.plan.target_language)
    assert cfg.target_lang == language
    assert cfg.anchor_lang == "en"
    assert defaults.target_lang == "es"
    assert cfg.target_language_name in tutor_instructions(cfg, meta.plan)
    assert cfg.target_language_name in greeting_instructions(cfg, meta.plan)
    assert cfg.target_language_name in analyzer_instructions(cfg, meta.plan)


@pytest.mark.parametrize("language", [None, {}, [], 42, "en", "invalid", "ja", "ko", "zh"])
def test_invalid_or_legacy_selection_preserves_worker_default(language):
    meta = JobMetadata.parse(json.dumps({"plan": {"target_language": language}}))
    cfg = TutorConfig(target_lang="fr")
    assert cfg.with_session_language(meta.plan.target_language) is cfg
    assert JobMetadata.parse(None).plan.target_language is None


@pytest.mark.parametrize(
    "level, guidance",
    [
        ("beginner", "Slow, short sentences"),
        ("understands more than they can say", "time to find words"),
        ("comfortable, wants polish", "Natural pace"),
    ],
)
def test_preflight_answers_and_level_reach_prompts(level, guidance):
    from prompts import review_instructions
    from state import SessionGoal

    wire = {
        "target_language": "fr",
        "topic": "travel",
        "scenario": "a cafe",
        "tenses": ["past tense"],
        "focus_note": "word endings",
        "note": "give me time",
        "vocab": ["food"],
        "level": level,
    }
    plan = JobMetadata.parse(json.dumps({"plan": wire})).plan
    cfg = TutorConfig().with_session_language(plan.target_language)
    for goal in [None, SessionGoal(text="travel conversation", confirmed=True)]:
        prompt = tutor_instructions(cfg, plan, goal)
        for answer in [
            "French",
            "travel",
            "a cafe",
            "past tense",
            "word endings",
            "give me time",
            "food",
            level,
            guidance,
        ]:
            assert answer in prompt
        assert "early-intermediate" not in prompt
    for prompt in [analyzer_instructions(cfg, plan), review_instructions(cfg, plan)]:
        assert level in prompt
        assert guidance in prompt
        assert "early-intermediate" not in prompt


def test_ask_answers_in_the_target_language_at_the_learner_level():
    from prompts import ask_instructions

    plan = JobMetadata.parse(
        json.dumps({"plan": {"target_language": "it", "level": "beginner"}})
    ).plan
    cfg = TutorConfig().with_session_language(plan.target_language)
    prompt = ask_instructions(cfg, plan)
    assert "Write in Italian" in prompt
    assert "beginner" in prompt
    assert "Slow, short sentences" in prompt
    assert "Write in English" not in prompt
