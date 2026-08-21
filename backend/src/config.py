"""Environment-driven configuration and the realtime-model factory.

Nothing in this file (or anywhere else in the worker) may hardcode Spanish. The
target/anchor language pair is a parameter, per the product vision.

The realtime model is OpenAI GPT Realtime, full stop. Grok Voice support was
removed 2026-08-12: its plugin cannot hand turn detection to the agent
(`can_disable_turn_detection = False`), which forces a second, disagreeing
turn clock and degrades everything downstream (transcript segmentation, the
analyzer trigger, the tutor's own replies). If xAI ships agent-side turn
detection, reintroduce it as a factory branch here — the rest of the worker is
provider-agnostic.
"""

from __future__ import annotations

import logging
import os
from dataclasses import dataclass, field

from livekit.agents import llm
from livekit.plugins import openai
from openai.types.realtime import RealtimeReasoning

logger = logging.getLogger("tutor.config")

# --- Wire protocol -------------------------------------------------------
#
# Every string that has to match on both sides of the wire lives here and
# nowhere else. These must byte-match `frontend/lib/session/protocol.ts`.

# Text stream topics the frontend subscribes to. `lk.transcription` is published
# by the SDK itself; this one is ours.
TOPIC_CORRECTIONS = "tutor.corrections"

# Participant attributes.
# `tutor.paused` mirrors pause state, so it survives reconnects.
ATTR_PAUSED = "tutor.paused"
# `tutor.analyzer` tells the frontend whether corrections are coming at all, so
# it can skip the "analyzing" phase entirely when the analyzer is off.
ATTR_ANALYZER = "tutor.analyzer"
# `tutor.minutes_left` is the session clock's public face: whole minutes
# remaining, as a string, published on session start, every 30s, at the
# one-minute warning, and at zero. The frontend displays this number and never
# computes its own — the worker's clock is authoritative (phase 4, WS2).
ATTR_MINUTES_LEFT = "tutor.minutes_left"
# `tutor.session_over` is set to "true" once the clock has ended the session and
# the goodbye has finished playing, immediately before the worker disconnects.
ATTR_SESSION_OVER = "tutor.session_over"

# Value convention for boolean participant attributes.
ATTR_TRUE = "true"
ATTR_FALSE = "false"
ANALYZER_ON = "on"
ANALYZER_OFF = "off"

# RPC methods the frontend invokes on the agent participant.
RPC_PAUSE = "tutor.pause"
RPC_RESUME = "tutor.resume"
# Select-to-translate: one span in, one translation out. Request/response only —
# there is no translation stream any more (phase 3, WS1/WS3).
RPC_TRANSLATE = "tutor.translate"
# The study surface (phase 4, WS4c). Ask is one question in, one coaching answer
# out; Review is a poll for this session's study material, which is generated
# once and then never changes.
RPC_ASK = "tutor.ask"
RPC_REVIEW = "tutor.review"

# Text stream attributes on `tutor.corrections`.
ATTR_TURN_ID = "tutor.turn_id"
ATTR_CORRECTION_COUNT = "tutor.correction_count"

AGENT_NAME = "tutor"


def _env(name: str, default: str) -> str:
    value = os.environ.get(name)
    return value if value else default


def _env_bool(name: str, default: bool) -> bool:
    value = os.environ.get(name)
    if value is None:
        return default
    return value.strip().lower() in ("1", "true", "yes", "on")


# The only reasoning efforts a realtime model accepts, and OpenAI's supported
# range for output audio speed. Both are checked at load time so a typo in the
# worker's environment is loud once at start, not at every session.
REASONING_EFFORTS = ("minimal", "low")
SPEED_MIN = 0.25
SPEED_MAX = 1.5


def _env_reasoning(name: str, default: str) -> str:
    value = _env(name, default).strip().lower()
    if value not in REASONING_EFFORTS:
        logger.warning("%s=%r is not one of %s; using %r", name, value, REASONING_EFFORTS, default)
        return default
    return value


