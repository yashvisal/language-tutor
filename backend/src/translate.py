"""Select-to-translate: one span in, one translation out.

Phase 3 replaced the ambient translation socket with this (see
`plans/phases/phase-3-comprehension-on-demand.md`). The learner selects settled
text on screen — theirs or the tutor's — and the selection holds the session
while an overlay shows what it means. Because the span is *settled* text, this
is a plain request/response call to the same cheap text model the analyzer uses:
no stream, no clock, no arrival-time attribution.

The frontend times out at 5s and shows a shimmer while it waits, so the whole
handler is budgeted well under that: failures return `{"error": ...}` rather
than raising, and never take the session down with them.
"""

from __future__ import annotations

import asyncio
import json
import logging
import time

import openai
from livekit import rtc
from livekit.agents import AgentSession, JobContext

from analyzer import ContextTurn, context_lines, recent_context
from config import RPC_TRANSLATE, TutorConfig
from prompts import translate_instructions

logger = logging.getLogger("tutor.translate")

# Enough surrounding conversation to resolve a pronoun or an idiom, not enough
# to tempt the model into translating the context instead of the span.
CONTEXT_TURNS = 4

# Comfortably inside the frontend's 5s timeout: better a clean error the overlay
# can render than a request the caller has already given up on.
REQUEST_TIMEOUT = 4.0

# The overlay is for spans, not documents. A selection longer than this is
# almost certainly a stray triple-click.
MAX_SPAN_CHARS = 600

SPEAKERS = ("learner", "tutor")


class SpanTranslator:
    """Translates one selected span from the target language into the anchor.

    Its own OpenAI client rather than the analyzer's: the analyzer can be turned
    off entirely (`TUTOR_ANALYZER_ENABLED=false`) and translation must keep
    working, so borrowing its client would make lifetimes conditional for no
    real gain.
    """

    def __init__(self, cfg: TutorConfig) -> None:
        self._cfg = cfg
        self._instructions = translate_instructions(cfg)
        # Built on first use. Constructing the client loads the CA bundle and
        # builds an SSL context, and the translator is constructed on every job
        # while plenty of sessions never translate anything — so that cost does
        # not belong on the path to `session.start`.
        self._client: openai.AsyncOpenAI | None = None

    def _get_client(self) -> openai.AsyncOpenAI:
        if self._client is None:
            self._client = openai.AsyncOpenAI(
                api_key=self._cfg.openai_api_key or None, max_retries=0
            )
        return self._client

    async def warm(self) -> None:
        """Pre-pay the cold-start costs off the critical path.

        The first request through a fresh client pays CA-bundle load, SSL
        context, and the TLS handshake — up to a second on a bad network,
        which lands on the learner's FIRST translation card. A free
        `models.retrieve` warms the whole path. Called as a background task
        after session start; failures are irrelevant (the real request will
        just pay the cost itself).
        """
        try:
            await self._get_client().models.retrieve(self._cfg.translate_model)
        except Exception:
            logger.debug("translate warmup failed (harmless)", exc_info=True)

    def warm_in_background(self) -> None:
        """Fire-and-forget `warm()`. The task reference lives on the instance
        (which the RPC closure keeps alive) so it cannot be GC-cancelled."""
        self._warm_task = asyncio.create_task(self.warm())

    async def aclose(self) -> None:
        if self._client is not None:
            await self._client.close()

    async def translate(self, *, text: str, speaker: str, context: list[ContextTurn]) -> str:
        prompt = (
            "Conversation for context:\n"
            + (context_lines(context) or "(no conversation yet)")
            + f"\n\nSpan to translate (spoken by the {speaker}):\n"
            + text
        )

        response = await self._get_client().responses.create(
            model=self._cfg.translate_model,
            instructions=self._instructions,
            input=prompt,
            # Same reason as the analyzer: default reasoning effort puts
            # time-to-first-token well outside an interactive budget.
            reasoning={"effort": "none"},
        )
        return (response.output_text or "").strip()


async def register_translate_rpc(
    ctx: JobContext, session: AgentSession, translator: SpanTranslator
) -> None:
    """Wire `tutor.translate`.

    Request:  `{"text": str, "speaker": "learner" | "tutor", "turn_id": str?}`
    Response: `{"translation": str}` or `{"error": str}`.
    """

    async def _translate(data: rtc.RpcInvocationData) -> str:
        started = time.monotonic()
        try:
            payload = json.loads(data.payload or "{}")
            if not isinstance(payload, dict):
                raise ValueError("payload is not an object")
        except (json.JSONDecodeError, ValueError):
            logger.warning("tutor.translate: unparseable payload")
            return json.dumps({"error": "bad request"})

        raw_text = payload.get("text")
        raw_turn_id = payload.get("turn_id")
        text = raw_text.strip() if isinstance(raw_text, str) else ""
        speaker = payload.get("speaker") if payload.get("speaker") in SPEAKERS else "learner"
        turn_id = raw_turn_id if isinstance(raw_turn_id, str) else None

        if not text:
            return json.dumps({"error": "nothing to translate"})
        if len(text) > MAX_SPAN_CHARS:
            return json.dumps({"error": "selection too long"})

        # The span itself is in the history; excluding its turn would drop the
        # sentence it sits in, which is exactly the context that disambiguates.
        context = recent_context(session.history, limit=CONTEXT_TURNS)

        try:
            translation = await asyncio.wait_for(
                translator.translate(text=text, speaker=speaker, context=context),
                timeout=REQUEST_TIMEOUT,
            )
        except asyncio.CancelledError:
            raise
        except asyncio.TimeoutError:
            logger.warning("tutor.translate timed out", extra={"turn_id": turn_id})
            return json.dumps({"error": "translation timed out"})
        except Exception:
            logger.exception("tutor.translate failed", extra={"turn_id": turn_id})
            return json.dumps({"error": "translation failed"})

        if not translation:
            logger.warning("tutor.translate returned nothing", extra={"turn_id": turn_id})
            return json.dumps({"error": "translation failed"})

        logger.info(
            "translated span",
            extra={
                "turn_id": turn_id,
                "speaker": speaker,
                "chars": len(text),
                "latency_ms": int((time.monotonic() - started) * 1000),
            },
        )
        return json.dumps({"translation": translation}, ensure_ascii=False)

    ctx.room.local_participant.register_rpc_method(RPC_TRANSLATE, _translate)
