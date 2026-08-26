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
# The session clock's public face (phase 6, the metered conversation). All
# three are strings; the frontend displays them and never computes its own —
# the worker's clock is authoritative (phase 4, WS2).
#
# `tutor.elapsed_s`   — active seconds so far. The stopwatch on screen; it
#                       stops while the session is held, because holds are free.
# `tutor.remaining_s` — balance_s - elapsed_s, floored at 0. The 0:30 state and
#                       the countdown at the end of the balance.
# `tutor.out_of_minutes` — "true" only while the session is held at zero.
#
# Published every 5s while unheld, and immediately on every pause/resume
# transition, at the 30s nudge, and at zero.
ATTR_ELAPSED_S = "tutor.elapsed_s"
ATTR_REMAINING_S = "tutor.remaining_s"
ATTR_OUT_OF_MINUTES = "tutor.out_of_minutes"
# `tutor.session_over` is set to "true" immediately before the worker
# disconnects — the clock's idle timeout on an abandoned out-of-minutes hold,
# or any other end of the session.
ATTR_SESSION_OVER = "tutor.session_over"
# `tutor.turn_seq` is a monotonically increasing integer, bumped every time a
# learner turn COMMITS. It is the only signal the frontend has for that moment:
# the STT emits a segment per VAD-bounded phrase, so one conversational turn is
# several segments, and only the agent's turn detector knows which of them was
# the last. The UI closes the learner's bubble on this — see the join rule in
# `frontend/lib/session/reducer.ts`.
ATTR_TURN_SEQ = "tutor.turn_seq"
# `tutor.review_version` is a monotonically increasing integer, bumped every
# time a NEW Review snapshot lands (phase 7 step 3). It starts at "0" — nothing
# generated yet — and the tab refetches `tutor.review` whenever it rises. Push,
# not poll: the Review is generated from the confirmed goal and regenerated
# from the transcript at a hold, so it is no longer a thing made once.
ATTR_REVIEW_VERSION = "tutor.review_version"
# `tutor.goal` is the one line the learner agreed this session is for, published
# once, when the goal is captured. Absent until then. The surface does not need
# it to work — the goal drives the tutor, the analyzer and the Review — but a
# session whose goal is invisible on screen is a session the learner cannot see
# the shape of.
ATTR_GOAL = "tutor.goal"
# `tutor.error` is a short code the frontend can turn into one honest sentence.
# Empty (or absent) means nothing has gone wrong. Two codes today:
#
# `model`        — the realtime model / session errored unrecoverably. The
#                  conversation cannot continue: the worker holds the clock,
#                  debits, and ends the session through the normal
#                  `tutor.session_over` path.
# `tutor_silent` — the first-audio watchdog fired: the session started and no
#                  tutor audio ever played. Nothing was billed (the clock never
#                  started), so this is an alarm the learner can act on
#                  (reload), not an ending.
ATTR_ERROR = "tutor.error"
ERROR_MODEL = "model"
ERROR_TUTOR_SILENT = "tutor_silent"
ERROR_NONE = ""

# Value convention for boolean participant attributes.
ATTR_TRUE = "true"
ATTR_FALSE = "false"
ANALYZER_ON = "on"
ANALYZER_OFF = "off"

# The language the opening goal exchange happens in. `target` by default (the
# vision doc's rule: the conversation opens in the target language); `anchor`
# is the escape hatch a later "which language" card would flip. The standing
# one-anchor-line allowance applies either way, so a learner who stalls still
# gets help.
GOAL_LANGS = ("target", "anchor")

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


class UnmeteredProductionError(RuntimeError):
    """`TUTOR_ALLOW_UNMETERED` on a worker that declared itself production.

    Its own class so the boot refusal is greppable and cannot be swallowed by a
    bare `except RuntimeError` meant for the missing-API-key case.
    """


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

# Endpointing bounds. The floor must stay above the STT's interim flush lag
# (see `TutorConfig.min_endpointing_s`); the ceiling is "a learner would have
# given up by now".
ENDPOINT_MIN_S = 0.2
ENDPOINT_MAX_S = 30.0

# How long ANY hold may last before the worker gives the session up (audit
# §3.3). The floor is "long enough that a learner reading a correction is never
# cut off"; the ceiling keeps a typo from parking a worker slot for a day.
HOLD_IDLE_MIN_S = 60.0
HOLD_IDLE_MAX_S = 4 * 60 * 60.0


def _env_choice(name: str, default: str, choices: tuple[str, ...]) -> str:
    """One of a fixed set, from the environment. A typo warns once and falls back."""
    value = _env(name, default).strip().lower()
    if value not in choices:
        logger.warning("%s=%r is not one of %s; using %r", name, value, choices, default)
        return default
    return value


def _env_reasoning(name: str, default: str) -> str:
    value = _env(name, default).strip().lower()
    if value not in REASONING_EFFORTS:
        logger.warning("%s=%r is not one of %s; using %r", name, value, REASONING_EFFORTS, default)
        return default
    return value


