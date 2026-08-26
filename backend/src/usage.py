"""Per-session usage accounting: what the session cost, in tokens and dollars.

Audio is ~94% of the bill, split about evenly between uncached input (the
learner's speech and the room's silence, billed once per turn) and output (the
tutor's speech) — measured 2026-08-21 on gpt-realtime-2.1. The tutor's talk
share is the half we control. Everything else is context for the ledger and
for pricing decisions. Prices are estimates: the whole line is logged, and the
dollars alone ride up with the session record as `estCostUsd` (phase 7 step 4)
so a session's cost sits beside the session — but the ledger bills seconds,
never tokens.
"""

from __future__ import annotations

import logging
from typing import Any

logger = logging.getLogger("tutor.usage")

# USD per 1M tokens / per minute. Update when pricing or models change.
# Audio prices are gpt-realtime-2.1 (OpenAI sheet, 2026-08-21); the mini is
# 3.2x cheaper. Text prices are unverified for this model.
AUDIO_IN_PER_M = 32.0
AUDIO_IN_CACHED_PER_M = 0.40
AUDIO_OUT_PER_M = 64.0
TEXT_IN_PER_M = 0.60
TEXT_OUT_PER_M = 2.40
STT_PER_MIN = 0.017
# OpenAI realtime audio ≈ 1,200 output tokens per spoken minute.
OUTPUT_AUDIO_TOKENS_PER_MIN = 1200.0


class UsageTracker:
    """Holds the latest `session_usage_updated` snapshot and logs a summary."""

    def __init__(self) -> None:
        self._usage: Any | None = None
        # Out-of-band text calls the AgentSession knows nothing about. The
        # session's own `session_usage_updated` covers the realtime model and
        # the STT and nothing else (audit §4.7), so anything that opens its own
        # OpenAI client — the analyzer, Ask, translate, Review, the teardown
        # `about` line — has to hand its usage in here. Only the teardown
        # summary does so far; the rest is one call each away.
        self._aux_text_in = 0
        self._aux_text_out = 0

    def on_usage(self, ev: Any) -> None:
        self._usage = getattr(ev, "usage", None)

    def record_text_usage(self, response: Any, *, label: str) -> None:
        """Count one out-of-band text call. Never raises into its caller."""
        try:
            usage = getattr(response, "usage", None)
            if usage is None:
                return
            input_tokens = int(getattr(usage, "input_tokens", 0) or 0)
            output_tokens = int(getattr(usage, "output_tokens", 0) or 0)
            self._aux_text_in += max(0, input_tokens)
            self._aux_text_out += max(0, output_tokens)
            logger.debug(
                "out-of-band text usage",
                extra={"label": label, "in": input_tokens, "out": output_tokens},
            )
        except Exception:
            logger.debug("could not record text usage", exc_info=True)

    def summary(self, *, active_s: int, room: str = "") -> dict[str, Any]:
        # The ledger's unit is seconds (phase 6); the cost lines want minutes,
        # so this is the one place the conversion happens — as a float, because
        # rounding a 90-second session to "1 minute" doubles its apparent cost.
        active_minutes = active_s / 60.0
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

        aux_text_in = self._aux_text_in
        aux_text_out = self._aux_text_out

        cost = (
            audio_in * AUDIO_IN_PER_M
            + audio_in_cached * AUDIO_IN_CACHED_PER_M
            + audio_out * AUDIO_OUT_PER_M
            + text_in * TEXT_IN_PER_M
            + (text_out + aux_text_out) * TEXT_OUT_PER_M
            + aux_text_in * TEXT_IN_PER_M
        ) / 1_000_000 + (stt_seconds / 60.0) * STT_PER_MIN

        tutor_minutes = audio_out / OUTPUT_AUDIO_TOKENS_PER_MIN
        return {
            "room": room,
            "active_s": active_s,
            "active_minutes": round(active_minutes, 2),
            "audio_in_tokens": audio_in,
            "audio_in_cached_tokens": audio_in_cached,
            "audio_out_tokens": audio_out,
            "text_in_tokens": text_in,
            "text_out_tokens": text_out,
            "aux_text_in_tokens": aux_text_in,
            "aux_text_out_tokens": aux_text_out,
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

    def est_cost_usd(self, *, active_s: int) -> float:
        """This session's estimated model spend, in dollars, for the record.

        The same number `summary()` logs — but this one travels: it is the
        `estCostUsd` field on `/tutor/summary`, so `est_cost_usd` stops being
        a log line nobody reads and becomes a column beside the session it
        belongs to (audit §4.7: "logged and discarded"). Estimate, not a
        bill: the ledger still meters seconds and only seconds.

        Guarded like everything else on the teardown path — a cost line is not
        worth a lost transcript, so anything unusable is reported as 0.
        """
        try:
            cost = float(self.summary(active_s=active_s)["est_cost_usd"])
        except Exception:
            logger.debug("could not estimate the session cost", exc_info=True)
            return 0.0
        if cost != cost or cost in (float("inf"), float("-inf")):
            # NaN or infinity: a wire the ledger would reject outright.
            return 0.0
        return round(max(cost, 0.0), 4)

    def log_summary(self, *, active_s: int, room: str) -> None:
        try:
            logger.info("session usage", extra=self.summary(active_s=active_s, room=room))
        except Exception:
            logger.warning("usage summary failed", exc_info=True)
