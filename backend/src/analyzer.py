"""Semantic analyzer: settled learner utterance -> structured corrections.

Completely independent of the voice pipeline. It runs as a background task off
`Agent.on_user_turn_completed` and must never block, slow, or break the tutor's
reply — every failure path here is a log line and a dropped correction.

The payload mirrors `frontend/lib/design/mock-conversation.ts`'s `Correction`.
"""

from __future__ import annotations

import asyncio
import json
import logging
import time
import uuid
from dataclasses import dataclass

import openai
from livekit import rtc

from config import (
    ATTR_CORRECTION_COUNT,
    ATTR_TURN_ID,
    TOPIC_CORRECTIONS,
    TutorConfig,
)
from prompts import analyzer_instructions

logger = logging.getLogger("tutor.analyzer")

# Keep this in sync with CorrectionCategory / CorrectionSeverity in
# frontend/lib/design/mock-conversation.ts.
CATEGORIES = ["tense", "agreement", "word-order", "vocabulary", "naturalness"]
SEVERITIES = ["error", "unnatural", "suggestion"]

CORRECTIONS_SCHEMA = {
    "type": "object",
    "additionalProperties": False,
    "required": ["corrections"],
    "properties": {
        "corrections": {
            "type": "array",
            "items": {
                "type": "object",
                "additionalProperties": False,
                "required": [
                    "original",
                    "replacement",
                    "category",
                    "severity",
                    "explanation",
                ],
                "properties": {
                    "original": {
                        "type": "string",
                        "description": "Exact substring of the utterance being corrected.",
                    },
                    "replacement": {"type": "string"},
                    "category": {"type": "string", "enum": CATEGORIES},
                    "severity": {"type": "string", "enum": SEVERITIES},
                    "explanation": {"type": "string"},
                },
            },
        }
    },
}

# How many prior turns of context to send with each utterance. This is the
# *only* knob: `agent._recent_context` reads it to decide how much of the chat
# context to walk back, so the history is truncated exactly once.
CONTEXT_TURNS = 6
REQUEST_TIMEOUT = 12.0


@dataclass
class AnalysisContextTurn:
    speaker: str  # "learner" | "tutor"
    text: str


class CorrectionAnalyzer:
    """Calls a fast structured-output model and publishes the result.

    `reasoning={"effort": "none"}` is mandatory, not a tuning knob: at default
    effort the model's time-to-first-token is far outside the per-utterance hot
    path this sits in.
    """

    def __init__(self, cfg: TutorConfig, room: rtc.Room) -> None:
        self._cfg = cfg
        self._room = room
        self._instructions = analyzer_instructions(cfg)
        self._client = openai.AsyncOpenAI(api_key=cfg.openai_api_key or None, max_retries=0)
        self._tasks: set[asyncio.Task[None]] = set()
        self._seen_turns: set[str] = set()

    def analyze_in_background(
        self,
        *,
        turn_id: str,
        text: str,
        context: list[AnalysisContextTurn],
    ) -> None:
        """Fire-and-forget. Never awaited by the voice pipeline.

        Idempotent per turn id: the worker has two trigger paths (the
        `on_user_turn_completed` node on the OpenAI path, `conversation_item_added`
        on the Grok path) and must be safe if both ever fire for one turn.
        """
        if not self._cfg.analyzer_enabled or not text.strip():
            return
        if turn_id in self._seen_turns:
            return
        self._seen_turns.add(turn_id)

        task = asyncio.create_task(self._run(turn_id=turn_id, text=text, context=context))
        self._tasks.add(task)
        task.add_done_callback(self._tasks.discard)

    async def aclose(self) -> None:
        for task in list(self._tasks):
            task.cancel()
        if self._tasks:
            await asyncio.gather(*self._tasks, return_exceptions=True)
        await self._client.close()

    async def _run(self, *, turn_id: str, text: str, context: list[AnalysisContextTurn]) -> None:
        started = time.monotonic()
        try:
            corrections = await asyncio.wait_for(
                self._request(text=text, context=context), timeout=REQUEST_TIMEOUT
            )
        except asyncio.CancelledError:
            raise
        except Exception:
            logger.exception("analyzer call failed", extra={"turn_id": turn_id})
            return

        latency_ms = int((time.monotonic() - started) * 1000)
        logger.info(
            "analyzed turn",
            extra={
                "turn_id": turn_id,
                "corrections": len(corrections),
                "latency_ms": latency_ms,
            },
        )

        try:
            await self._publish(turn_id=turn_id, text=text, corrections=corrections)
        except Exception:
            logger.exception("failed to publish corrections", extra={"turn_id": turn_id})

    async def _request(
        self, *, text: str, context: list[AnalysisContextTurn]
    ) -> list[dict[str, str]]:
        # Already truncated to CONTEXT_TURNS by the caller — see the comment on
        # the constant. Truncating again here would hide a mismatch.
        lines = [f"{turn.speaker}: {turn.text}" for turn in context]
        prompt = (
            "Conversation so far:\n"
            + ("\n".join(lines) if lines else "(this is the first turn)")
            + "\n\nUtterance to review (learner):\n"
            + text
        )

        response = await self._client.responses.create(
            model=self._cfg.analyzer_model,
            instructions=self._instructions,
            input=prompt,
            # Mandatory: default reasoning effort is unusable in this hot path.
            reasoning={"effort": "none"},
            text={
                "format": {
                    "type": "json_schema",
                    "name": "corrections",
                    "strict": True,
                    "schema": CORRECTIONS_SCHEMA,
                }
            },
        )

        payload = json.loads(response.output_text)
        return self._validate(payload.get("corrections") or [], text)

    def _validate(self, raw: list[dict], utterance: str) -> list[dict[str, str]]:
        """Drop anything the UI cannot render: the span must really be there."""
        corrections: list[dict[str, str]] = []
        for item in raw:
            original = (item.get("original") or "").strip()
            replacement = (item.get("replacement") or "").strip()
            category = item.get("category")
            severity = item.get("severity")
            explanation = (item.get("explanation") or "").strip()

            if not original or not replacement or original == replacement:
                continue
            if original not in utterance:
                logger.debug("dropping correction with non-substring span: %r", original)
                continue
            if category not in CATEGORIES or severity not in SEVERITIES:
                continue

            corrections.append(
                {
                    "id": f"c_{uuid.uuid4().hex[:10]}",
                    "original": original,
                    "replacement": replacement,
                    "category": category,
                    "severity": severity,
                    "explanation": explanation,
                }
            )
        return corrections

    async def _publish(self, *, turn_id: str, text: str, corrections: list[dict[str, str]]) -> None:
        payload = {
            "type": "analysis.complete",
            "turnId": turn_id,
            "text": text,
            "language": self._cfg.target_lang,
            "corrections": corrections,
        }
        await self._room.local_participant.send_text(
            json.dumps(payload, ensure_ascii=False),
            topic=TOPIC_CORRECTIONS,
            attributes={
                ATTR_TURN_ID: turn_id,
                ATTR_CORRECTION_COUNT: str(len(corrections)),
            },
        )
