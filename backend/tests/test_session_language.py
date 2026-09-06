import json

import pytest

from config import TutorConfig
from plan import JobMetadata
from prompts import analyzer_instructions, greeting_instructions, tutor_instructions


@pytest.mark.parametrize("language", ["es", "fr", "de", "it", "pt", "ja", "ko", "zh"])
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


@pytest.mark.parametrize("language", [None, {}, [], 42, "en", "invalid"])
def test_invalid_or_legacy_selection_preserves_worker_default(language):
    meta = JobMetadata.parse(json.dumps({"plan": {"target_language": language}}))
    cfg = TutorConfig(target_lang="fr")
    assert cfg.with_session_language(meta.plan.target_language) is cfg
    assert JobMetadata.parse(None).plan.target_language is None