def _env_float(name: str, default: float, *, low: float, high: float) -> float:
    """A bounded float from the environment, guarded like `_env_speed`.

    A typo in one endpointing variable used to kill every job the worker took
    (a bare `float()` at import of the config); now it warns once and runs on
    the default.
    """
    raw = _env(name, str(default))
    try:
        value = float(raw)
    except ValueError:
        logger.warning("%s=%r is not a number; using %s", name, raw, default)
        return default
    if value != value:  # NaN
        logger.warning("%s=%r is not a number; using %s", name, raw, default)
        return default
    clamped = min(max(value, low), high)
    if clamped != value:
        logger.warning("%s=%s is outside %s-%s; using %s", name, value, low, high, clamped)
    return clamped


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
    # Which of the two the opening goal exchange is held in. See `GOAL_LANGS`.
    goal_lang: str = "target"

    # Endpointing. min must comfortably exceed the STT's interim flush lag
    # (~0.5s for gpt-live-transcribe) — below that, turns commit before their
    # transcript arrives and the late flush triggers a phantom second commit
    # that interrupts the tutor's reply (the SDK warns about exactly this,
    # found live 2026-08-12). max is how long an uncertain end-of-turn waits
    # for a learner mid-word-search: 3s (2026-08-23) — at 6s a hedged
    # sentence ("...things like that, you know") scored 0.24 and the learner
    # sat through six seconds of silence before the first reply.
    min_endpointing_s: float = 1.2
    max_endpointing_s: float = 3.0
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

    # How long a hold — the UI's pause, or anything else that stops the meter —
    # may last before the session ends through the normal `session_over` path
    # (audit §3.3). Ten minutes: the zero hold already waits exactly that long,
    # and a learner who has been paused for ten minutes has gone.
    hold_idle_s: float = 600.0

    # Metering is fail-closed (audit B10): a job dispatched with a learner id
    # and no reachable ledger is refused, because the alternative is every
    # learner talking for free and nothing paging. `TUTOR_ALLOW_UNMETERED=1`
    # is the local-development escape hatch, and it logs a warning every time.
    allow_unmetered: bool = False

    # Which deployment this worker is. A free string; `"production"` is the
    # only value that means anything, and it is set explicitly on the prod
    # worker (phase 7: "explicit over heuristic"). Nothing else can tell dev
    # from prod here — both share LiveKit Cloud and a `*.convex.site` host, and
    # a Clerk machine key carries no test/live marker.
    tutor_env: str = ""

    @property
    def is_production(self) -> bool:
        return self.tutor_env.strip().lower() == "production"

    @classmethod
    def from_env(cls) -> TutorConfig:
        tutor_env = _env("TUTOR_ENV", "").strip()
        allow_unmetered = _env_bool("TUTOR_ALLOW_UNMETERED", False)
        if tutor_env.lower() == "production" and allow_unmetered:
            # The one combination that must never boot: unmetered means every
            # learner talks for free and nothing pages. Refusing to start is
            # loud in a way a warning on every session is not.
            raise UnmeteredProductionError(
                "TUTOR_ALLOW_UNMETERED is set on a production worker "
                "(TUTOR_ENV=production). Unmetered sessions bill nothing; it is "
                "a local-development escape hatch only. Unset one of them."
            )
        if not tutor_env and _env("CLERK_WORKER_MACHINE_SECRET_KEY", "").strip():
            # A worker holding a machine key can debit a real ledger. If it has
            # not said which deployment it is, say so once — the guard above
            # cannot protect a worker that never declared itself.
            logger.warning(
                "TUTOR_ENV is not set: this worker has a Clerk machine key but has "
                "not declared its environment. Set TUTOR_ENV=production on the "
                "production worker so TUTOR_ALLOW_UNMETERED can never boot there."
            )

        openai_api_key = _env("OPENAI_API_KEY", "")
        if not openai_api_key.strip():
            # Every model in this worker is OpenAI's. Without the key the job
            # fails somewhere deep in a plugin, mid-session; say so here.
            raise RuntimeError(
                "OPENAI_API_KEY is empty. The worker needs it for the realtime "
                "model, the STT, the analyzer, Ask, Review and translate. Set "
                "it in backend/.env.local or the worker's environment."
            )
        return cls(
            target_lang=_env("TUTOR_TARGET_LANG", "es"),
            anchor_lang=_env("TUTOR_ANCHOR_LANG", "en"),
            goal_lang=_env_choice("TUTOR_GOAL_LANG", "target", GOAL_LANGS),
            min_endpointing_s=_env_float(
                "TUTOR_MIN_ENDPOINT_S", 1.2, low=ENDPOINT_MIN_S, high=ENDPOINT_MAX_S
            ),
            max_endpointing_s=_env_float(
                "TUTOR_MAX_ENDPOINT_S", 3.0, low=ENDPOINT_MIN_S, high=ENDPOINT_MAX_S
            ),
            realtime_model=_env("TUTOR_REALTIME_MODEL", "gpt-realtime-2.1"),
            realtime_reasoning=_env_reasoning("TUTOR_REALTIME_REASONING", "minimal"),
            realtime_speed=_env_speed("TUTOR_REALTIME_SPEED", 1.0),
            realtime_voice=_env("TUTOR_REALTIME_VOICE", "marin"),
            stt_model=_env("TUTOR_STT_MODEL", "gpt-live-transcribe"),
            analyzer_model=_env("TUTOR_ANALYZER_MODEL", "gpt-5.6-luna"),
            analyzer_enabled=_env_bool("TUTOR_ANALYZER_ENABLED", True),
            translate_model=_env("TUTOR_TRANSLATE_MODEL", "gpt-5.6-luna"),
            openai_api_key=openai_api_key,
            hold_idle_s=_env_float(
                "TUTOR_HOLD_IDLE_S", 600.0, low=HOLD_IDLE_MIN_S, high=HOLD_IDLE_MAX_S
            ),
            allow_unmetered=allow_unmetered,
            tutor_env=tutor_env,
        )

    @property
    def target_language_name(self) -> str:
        return language_name(self.target_lang)

    @property
    def goal_language_name(self) -> str:
        """The language the opening goal exchange is held in."""
        if self.goal_lang == "anchor":
            return self.anchor_language_name
        return self.target_language_name

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
