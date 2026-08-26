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
from livekit.agents import llm

from config import (
    ATTR_CORRECTION_COUNT,
    ATTR_TURN_ID,
    TOPIC_CORRECTIONS,
    TutorConfig,
)
from plan import SessionPlan
from prompts import analyzer_instructions
from state import SessionFacts, SessionGoal
from usage import UsageTracker

logger = logging.getLogger("tutor.analyzer")

# Keep this in sync with CorrectionCategory / CorrectionSeverity in
# frontend/lib/design/mock-conversation.ts.
CATEGORIES = ["tense", "agreement", "word-order", "vocabulary", "naturalness"]
SEVERITIES = ["error", "unnatural", "suggestion"]

# What language the turn as a whole was in. Not a correction — evidence: it is
# the anchor-language ratio the support rule reads (phase 7 step 3), and it
# rides on this call because the analyzer already reads every settled learner
# turn and a second model call for one word would be absurd.
TURN_LANGUAGES = ["target", "anchor", "mixed"]

CORRECTIONS_SCHEMA = {
    "type": "object",
    "additionalProperties": False,
    "required": ["language", "corrections"],
    "properties": {
        "language": {"type": "string", "enum": TURN_LANGUAGES},
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
        },
    },
}

# How many prior turns of context to send with each utterance. This is the
# *only* knob: `recent_context` reads it to decide how much of the chat context
# to walk back, so the history is truncated exactly once.
CONTEXT_TURNS = 6
REQUEST_TIMEOUT = 12.0


@dataclass
class ContextTurn:
    """One speaker-tagged line of conversation history.

    Shared by the analyzer and select-to-translate: both are out-of-band text
    calls that need a little surrounding conversation to judge an utterance.
    """

    speaker: str  # "learner" | "tutor"
    text: str


def recent_context(
    chat_ctx: llm.ChatContext,
    *,
    exclude_id: str | None = None,
    limit: int = CONTEXT_TURNS,
) -> list[ContextTurn]:
    """The last `limit` messages of a chat context, as speaker-tagged lines.

    `limit` defaults to `CONTEXT_TURNS`, the single knob for how much history the
    analyzer sees: the truncation happens here, once, and callers send what they
    are given. Walking backwards means a long lesson's full history is never
    flattened just to throw most of it away.
    """
    turns: list[ContextTurn] = []
    for item in reversed(chat_ctx.items):
        if len(turns) >= limit:
            break
        if getattr(item, "type", None) != "message":
            continue
        if exclude_id is not None and item.id == exclude_id:
            continue
        text = (item.text_content or "").strip()
        if not text:
            continue
        speaker = "learner" if item.role == "user" else "tutor"
        turns.append(ContextTurn(speaker=speaker, text=text))
    turns.reverse()
    return turns


def context_lines(context: list[ContextTurn]) -> str:
    return "\n".join(f"{turn.speaker}: {turn.text}" for turn in context)


class CorrectionAnalyzer:
    """Calls a fast structured-output model and publishes the result.

    `reasoning={"effort": "none"}` is mandatory, not a tuning knob: at default
    effort the model's time-to-first-token is far outside the per-utterance hot
    path this sits in.
    """

    def __init__(
        self,
        cfg: TutorConfig,
        room: rtc.Room,
        facts: SessionFacts | None = None,
        plan: SessionPlan | None = None,
        usage: UsageTracker | None = None,
    ) -> None:
        self._cfg = cfg
        self._room = room
        self._facts = facts
        self._plan = plan
        self._usage = usage
        # The plan only tilts the weighting, and it cannot change mid-session —
        # but the GOAL can arrive one exchange in, so the instructions are
        # rebuilt exactly once, by `set_goal`, when it does.
        self._instructions = analyzer_instructions(cfg, plan)
        self._client = openai.AsyncOpenAI(api_key=cfg.openai_api_key or None, max_retries=0)
        self._tasks: set[asyncio.Task[None]] = set()

    def set_goal(self, goal: SessionGoal) -> None:
        """Re-weight towards the session's confirmed goal (phase 7 step 3)."""
        self._instructions = analyzer_instructions(self._cfg, self._plan, goal)

    def analyze_in_background(
        self,
        *,
        turn_id: str,
        text: str,
        context: list[ContextTurn],
    ) -> None:
        """Fire-and-forget. Never awaited by the voice pipeline."""
        if not self._cfg.analyzer_enabled or not text.strip():
            return

        task = asyncio.create_task(self._run(turn_id=turn_id, text=text, context=context))
        self._tasks.add(task)
        task.add_done_callback(self._tasks.discard)

    async def aclose(self) -> None:
        for task in list(self._tasks):
            task.cancel()
        if self._tasks:
            await asyncio.gather(*self._tasks, return_exceptions=True)
        await self._client.close()

    async def _run(self, *, turn_id: str, text: str, context: list[ContextTurn]) -> None:
        started = time.monotonic()
        try:
            language, corrections = await asyncio.wait_for(
                self._request(text=text, context=context), timeout=REQUEST_TIMEOUT
            )
        except asyncio.CancelledError:
            raise
        except Exception:
            logger.exception("analyzer call failed", extra={"turn_id": turn_id})
            return

        # Evidence, not feedback: recorded whether or not anything is published,
        # because a clean turn in the anchor language is exactly the turn the
        # support rule needs to know about.
        if self._facts is not None:
            self._facts.record_turn_language(language)

        latency_ms = int((time.monotonic() - started) * 1000)
        logger.info(
            "analyzed turn",
            extra={
                "turn_id": turn_id,
                "corrections": len(corrections),
                "turn_language": language,
                "latency_ms": latency_ms,
            },
        )

        try:
            await self._publish(turn_id=turn_id, text=text, corrections=corrections)
        except Exception:
            logger.exception("failed to publish corrections", extra={"turn_id": turn_id})
            return

        # Source #1 of the learner feedback loop. Reported only after a
        # successful publish: what the learner never saw is not evidence.
        if self._facts is not None:
            self._facts.record_corrections(corrections)

    async def _request(
        self, *, text: str, context: list[ContextTurn]
    ) -> tuple[str, list[dict[str, str]]]:
        # Already truncated to CONTEXT_TURNS by the caller — see the comment on
        # the constant. Truncating again here would hide a mismatch.
        prompt = (
            "Conversation so far:\n"
            + (context_lines(context) or "(this is the first turn)")
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

        if self._usage is not None:
            self._usage.record_text_usage(response, label="analyzer")
        payload = json.loads(response.output_text)
        language = payload.get("language")
        if language not in TURN_LANGUAGES:
            # A model that omitted it (or invented a fourth value) has not
            # failed the turn: default to the ordinary case.
            language = "target"
        return language, self._validate(payload.get("corrections") or [], text)

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
