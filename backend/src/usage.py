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
            for llm in getattr(usage, "_llm_usage", {}).values():
                audio_in += llm.input_audio_tokens - llm.input_cached_audio_tokens
                audio_in_cached += llm.input_cached_audio_tokens
                audio_out += llm.output_audio_tokens
                text_in += llm.input_text_tokens
                text_out += llm.output_text_tokens
            for stt in getattr(usage, "_stt_usage", {}).values():
                stt_seconds += stt.audio_duration

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
