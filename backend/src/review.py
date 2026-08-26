"""The Review tab: this session's study material, made from the goal.

The pause surface's second tab (phase 4, WS4c; rebuilt in phase 7 step 3). It
answers one question — "what am I actually working with here?" — and it is
deliberately split in two:

- **Vocabulary and phrases are generated**, by the same cheap text model the
  analyzer uses, from the **goal the learner confirmed** and, at a hold, from
  what they have actually been saying.
- **Conjugation tables are NOT generated.** They come out of `conjugation/`, a
  shipped engine with hand-written irregulars (see the phase-5 outline: tables
  are deterministic, never LLM-generated). A model that invents a paradigm
  teaches a wrong ending, and unlike a vocabulary gloss nobody would catch it.

**What changed in phase 7 step 3.** The material used to be generated once, at
session start, from the plan alone, and then memoized forever — so a session
that drifted from restaurants to taxis reviewed restaurants (backlog #2), and
with the plan picker no longer setting tenses or scenarios *every* session got
the same four generic tables (audit §3.2). Now:

- Nothing is generated until the goal lands. A hold before that still resolves
  the tab, with the tables alone — a tab that polls forever is the worse
  outcome, and the tables cannot fail.
- Every generation produces a NEW versioned snapshot. `version` starts at 0
  (nothing yet), and each snapshot bumps it; the worker publishes it as the
  `tutor.review_version` participant attribute, so the tab is *told* rather
  than polling something that used to never change.
- The last good material stays served while a regeneration is in flight. The
  tab never empties.
"""

from __future__ import annotations

import asyncio
import json
import logging
import time
from collections.abc import Awaitable, Callable

import openai
from livekit import rtc
from livekit.agents import JobContext

import conjugation
from config import RPC_REVIEW, TutorConfig
from plan import SessionPlan
from prompts import plan_facts, review_instructions
from state import SessionGoal
from usage import UsageTracker

logger = logging.getLogger("tutor.review")

# Off the critical path entirely — nothing waits on this but a learner who
# opened the tab within seconds of starting, and they poll. Generous enough that
# a slow model still lands rather than leaving the tab with tables only.
REQUEST_TIMEOUT = 30.0

# What we ask for, and what we will accept back. The ceilings are a little above
# the targets in the prompt: a model that returns thirteen items has not failed,
# a model that returns fifty has.
MAX_VOCAB = 16
MAX_PHRASES = 12
MAX_ITEM_CHARS = 120

# How many learner turns must have committed since the last generation before a
# hold is allowed to spend another model call. Three is "the conversation has
# actually moved"; without a floor, every glance at a correction would
# regenerate the tab (audit §3.2 (d): each regeneration is a Luna call).
MIN_TURNS_BETWEEN_GENERATIONS = 3

# How much of the conversation a regeneration sees. The material is for what
# they are working on now, not a summary of the session.
MAX_TRANSCRIPT_TURNS = 40
MAX_TRANSCRIPT_CHARS = 6000

REVIEW_SCHEMA = {
    "type": "object",
    "additionalProperties": False,
    "required": ["vocab", "phrases"],
    "properties": {
        "vocab": {
            "type": "array",
            "items": {
                "type": "object",
                "additionalProperties": False,
                "required": ["target", "anchor"],
                "properties": {
                    "target": {"type": "string"},
                    "anchor": {"type": "string"},
                },
            },
        },
        "phrases": {
            "type": "array",
            "items": {
                "type": "object",
                "additionalProperties": False,
                "required": ["target", "anchor"],
                "properties": {
                    "target": {"type": "string"},
                    "anchor": {"type": "string"},
                },
            },
        },
    },
}


def _items(raw: object, limit: int) -> list[dict[str, str]]:
    """Coerce one list of study pairs. Anything unrenderable is dropped."""
    if not isinstance(raw, (list, tuple)):
        return []
    items: list[dict[str, str]] = []
    seen: set[str] = set()
    for entry in raw:
        if not isinstance(entry, dict):
            continue
        target = entry.get("target")
        anchor = entry.get("anchor")
        if not isinstance(target, str) or not isinstance(anchor, str):
            continue
        target = " ".join(target.split())[:MAX_ITEM_CHARS]
        anchor = " ".join(anchor.split())[:MAX_ITEM_CHARS]
        key = target.casefold()
        if not target or not anchor or key in seen:
            continue
        seen.add(key)
        items.append({"target": target, "anchor": anchor})
        if len(items) >= limit:
            break
    return items


