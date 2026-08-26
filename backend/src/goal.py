"""The session's goal: captured once, then fanned out to everything.

The conversation starts with goal setting (phase 7 step 3, Yash 2026-08-25).
The tutor's opening either restates what the learner's pre-flight cards already
said and asks for a yes, or asks what they want to work on — one exchange
either way — and the goal that comes out of it is the session's spine.

Two ways it is captured, in this order:

1. **The `set_session_goal` function tool** (`TutorAgent`, `agent.py`). The only
   mechanism that records what was *agreed* rather than inferred: the tutor
   calls it the moment the learner confirms, and the standing instructions say
   to call it exactly once and never to narrate the call.
2. **A silent extraction**, here, as the safety net. Realtime models at
   `reasoning=minimal` are weak tool-callers (audit §3.2), and a missed call
   used to mean no goal at all — so if nothing has been captured by the time the
   THIRD learner turn commits, one cheap Luna call reads the goal off the
   opening turns. What it produces is `confirmed=False`: nobody agreed it out
   loud.

**Never two goals.** `SessionFacts.set_goal` is first-writer-wins over confirmed
goals, and everything downstream runs from `GoalKeeper.adopt`, which is the only
caller. A slow extraction landing after the learner confirmed changes nothing.

When a goal lands, five things happen (the "spine" decision) — each guarded, so
a failure in one never costs the others:

- the tutor's standing instructions are rebuilt with a GOAL block and pushed to
  the live realtime session (`Agent.update_instructions`),
- the analyzer re-weights towards the goal's forms,
- the Review is generated from it (and regenerated from the transcript at a
  later hold), publishing a new `tutor.review_version`,
- `tutor.goal` is published so a client can show what the session is for,
- and the goal is posted to the ledger immediately, so a session whose teardown
  never runs still has a record of what it was for.
"""

from __future__ import annotations

import asyncio
import json
import logging
from collections.abc import Callable, Coroutine

import openai
from livekit import rtc
from livekit.agents import Agent

from analyzer import CorrectionAnalyzer
from billing import BillingClient
from config import ATTR_GOAL, TutorConfig
from plan import SessionPlan
from prompts import GOAL_SCHEMA, goal_extract_instructions, tutor_instructions
from review import ReviewMaterial
from state import SessionFacts, SessionGoal, SessionState
from usage import UsageTracker

logger = logging.getLogger("tutor.goal")

# After how many committed learner turns the safety net runs. Three is "the
# opening exchange has happened and then some": the tutor asked, the learner
# answered, and one more turn has gone by without the tool firing.
EXTRACT_AFTER_TURNS = 3

# How many turns of the opening the extraction reads, and its budget. Short on
# both counts: the goal is settled in the first exchange, and this is a
# background call that must never become a reason a turn is slow.
EXTRACT_CONTEXT_TURNS = 8
EXTRACT_TIMEOUT_S = 6.0


