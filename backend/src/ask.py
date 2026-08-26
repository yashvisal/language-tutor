"""The Ask tab: one learner question in, one coaching answer out.

The pause surface's third tab (phase 4, WS4c). The learner has held the session,
opened Ask, and typed something — "why is it fui and not fue?", "how do I ask
for the bill?" — and the answer comes back as text, in the anchor language,
while the voice model sits idle and unbilled. Study is cheap; speech is metered.

Three things make this its own module rather than another branch of the tutor:

- **It is a coach, not a ghostwriter.** The whole persona lives in
  `ASK_INSTRUCTIONS`: explain the pattern, make them try first, hand over a
  finished sentence only when they ask outright or have already tried. A tab
  that writes the learner's next spoken turn for them has cancelled the session.
- **The client owns the thread.** The worker keeps no per-thread state: each
  request carries the last few exchanges, so a reconnect, a second thread, or a
  thread anchored to a different transcript moment all just work.
- **The cap is invisible.** Past `MAX_QUESTIONS` the tab does not error and does
  not grey out — it answers with a warm one-line redirect back to speaking and
  flags `limit` so the client can render it as the answer it is.

Like `translate.py`, every failure path is a returned `error` string, never a
raise: the surface has already unfrozen and the session must not notice.
"""

from __future__ import annotations

import asyncio
import json
import logging
import random
import time

import openai
from livekit import rtc
from livekit.agents import AgentSession, JobContext

from analyzer import ContextTurn, context_lines, recent_context
from config import RPC_ASK, TutorConfig
from plan import SessionPlan
from prompts import (
    ASK_LIMIT_LINES,
    ask_instructions,
    ask_session_context,
    plan_facts,
)
from state import SessionFacts

logger = logging.getLogger("tutor.ask")

# The invisible cap: questions per session that get a real answer. Twenty-five
# is far past honest study and well short of "using this as a chatbot" — the
# learner who hits it has stopped practising, which is what the redirect says.
MAX_QUESTIONS = 25

# How much of the live conversation the coach sees. Enough to know what they
# were just trying to say; not so much that the answer starts summarising the
# session back at them.
CONTEXT_TURNS = 10

# How much of the client-owned thread we accept. Must match
# `ASK_HISTORY_MESSAGES` in `frontend/lib/session/protocol.ts` — the client
# already trims to this, and we trim again because it is untrusted input.
MAX_THREAD_MESSAGES = 16

# Same bounds the frontend enforces on its side (`MAX_QUESTION_CHARS`). A
# paragraph is not a question.
MAX_QUESTION_CHARS = 400
MAX_THREAD_MESSAGE_CHARS = 800

# The frontend gives up at 5s (`ASK_TIMEOUT_MS`), so the worker's own budget
# sits just inside it: a clean "ask timed out" the tab can render beats a
# transport failure on a request the caller has already abandoned.
REQUEST_TIMEOUT = 4.5

ROLES = ("learner", "coach")


class AskCoach:
    """Answers one question at a time, with the session as context.

    Its own OpenAI client, for the same reason `SpanTranslator` has one: the
    analyzer can be turned off entirely and the study surface must keep working.
    Built lazily and warmed in the background, because the first request through
    a fresh client pays CA-bundle load, SSL setup and a TLS handshake — a full
    second that would otherwise land on the learner's first question.
    """

    def __init__(
        self,
        cfg: TutorConfig,
        plan: SessionPlan | None = None,
        facts: SessionFacts | None = None,
    ) -> None:
        self._cfg = cfg
        self._plan = plan
        self._facts = facts
        self._instructions = ask_instructions(cfg)
        self._client: openai.AsyncOpenAI | None = None
        self._warm_task: asyncio.Task[None] | None = None
        self._asked = 0
        self._last_limit_line: str | None = None

    # --- observation -----------------------------------------------------

    @property
    def asked(self) -> int:
        return self._asked

    @property
    def at_limit(self) -> bool:
        return self._asked >= MAX_QUESTIONS

    def limit_line(self) -> str:
        """A warm redirect back to speaking, never the same one twice running."""
        line = random.choice([x for x in ASK_LIMIT_LINES if x != self._last_limit_line])
        self._last_limit_line = line
        return line

    # --- lifecycle -------------------------------------------------------

    def _get_client(self) -> openai.AsyncOpenAI:
        if self._client is None:
            self._client = openai.AsyncOpenAI(
                api_key=self._cfg.openai_api_key or None, max_retries=0
            )
        return self._client

    async def warm(self) -> None:
        try:
            await self._get_client().models.retrieve(self._cfg.analyzer_model)
        except Exception:
            logger.debug("ask warmup failed (harmless)", exc_info=True)

    def warm_in_background(self) -> None:
        """Fire-and-forget `warm()`. The task reference lives on the instance
        (which the RPC closure keeps alive) so it cannot be GC-cancelled."""
        self._warm_task = asyncio.create_task(self.warm())

    async def aclose(self) -> None:
        # A warm-up still in flight holds a socket into a loop that is closing
        # under it, and logs its own failure on the way out. Cancel it first.
        task = self._warm_task
        self._warm_task = None
        if task is not None and not task.done():
            task.cancel()
            try:
                await task
            except asyncio.CancelledError:
                pass
            except Exception:
                logger.debug("warm-up failed on the way out (harmless)", exc_info=True)
        if self._client is not None:
            await self._client.close()

    # --- answering -------------------------------------------------------

    def _situation(self) -> list[str]:
        """What the coach knows about the session it is being asked about."""
        lines = plan_facts(self._plan) if self._plan is not None else []
        summary = self._facts.summary() if self._facts is not None else None
        if summary:
            lines.append(summary)
        return lines

    def _prompt(
        self,
        *,
        question: str,
        thread: list[tuple[str, str]],
        context: list[ContextTurn],
    ) -> str:
        parts: list[str] = []
        situation = self._situation()
        if situation:
            parts.append(ask_session_context(situation))
        parts.append(
            "Their spoken conversation, most recent last:\n"
            + (context_lines(context) or "(they have not said anything yet)")
        )
        if thread:
            parts.append(
                "This question thread so far:\n"
                + "\n".join(f"{role}: {text}" for role, text in thread)
            )
        parts.append("Their question:\n" + question)
        return "\n\n".join(parts)

    async def answer(
        self,
        *,
        question: str,
        thread: list[tuple[str, str]],
        context: list[ContextTurn],
    ) -> str:
        response = await self._get_client().responses.create(
            model=self._cfg.analyzer_model,
            instructions=self._instructions,
            input=self._prompt(question=question, thread=thread, context=context),
            # Same reason as the analyzer and translate: default reasoning
            # effort puts time-to-first-token outside an interactive budget.
            reasoning={"effort": "none"},
        )
        return (response.output_text or "").strip()

    def count_question(self) -> None:
        """Burn one of the session's questions. Only a real answer costs one —
        a timeout or a failure must not spend a learner's allowance."""
        self._asked += 1


