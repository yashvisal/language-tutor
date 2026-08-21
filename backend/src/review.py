"""The Review tab: this session's study material, made once.

The pause surface's second tab (phase 4, WS4c). It answers one question — "what
am I actually working with here?" — from the session plan, and it is deliberately
split in two:

- **Vocabulary and phrases are generated**, once, by the same cheap text model
  the analyzer uses, for the scenario, topic and vocab themes the learner picked
  on the pre-flight screen.
- **Conjugation tables are NOT generated.** They come out of `conjugation/`, a
  shipped engine with hand-written irregulars (see the phase-5 outline: tables
  are deterministic, never LLM-generated). A model that invents a paradigm
  teaches a wrong ending, and unlike a vocabulary gloss nobody would catch it.

Generation starts in the background right after the session does, so the first
time the learner opens Review the material is usually already sitting there. The
RPC is a poll: `{"ready": false}` while the task is in flight, the material
afterwards. A session's material is made once and then never changes, so a
`ready: false` is always "ask again", never an error — and a generation failure
still resolves, with the tables alone, rather than leaving the tab polling
forever.
"""

from __future__ import annotations

import asyncio
import json
import logging
import time

import openai
from livekit import rtc
from livekit.agents import JobContext

import conjugation
from config import RPC_REVIEW, TutorConfig
from plan import SessionPlan
from prompts import plan_facts, review_instructions

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


class ReviewMaterial:
    """The session's study material: generated once, then served from memory.

    Its own OpenAI client, like the translator and the coach — the study surface
    keeps working with `TUTOR_ANALYZER_ENABLED=false`.
    """

    def __init__(self, cfg: TutorConfig, plan: SessionPlan | None = None) -> None:
        self._cfg = cfg
        self._plan = plan
        self._client: openai.AsyncOpenAI | None = None
        self._material: dict[str, object] | None = None
        self._task: asyncio.Task[None] | None = None

    # --- observation -----------------------------------------------------

    @property
    def ready(self) -> bool:
        return self._material is not None

    def snapshot(self) -> dict[str, object] | None:
        """The material, or None while it is still being made."""
        return self._material

    # --- lifecycle -------------------------------------------------------

    def _get_client(self) -> openai.AsyncOpenAI:
        if self._client is None:
            self._client = openai.AsyncOpenAI(
                api_key=self._cfg.openai_api_key or None, max_retries=0
            )
        return self._client

    def generate_in_background(self) -> None:
        """Start making the material. Idempotent; never awaited by anything."""
        if self._task is not None or self._material is not None:
            return
        self._task = asyncio.create_task(self._generate(), name="tutor-review-material")

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

    async def _generate(self) -> None:
        started = time.monotonic()
        tables = self.tables()
        vocab: list[dict[str, str]] = []
        phrases: list[dict[str, str]] = []
        try:
            vocab, phrases = await asyncio.wait_for(self._request(), timeout=REQUEST_TIMEOUT)
        except asyncio.CancelledError:
            raise
        except asyncio.TimeoutError:
            logger.warning("review generation timed out; serving tables only")
        except Exception:
            logger.exception("review generation failed; serving tables only")

        # Resolves either way: a tab that polls forever is worse than a tab with
        # the half of the material that cannot fail.
        self._material = {"vocab": vocab, "phrases": phrases, "tables": tables}
        logger.info(
            "review material ready",
            extra={
                "vocab": len(vocab),
                "phrases": len(phrases),
                "tables": len(tables),
                "latency_ms": int((time.monotonic() - started) * 1000),
            },
        )

    async def _request(self) -> tuple[list[dict[str, str]], list[dict[str, str]]]:
        lines = plan_facts(self._plan) if self._plan is not None else []
        prompt = "What the learner set this session up to be:\n" + (
            "\n".join(f"- {line}" for line in lines)
            or "- nothing in particular; an everyday conversation"
        )

        response = await self._get_client().responses.create(
            model=self._cfg.analyzer_model,
            instructions=review_instructions(self._cfg),
            input=prompt,
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
        payload = json.loads(response.output_text)
        return (
            _items(payload.get("vocab"), MAX_VOCAB),
            _items(payload.get("phrases"), MAX_PHRASES),
        )


async def register_review_rpc(ctx: JobContext, material: ReviewMaterial) -> None:
    """Wire `tutor.review`.

    Request:  `{}`
    Response: `{"ready": false}` or `{"ready": true, "vocab": [...],
              "phrases": [...], "tables": [...]}`.
    """

    async def _review(_data: rtc.RpcInvocationData) -> str:
        # A poll that arrives before anything started it is still a request for
        # the material, so it starts it rather than answering "not ready"
        # forever. No-op once generation is under way.
        material.generate_in_background()
        snapshot = material.snapshot()
        if snapshot is None:
            return json.dumps({"ready": False})
        return json.dumps({"ready": True, **snapshot}, ensure_ascii=False)

    ctx.room.local_participant.register_rpc_method(RPC_REVIEW, _review)
