"""Per-session usage accounting: what the session cost, in tokens and dollars.

Output audio is ~97% of the bill (measured 2026-08-20), so the one number this
exists to surface is the tutor's talk share. Everything else is context for the
ledger and for pricing decisions. Prices are estimates for logging only — the
ledger bills minutes, never tokens.
"""

from __future__ import annotations

import logging
import math
from typing import Any

logger = logging.getLogger("tutor.usage")

# USD per 1M tokens / per minute. Update when pricing or models change.
AUDIO_IN_PER_M = 10.0
AUDIO_IN_CACHED_PER_M = 0.30
AUDIO_OUT_PER_M = 20.0
TEXT_IN_PER_M = 0.60
TEXT_OUT_PER_M = 2.40
STT_PER_MIN = 0.017
# OpenAI realtime audio ≈ 1,200 output tokens per spoken minute.
OUTPUT_AUDIO_TOKENS_PER_MIN = 1200.0


class UsageTracker:
    """Holds the latest `session_usage_updated` snapshot and logs a summary."""

    def __init__(self) -> None:
        self._usage: Any | None = None

    def on_usage(self, ev: Any) -> None:
        self._usage = getattr(ev, "usage", None)

    def summary(self, *, active_minutes: int, room: str) -> dict[str, Any]:
        audio_in = audio_in_cached = audio_out = text_in = text_out = 0
        stt_seconds = 0.0
        usage = self._usage
        if usage is not None:
            # `AgentSessionUsage.model_usage` is a flat list of per-model usage
            # objects (LLM / STT / TTS / ...); discriminate by the fields each
            # kind carries rather than by class, so plugin churn can't break it.
            for mu in getattr(usage, "model_usage", []) or []:
                if hasattr(mu, "output_audio_tokens"):
                    audio_in += getattr(mu, "input_audio_tokens", 0) - getattr(
                        mu, "input_cached_audio_tokens", 0
                    )
                    audio_in_cached += getattr(mu, "input_cached_audio_tokens", 0)
                    audio_out += getattr(mu, "output_audio_tokens", 0)
                    text_in += getattr(mu, "input_text_tokens", 0)
                    text_out += getattr(mu, "output_text_tokens", 0)
                elif hasattr(mu, "audio_duration") and not hasattr(mu, "characters_count"):
                    stt_seconds += getattr(mu, "audio_duration", 0.0)

        cost = (
            audio_in * AUDIO_IN_PER_M
            + audio_in_cached * AUDIO_IN_CACHED_PER_M
            + audio_out * AUDIO_OUT_PER_M
            + text_in * TEXT_IN_PER_M
            + text_out * TEXT_OUT_PER_M
        ) / 1_000_000 + (stt_seconds / 60.0) * STT_PER_MIN

        tutor_minutes = audio_out / OUTPUT_AUDIO_TOKENS_PER_MIN
        return {
            "room": room,
            "active_minutes": active_minutes,
            "audio_in_tokens": audio_in,
            "audio_in_cached_tokens": audio_in_cached,
            "audio_out_tokens": audio_out,
            "text_in_tokens": text_in,
            "text_out_tokens": text_out,
            "stt_minutes": round(stt_seconds / 60.0, 2),
            "tutor_talk_minutes": round(tutor_minutes, 2),
            "tutor_talk_share": round(tutor_minutes / active_minutes, 2)
            if active_minutes
            else None,
            "est_cost_usd": round(cost, 4),
            "est_cost_per_active_minute_usd": round(cost / active_minutes, 4)
            if active_minutes
            else None,
        }

    def log_summary(self, *, active_minutes: int, room: str) -> None:
        try:
            logger.info(
                "session usage", extra=self.summary(active_minutes=active_minutes, room=room)
            )
        except Exception:
            logger.warning("usage summary failed", exc_info=True)


def ceil_minutes(seconds: float) -> int:
    return max(0, math.ceil(seconds / 60.0))
