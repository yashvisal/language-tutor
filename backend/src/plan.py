"""The dispatch metadata: what the frontend declares about this session.

Two things arrive on `JobContext.job.metadata` as one JSON string, set by the
token route's `RoomAgentDispatch`:

- the **billing** facts (`max_minutes`, `user_id`) that the clock enforces, and
- the **session plan** (`plan`) — the learner's declared intent for the next
  ten minutes: a topic or a scenario, focus tenses, vocab themes, a level.

Everything here crosses the wire from another process, so everything is
optional and every type is checked once, at the boundary. A missing, empty, or
unparseable payload is not an error: it yields the default budget and an empty
plan, and the session runs exactly as it did before phase 4.

Nothing in this file is language-specific. Tense names ("preterite",
"subjunctive", …) and vocab themes are opaque strings chosen by the frontend
for the configured target language and passed straight through to the prompts.
"""

from __future__ import annotations

import json
import logging
from dataclasses import dataclass, field

logger = logging.getLogger("tutor.plan")

# The default session length, used whenever the metadata does not say
# otherwise. Ten minutes is one arc at comfortable proportions (see `arc.py`);
# the credit unit itself lives in plans/phases/phase-4-sellable-sessions.md.
DEFAULT_MAX_MINUTES = 10

# Guard rails on a number that decides how long we pay for an audio model.
MIN_MAX_MINUTES = 1
MAX_MAX_MINUTES = 120

# How many list entries we accept, and how long each may be. The frontend picks
# a handful; anything past this is either a mistake or an attempt to stuff the
# tutor's system prompt.
MAX_LIST_ITEMS = 8
MAX_ITEM_CHARS = 60
MAX_TEXT_CHARS = 200


def _text(value: object, *, limit: int = MAX_TEXT_CHARS) -> str | None:
    if not isinstance(value, str):
        return None
    cleaned = " ".join(value.split())
    return cleaned[:limit] or None


def _text_list(value: object) -> list[str]:
    if not isinstance(value, (list, tuple)):
        return []
    items: list[str] = []
    for entry in value:
        cleaned = _text(entry, limit=MAX_ITEM_CHARS)
        if cleaned and cleaned not in items:
            items.append(cleaned)
        if len(items) >= MAX_LIST_ITEMS:
            break
    return items


@dataclass(frozen=True)
class SessionPlan:
    """The session's declared intent. Every field is optional by design.

    Four consumers read it, and they read it differently: the tutor prompt
    steers the conversation, the greeting opens inside the scenario, the arc
    picks the scene's beats from it, and the analyzer weights its corrections.
    The Review tab (phase 5) is the fifth.
    """

    topic: str | None = None
    scenario: str | None = None
    tenses: list[str] = field(default_factory=list)
    vocab: list[str] = field(default_factory=list)
    level: str | None = None

    @classmethod
    def from_raw(cls, raw: object) -> SessionPlan:
        if not isinstance(raw, dict):
            return cls()
        return cls(
            topic=_text(raw.get("topic")),
            scenario=_text(raw.get("scenario")),
            tenses=_text_list(raw.get("tenses")),
            vocab=_text_list(raw.get("vocab")),
            level=_text(raw.get("level"), limit=MAX_ITEM_CHARS),
        )

    @property
    def is_empty(self) -> bool:
        """True when the learner declared nothing — "just talk to me"."""
        return not any((self.topic, self.scenario, self.tenses, self.vocab, self.level))

    @property
    def subject(self) -> str | None:
        """The one thing the conversation is about, scenario first.

        A scenario is a stronger instruction than a topic (it says *who the
        tutor is being*, not just what to talk about), so it wins when both
        are set.
        """
        return self.scenario or self.topic

    def log_fields(self) -> dict[str, object]:
        # Prefixed: these land in a LogRecord's namespace alongside the
        # worker's own fields.
        return {
            "plan_topic": self.topic,
            "plan_scenario": self.scenario,
            "plan_tenses": self.tenses,
            "plan_vocab": self.vocab,
            "plan_level": self.level,
        }


@dataclass(frozen=True)
class JobMetadata:
    """The whole dispatch payload, coerced once.

    `max_minutes` is what the clock enforces; the frontend has already checked
    the learner's balance before minting the token, so the worker trusts the
    number but still clamps it to something a session could plausibly be.
    """

    max_minutes: int = DEFAULT_MAX_MINUTES
    user_id: str | None = None
    plan: SessionPlan = field(default_factory=SessionPlan)

    @classmethod
    def parse(cls, payload: str | None) -> JobMetadata:
        if not payload or not payload.strip():
            return cls()
        try:
            raw = json.loads(payload)
        except json.JSONDecodeError:
            logger.warning("job metadata is not JSON; running with defaults")
            return cls()
        if not isinstance(raw, dict):
            logger.warning("job metadata is not an object; running with defaults")
            return cls()
        return cls(
            max_minutes=_max_minutes(raw.get("max_minutes")),
            user_id=_text(raw.get("user_id"), limit=MAX_ITEM_CHARS),
            plan=SessionPlan.from_raw(raw.get("plan")),
        )


def _max_minutes(value: object) -> int:
    # bool is an int subclass; a JSON `true` is not a duration.
    if not isinstance(value, (int, float)) or isinstance(value, bool):
        return DEFAULT_MAX_MINUTES
    if value != value or value in (float("inf"), float("-inf")):  # NaN / inf
        return DEFAULT_MAX_MINUTES
    minutes = int(value)
    if minutes < MIN_MAX_MINUTES:
        logger.warning("max_minutes %r below the floor; using %d", value, MIN_MAX_MINUTES)
        return MIN_MAX_MINUTES
    if minutes > MAX_MAX_MINUTES:
        logger.warning("max_minutes %r above the ceiling; using %d", value, MAX_MAX_MINUTES)
        return MAX_MAX_MINUTES
    return minutes
