"""Environment-driven configuration and the swappable realtime-model factory.

Nothing in this file (or anywhere else in the worker) may hardcode Spanish. The
target/anchor language pair is a parameter, per the product vision.
"""

from __future__ import annotations

import os
from dataclasses import dataclass, field
from typing import Literal

from livekit.agents import llm
from livekit.plugins import openai, xai

RealtimeProvider = Literal["xai", "openai"]

# Text stream topics the frontend subscribes to. `lk.transcription` is published
# by the SDK itself; these two are ours.
TOPIC_CORRECTIONS = "tutor.corrections"
TOPIC_TRANSLATION = "tutor.translation"

# Participant attribute mirroring pause state, so it survives reconnects.
ATTR_PAUSED = "tutor.paused"

AGENT_NAME = "tutor"


def _env(name: str, default: str) -> str:
    value = os.environ.get(name)
    return value if value else default


def _env_bool(name: str, default: bool) -> bool:
    value = os.environ.get(name)
    if value is None:
        return default
    return value.strip().lower() in ("1", "true", "yes", "on")


# ISO-639-1 -> display name, used only to render prompts. Extend as needed; an
# unknown code falls back to the code itself rather than failing.
_LANGUAGE_NAMES = {
    "en": "English",
    "es": "Spanish",
    "fr": "French",
    "de": "German",
    "it": "Italian",
    "pt": "Portuguese",
    "ja": "Japanese",
    "ko": "Korean",
    "zh": "Chinese",
}


def language_name(code: str) -> str:
    return _LANGUAGE_NAMES.get(code.lower(), code)


@dataclass
class TutorConfig:
    """Everything the worker reads from the environment."""

    target_lang: str = "es"
    anchor_lang: str = "en"

    realtime_provider: RealtimeProvider = "xai"
    xai_model: str = "grok-voice-fast-1.0"
    xai_voice: str = "Ara"
    openai_realtime_model: str = "gpt-realtime"
    openai_realtime_voice: str = "marin"

    stt_model: str = "gpt-live-transcribe"

    analyzer_model: str = "gpt-5.6-luna"
    analyzer_enabled: bool = True

    translation_enabled: bool = True
    translation_model: str = "gpt-realtime-translate"
    translation_url: str = "wss://api.openai.com/v1/realtime/translations"

    openai_api_key: str = field(default="", repr=False)

    @classmethod
    def from_env(cls) -> TutorConfig:
        provider = _env("TUTOR_REALTIME_MODEL", "xai").strip().lower()
        if provider not in ("xai", "openai"):
            raise ValueError(f"TUTOR_REALTIME_MODEL must be 'xai' or 'openai', got {provider!r}")

        return cls(
            target_lang=_env("TUTOR_TARGET_LANG", "es"),
            anchor_lang=_env("TUTOR_ANCHOR_LANG", "en"),
            realtime_provider=provider,  # type: ignore[arg-type]
            xai_model=_env("TUTOR_XAI_MODEL", "grok-voice-fast-1.0"),
            xai_voice=_env("TUTOR_XAI_VOICE", "Ara"),
            openai_realtime_model=_env("TUTOR_OPENAI_REALTIME_MODEL", "gpt-realtime"),
            openai_realtime_voice=_env("TUTOR_OPENAI_REALTIME_VOICE", "marin"),
            stt_model=_env("TUTOR_STT_MODEL", "gpt-live-transcribe"),
            analyzer_model=_env("TUTOR_ANALYZER_MODEL", "gpt-5.6-luna"),
            analyzer_enabled=_env_bool("TUTOR_ANALYZER_ENABLED", True),
            translation_enabled=_env_bool("TUTOR_TRANSLATION_ENABLED", True),
            translation_model=_env("TUTOR_TRANSLATION_MODEL", "gpt-realtime-translate"),
            translation_url=_env(
                "TUTOR_TRANSLATION_URL", "wss://api.openai.com/v1/realtime/translations"
            ),
            openai_api_key=_env("OPENAI_API_KEY", ""),
        )

    @property
    def target_language_name(self) -> str:
        return language_name(self.target_lang)

    @property
    def anchor_language_name(self) -> str:
        return language_name(self.anchor_lang)

    def build_realtime_model(self) -> llm.RealtimeModel:
        """Construct the speech-to-speech model for the configured provider.

        Both providers get identical turn-taking: server-side turn detection is
        switched off (`turn_detection=None`) so LiveKit's audio turn detector
        owns endpointing and the two models behave the same way. The OpenAI
        model additionally gets its own input transcription disabled — the
        parallel `stt=` plugin is the single source of transcripts.
        """
        if self.realtime_provider == "openai":
            return openai.realtime.RealtimeModel(
                model=self.openai_realtime_model,
                voice=self.openai_realtime_voice,
                turn_detection=None,
                input_audio_transcription=None,
            )

        # xAI's plugin has no input-transcription option; it emits none.
        return xai.realtime.RealtimeModel(
            model=self.xai_model,
            voice=self.xai_voice,
            turn_detection=None,
        )