class GoalKeeper:
    """Owns the session's goal and everything that must happen when it lands."""

    def __init__(
        self,
        cfg: TutorConfig,
        facts: SessionFacts,
        state: SessionState,
        room: rtc.Room,
        *,
        plan: SessionPlan | None = None,
        review: ReviewMaterial | None = None,
        analyzer: CorrectionAnalyzer | None = None,
        billing: BillingClient | None = None,
        usage: UsageTracker | None = None,
        spawn: Callable[..., object] | None = None,
    ) -> None:
        self._cfg = cfg
        self._facts = facts
        self._state = state
        self._room = room
        self._plan = plan
        self._review = review
        self._analyzer = analyzer
        self._billing = billing
        self._usage = usage
        self._spawn = spawn
        self._agent: Agent | None = None
        self._client: openai.AsyncOpenAI | None = None
        self._extract_task: asyncio.Task[None] | None = None
        # One extraction per session, ever. A second one would be a second
        # model call for a question that has already been answered as well as
        # it is going to be.
        self._extraction_done = False

    # --- wiring ----------------------------------------------------------

    def attach(self, agent: Agent) -> None:
        """Hand over the live agent, once `session.start` has run.

        Before this, `adopt` simply skips the instruction push: a goal cannot
        be captured before the tutor exists, and a guard is cheaper than an
        ordering rule nobody can see.
        """
        self._agent = agent

    @property
    def goal(self) -> SessionGoal | None:
        return self._facts.goal

    @property
    def confirmed(self) -> bool:
        goal = self._facts.goal
        return goal is not None and goal.confirmed

    async def aclose(self) -> None:
        task = self._extract_task
        self._extract_task = None
        if task is not None and not task.done():
            task.cancel()
            try:
                await task
            except asyncio.CancelledError:
                pass
            except Exception:
                logger.debug("goal extraction ended with an error", exc_info=True)
        if self._client is not None:
            try:
                await self._client.close()
            except Exception:
                logger.debug("goal client close failed (harmless)", exc_info=True)

    # --- capture ---------------------------------------------------------

    async def adopt(self, goal: SessionGoal | None) -> bool:
        """Make this the session's goal, and tell everything that cares.

        Returns whether it was adopted. The only writer: first one wins (see
        `SessionFacts.set_goal`), so the tool and the extraction can race
        freely and the conversation is never re-aimed underneath itself.
        """
        if goal is None or not self._facts.set_goal(goal):
            return False
        logger.info("session goal set", extra=goal.log_fields())

        # 1. The tutor itself. A live `session.update` over the open realtime
        #    socket — no restart, no interrupted turn; it takes effect from the
        #    model's next response.
        agent = self._agent
        if agent is not None:
            try:
                await agent.update_instructions(tutor_instructions(self._cfg, self._plan, goal))
            except Exception:
                logger.warning("pushing the goal into the standing instructions failed")

        # 2. The analyzer's focus.
        if self._analyzer is not None:
            try:
                self._analyzer.set_goal(goal)
            except Exception:
                logger.warning("re-weighting the analyzer to the goal failed", exc_info=True)

        # 3. The Review, which until now had nothing to be about.
        if self._review is not None:
            try:
                self._review.generate(goal, turn_seq=self._state.turn_seq)
            except Exception:
                logger.warning("starting the goal's review failed", exc_info=True)

        # 4. The surface, and 5. the ledger — both fire-and-forget: neither is
        #    worth a moment of the conversation.
        self._background(self._publish(goal), "tutor-goal-publish")
        self._background(self._report(goal), "tutor-goal-report")
        return True

    def _background(self, coro: Coroutine[object, object, None], name: str) -> None:
        spawn = self._spawn
        if spawn is None:
            # Nothing to run it: close the coroutine rather than leave it
            # un-awaited (a warning, and a slow leak, for no benefit).
            coro.close()
            return
        try:
            spawn(coro, name)
        except Exception:
            logger.debug("could not spawn %s", name, exc_info=True)
            coro.close()

    async def _publish(self, goal: SessionGoal) -> None:
        try:
            await self._room.local_participant.set_attributes({ATTR_GOAL: goal.text})
        except Exception:
            logger.warning("publishing the session goal failed", exc_info=True)

    async def _report(self, goal: SessionGoal) -> None:
        """Post the goal to the ledger now, not only at teardown.

        `/tutor/summary` upserts, so this is the same record the teardown post
        fills in — it just means a session whose worker is killed still says
        what it was for.
        """
        billing = self._billing
        if billing is None or not billing.enabled:
            return
        try:
            await billing.summary(goal=goal.as_wire())
        except Exception:
            logger.warning("posting the goal to the ledger failed", exc_info=True)

    # --- the safety net --------------------------------------------------

    def maybe_extract(self, turns: list[dict[str, str]]) -> None:
        """Run the extraction once, if the tool never fired. Fire-and-forget."""
        if self._extraction_done or self.confirmed:
            return
        if self._state.turn_seq < EXTRACT_AFTER_TURNS:
            return
        if self._extract_task is not None and not self._extract_task.done():
            return
        self._extraction_done = True
        logger.info(
            "no goal after %d turns: extracting one from the transcript",
            self._state.turn_seq,
        )
        self._extract_task = asyncio.create_task(self._extract(turns), name="tutor-goal-extract")

    async def _extract(self, turns: list[dict[str, str]]) -> None:
        lines = "\n".join(
            f"{turn.get('role', 'learner')}: {turn.get('text', '')}"
            for turn in turns[-EXTRACT_CONTEXT_TURNS:]
            if str(turn.get("text") or "").strip()
        )
        if not lines:
            return
        try:
            payload = await asyncio.wait_for(self._request(lines), timeout=EXTRACT_TIMEOUT_S)
        except asyncio.CancelledError:
            raise
        except asyncio.TimeoutError:
            logger.warning("goal extraction timed out; the session runs without a goal")
            return
        except Exception:
            logger.exception("goal extraction failed; the session runs without a goal")
            return

        if not isinstance(payload, dict) or payload.get("found") is not True:
            logger.info("goal extraction found nothing to work with")
            return
        goal = SessionGoal.make(
            payload.get("goal"),
            payload.get("forms"),
            source="extracted",
            # Nobody agreed this out loud — it was read off the transcript.
            confirmed=False,
        )
        await self.adopt(goal)

    async def _request(self, lines: str) -> object:
        if self._client is None:
            self._client = openai.AsyncOpenAI(
                api_key=self._cfg.openai_api_key or None, max_retries=0
            )
        response = await self._client.responses.create(
            model=self._cfg.analyzer_model,
            instructions=goal_extract_instructions(self._cfg),
            input="The opening of the conversation:\n" + lines,
            reasoning={"effort": "none"},
            text={
                "format": {
                    "type": "json_schema",
                    "name": "session_goal",
                    "strict": True,
                    "schema": GOAL_SCHEMA,
                }
            },
        )
        if self._usage is not None:
            self._usage.record_text_usage(response, label="goal")
        return json.loads(response.output_text)