def transcript_lines(turns: list[dict[str, str]] | None) -> str:
    """The recent conversation as the generator sees it. Most recent last."""
    if not turns:
        return ""
    lines = [
        f"{turn.get('role', 'learner')}: {' '.join(str(turn.get('text') or '').split())}"
        for turn in turns[-MAX_TRANSCRIPT_TURNS:]
        if isinstance(turn, dict) and str(turn.get("text") or "").strip()
    ]
    return "\n".join(lines)[-MAX_TRANSCRIPT_CHARS:]


class ReviewMaterial:
    """The session's study material: versioned, and regenerated from the goal.

    Its own OpenAI client, like the translator and the coach — the study surface
    keeps working with `TUTOR_ANALYZER_ENABLED=false`.
    """

    def __init__(
        self,
        cfg: TutorConfig,
        plan: SessionPlan | None = None,
        usage: UsageTracker | None = None,
    ) -> None:
        self._cfg = cfg
        self._plan = plan
        self._usage = usage
        self._client: openai.AsyncOpenAI | None = None
        self._material: dict[str, object] | None = None
        self._version = 0
        self._task: asyncio.Task[None] | None = None
        # The turn count at the last generation, so a hold can ask "has enough
        # happened since?" without keeping a second counter.
        self._turns_at_generation = 0
        # The goal the served material was made from, so a snapshot that is
        # tables-only (generated before the goal landed) is not mistaken for
        # material about the goal.
        self._generated_goal: SessionGoal | None = None
        self._on_snapshot: Callable[[int], Awaitable[None]] | None = None

    # --- observation -----------------------------------------------------

    @property
    def ready(self) -> bool:
        return self._material is not None

    @property
    def version(self) -> int:
        """0 until the first snapshot lands, then one per snapshot."""
        return self._version

    @property
    def generating(self) -> bool:
        return self._task is not None and not self._task.done()

    def snapshot(self) -> dict[str, object] | None:
        """The material, or None while the first one is still being made."""
        return self._material

    def set_snapshot_handler(self, handler: Callable[[int], Awaitable[None]] | None) -> None:
        """What to do when a new snapshot lands — publish `tutor.review_version`.

        Set after construction because the material is built before the room
        attributes are wired. Awaited inside the generation task, and guarded
        there: a failed publish costs a refetch, never the material.
        """
        self._on_snapshot = handler

    # --- lifecycle -------------------------------------------------------

    def _get_client(self) -> openai.AsyncOpenAI:
        if self._client is None:
            self._client = openai.AsyncOpenAI(
                api_key=self._cfg.openai_api_key or None, max_retries=0
            )
        return self._client

    def generate(
        self,
        goal: SessionGoal | None = None,
        *,
        transcript: list[dict[str, str]] | None = None,
        turn_seq: int = 0,
    ) -> bool:
        """Start a generation. Returns whether one actually started.

        Idempotent while a generation is in flight — a second call is a no-op,
        and the material already being served is untouched until the new one
        lands. With no goal it does not call a model at all: it resolves the
        tab with the tables, which is the no-goal fallback the first hold
        needs.
        """
        if self.generating:
            return False
        self._turns_at_generation = turn_seq
        self._task = asyncio.create_task(
            self._generate(goal, transcript), name="tutor-review-material"
        )
        return True

    def should_regenerate(self, goal: SessionGoal | None, turn_seq: int) -> bool:
        """Whether a hold has earned a fresh generation (see the constant).

        Two ways yes: there is a goal and nothing has ever been generated from
        it, or the conversation has moved at least `MIN_TURNS_BETWEEN_GENERATIONS`
        turns since the last one. Never while one is in flight.
        """
        if goal is None or self.generating:
            return False
        if self._version == 0 or self._generated_goal is None:
            # Nothing yet, or only the tables — which is what a hold before the
            # goal landed leaves behind, and what a goal that arrived while
            # that generation was in flight cannot overwrite.
            return True
        return turn_seq - self._turns_at_generation >= MIN_TURNS_BETWEEN_GENERATIONS

    async def aclose(self) -> None:
        task = self._task
        self._task = None
        if task is not None and not task.done():
            task.cancel()
            try:
                await task
            except asyncio.CancelledError:
                pass
            except Exception:
                logger.debug("review generation ended with an error", exc_info=True)
        if self._client is not None:
            await self._client.close()

    # --- generation ------------------------------------------------------

    def tables(self) -> list[dict]:
        """The deterministic half. Available without a model, always."""
        plan = self._plan
        try:
            return conjugation.tables_for(
                self._cfg.target_lang,
                tenses=plan.tenses if plan is not None else (),
                scenario=plan.scenario if plan is not None else None,
                topic=plan.topic if plan is not None else None,
            )
        except Exception:
            logger.exception("conjugation tables failed")
            return []

    async def _generate(
        self,
        goal: SessionGoal | None,
        transcript: list[dict[str, str]] | None,
    ) -> None:
        started = time.monotonic()
        tables = self.tables()
        vocab: list[dict[str, str]] = []
        phrases: list[dict[str, str]] = []
        if goal is not None:
            try:
                vocab, phrases = await asyncio.wait_for(
                    self._request(goal, transcript), timeout=REQUEST_TIMEOUT
                )
            except asyncio.CancelledError:
                raise
            except asyncio.TimeoutError:
                logger.warning("review generation timed out; serving tables only")
            except Exception:
                logger.exception("review generation failed; serving tables only")

        if not vocab and not phrases and self._material is not None:
            # A failed regeneration keeps the last good material. Emptying a tab
            # that already had something in it is the one outcome worse than
            # stale material.
            logger.info("review regeneration produced nothing; keeping the last snapshot")
            return

        # Resolves either way: a tab that polls forever is worse than a tab with
        # the half of the material that cannot fail.
        self._material = {"vocab": vocab, "phrases": phrases, "tables": tables}
        self._version += 1
        self._generated_goal = goal
        logger.info(
            "review material ready",
            extra={
                "version": self._version,
                "goal": goal.text if goal is not None else None,
                "vocab": len(vocab),
                "phrases": len(phrases),
                "tables": len(tables),
                "latency_ms": int((time.monotonic() - started) * 1000),
            },
        )
        handler = self._on_snapshot
        if handler is not None:
            try:
                await handler(self._version)
            except Exception:
                logger.warning("publishing the review version failed", exc_info=True)

    async def _request(
        self,
        goal: SessionGoal,
        transcript: list[dict[str, str]] | None,
    ) -> tuple[list[dict[str, str]], list[dict[str, str]]]:
        parts = ["What this session is for, as the learner agreed it:\n- " + goal.text]
        if goal.forms:
            parts[0] += "\n- the forms it invites: " + ", ".join(goal.forms)
        lines = plan_facts(self._plan) if self._plan is not None else []
        if lines:
            parts.append(
                "What they set the session up to be:\n" + "\n".join(f"- {line}" for line in lines)
            )
        conversation = transcript_lines(transcript)
        if conversation:
            parts.append("What they have actually been saying:\n" + conversation)

        response = await self._get_client().responses.create(
            model=self._cfg.analyzer_model,
            instructions=review_instructions(self._cfg),
            input="\n\n".join(parts),
            reasoning={"effort": "none"},
            text={
                "format": {
                    "type": "json_schema",
                    "name": "review_material",
                    "strict": True,
                    "schema": REVIEW_SCHEMA,
                }
            },
        )
        if self._usage is not None:
            self._usage.record_text_usage(response, label="review")
        payload = json.loads(response.output_text)
        return (
            _items(payload.get("vocab"), MAX_VOCAB),
            _items(payload.get("phrases"), MAX_PHRASES),
        )


async def register_review_rpc(ctx: JobContext, material: ReviewMaterial) -> None:
    """Wire `tutor.review`.

    Request:  `{}`
    Response: `{"ready": false, "version": 0}` or `{"ready": true, "version": n,
              "vocab": [...], "phrases": [...], "tables": [...]}`.

    `version` is the same number the `tutor.review_version` attribute carries:
    the tab refetches when the attribute rises, and compares to be sure it got
    the snapshot it was told about.
    """

    async def _review(_data: rtc.RpcInvocationData) -> str:
        # A poll that arrives before anything has been generated still has to be
        # answered. With no goal yet there is nothing to generate FROM, so this
        # resolves the tab with the tables alone rather than leaving it polling
        # forever — the no-goal fallback (phase 7 step 3).
        if material.snapshot() is None and not material.generating:
            material.generate()
        snapshot = material.snapshot()
        if snapshot is None:
            return json.dumps({"ready": False, "version": material.version})
        return json.dumps(
            {"ready": True, "version": material.version, **snapshot}, ensure_ascii=False
        )

    ctx.room.local_participant.register_rpc_method(RPC_REVIEW, _review)