def _env_speed(name: str, default: float) -> float:
    raw = _env(name, str(default))
    try:
        value = float(raw)
    except ValueError:
        logger.warning("%s=%r is not a number; using %s", name, raw, default)
        return default
    clamped = min(max(value, SPEED_MIN), SPEED_MAX)
    if clamped != value:
        logger.warning(
            "%s=%s is outside %s-%s; using %s", name, value, SPEED_MIN, SPEED_MAX, clamped
        )
    return clamped


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

    # Endpointing. min must comfortably exceed the STT's interim flush lag
    # (~0.5s for gpt-live-transcribe) — below that, turns commit before their
    # transcript arrives and the late flush triggers a phantom second commit
    # that interrupts the tutor's reply (the SDK warns about exactly this,
    # found live 2026-08-12). max is how long an uncertain end-of-turn waits
    # for a learner mid-word-search.
    min_endpointing_s: float = 1.2
    max_endpointing_s: float = 6.0
    realtime_model: str = "gpt-realtime-2.1"
    realtime_voice: str = "marin"
    # Reasoning effort for reasoning-capable realtime models. "minimal"
    # (2026-08-20): the full model follows instructions at minimal, and the
    # mini at "low" started talking to itself mid-session; with the larger
    # model, any extra thinking only adds reply latency.
    realtime_reasoning: str = "minimal"
    # Output audio speed multiplier. 1.0 with the full model (2026-08-20);
    # the mini needed 0.9 to not feel rushed, the full model's pacing doesn't.
    realtime_speed: float = 1.0

    stt_model: str = "gpt-live-transcribe"

    # One text model serves both the analyzer and select-to-translate: both are
    # short, cheap, out-of-band calls on settled text.
    analyzer_model: str = "gpt-5.6-luna"
    analyzer_enabled: bool = True

    # Select-to-translate model. Luna, by decision (2026-08-12): its TTFT is
    # already floor-tier — the felt latency win came from connection warming,
    # not the model — and quality is proven. gpt-5-nano remains the 3.5x
    # cheaper candidate via TUTOR_TRANSLATE_MODEL if cost ever matters.
    translate_model: str = "gpt-5.6-luna"

    openai_api_key: str = field(default="", repr=False)

    @classmethod
    def from_env(cls) -> TutorConfig:
        return cls(
            target_lang=_env("TUTOR_TARGET_LANG", "es"),
            anchor_lang=_env("TUTOR_ANCHOR_LANG", "en"),
            min_endpointing_s=float(_env("TUTOR_MIN_ENDPOINT_S", "1.2")),
            max_endpointing_s=float(_env("TUTOR_MAX_ENDPOINT_S", "6.0")),
            realtime_model=_env("TUTOR_REALTIME_MODEL", "gpt-realtime-2.1"),
            realtime_reasoning=_env_reasoning("TUTOR_REALTIME_REASONING", "minimal"),
            realtime_speed=_env_speed("TUTOR_REALTIME_SPEED", 1.0),
            realtime_voice=_env("TUTOR_REALTIME_VOICE", "marin"),
            stt_model=_env("TUTOR_STT_MODEL", "gpt-live-transcribe"),
            analyzer_model=_env("TUTOR_ANALYZER_MODEL", "gpt-5.6-luna"),
            analyzer_enabled=_env_bool("TUTOR_ANALYZER_ENABLED", True),
            translate_model=_env("TUTOR_TRANSLATE_MODEL", "gpt-5.6-luna"),
            openai_api_key=_env("OPENAI_API_KEY", ""),
        )

    @property
    def target_language_name(self) -> str:
        return language_name(self.target_lang)

    @property
    def anchor_language_name(self) -> str:
        return language_name(self.anchor_lang)

    def build_realtime_model(self) -> llm.RealtimeModel:
        """Construct the speech-to-speech model.

        Model-side turn detection and input transcription are both off: the
        agent's turn detector owns endpointing (one turn clock for replies,
        transcripts, and the analyzer alike), and the parallel `stt=` plugin is
        the single source of transcripts.
        """
        kwargs: dict = {
            "model": self.realtime_model,
            "voice": self.realtime_voice,
            "turn_detection": None,
            "input_audio_transcription": None,
            "speed": self.realtime_speed,
        }
        if self.realtime_model.startswith("gpt-realtime-2"):
            # Reasoning-capable model in a live conversation: keep thinking
            # low. Anything higher adds reply latency the model then papers
            # over with spoken stall phrases ("déjame pensar…") — the
            # double-response feel observed live 2026-08-12.
            kwargs["reasoning"] = RealtimeReasoning(effort=self.realtime_reasoning)
        return openai.realtime.RealtimeModel(**kwargs)