def _coerce_thread(value: object) -> list[tuple[str, str]]:
    """The client-owned thread, trimmed and type-checked at the boundary.

    Oldest first, capped at `MAX_THREAD_MESSAGES`; anything malformed is dropped
    rather than fatal, because a thread is context and a missing line only makes
    the answer slightly less informed.
    """
    if not isinstance(value, (list, tuple)):
        return []
    thread: list[tuple[str, str]] = []
    for entry in value:
        if not isinstance(entry, dict):
            continue
        role = entry.get("role")
        text = entry.get("text")
        if role not in ROLES or not isinstance(text, str):
            continue
        cleaned = " ".join(text.split())[:MAX_THREAD_MESSAGE_CHARS]
        if cleaned:
            thread.append((role, cleaned))
    return thread[-MAX_THREAD_MESSAGES:]


async def register_ask_rpc(ctx: JobContext, session: AgentSession, coach: AskCoach) -> None:
    """Wire `tutor.ask`.

    Request:  `{"question": str, "turn_id": str?, "history": [{"role", "text"}]}`
    Response: `{"answer": str, "limit"?: true}` or `{"error": str}`.
    """

    async def _ask(data: rtc.RpcInvocationData) -> str:
        started = time.monotonic()
        try:
            payload = json.loads(data.payload or "{}")
            if not isinstance(payload, dict):
                raise ValueError("payload is not an object")
        except (json.JSONDecodeError, ValueError):
            logger.warning("tutor.ask: unparseable payload")
            return json.dumps({"error": "bad request"})

        raw_question = payload.get("question")
        raw_turn_id = payload.get("turn_id")
        question = " ".join(raw_question.split()) if isinstance(raw_question, str) else ""
        turn_id = raw_turn_id if isinstance(raw_turn_id, str) else None

        if not question:
            return json.dumps({"error": "nothing to ask"})
        if len(question) > MAX_QUESTION_CHARS:
            return json.dumps({"error": "question too long"})

        # The cap, before the model call — the point of a cap is not paying for
        # the request. It still answers: the redirect IS the response.
        if coach.at_limit:
            logger.info("ask cap reached", extra={"turn_id": turn_id, "asked": coach.asked})
            return json.dumps({"answer": coach.limit_line(), "limit": True}, ensure_ascii=False)

        thread = _coerce_thread(payload.get("history"))
        context = recent_context(session.history, limit=CONTEXT_TURNS)

        try:
            answer = await asyncio.wait_for(
                coach.answer(question=question, thread=thread, context=context),
                timeout=REQUEST_TIMEOUT,
            )
        except asyncio.CancelledError:
            raise
        except asyncio.TimeoutError:
            logger.warning("tutor.ask timed out", extra={"turn_id": turn_id})
            return json.dumps({"error": "ask timed out"})
        except Exception:
            logger.exception("tutor.ask failed", extra={"turn_id": turn_id})
            return json.dumps({"error": "ask failed"})

        if not answer:
            logger.warning("tutor.ask returned nothing", extra={"turn_id": turn_id})
            return json.dumps({"error": "ask failed"})

        coach.count_question()
        logger.info(
            "answered question",
            extra={
                "turn_id": turn_id,
                "asked": coach.asked,
                "thread_turns": len(thread),
                "chars": len(answer),
                "latency_ms": int((time.monotonic() - started) * 1000),
            },
        )
        return json.dumps({"answer": answer}, ensure_ascii=False)

    ctx.room.local_participant.register_rpc_method(RPC_ASK, _ask)
