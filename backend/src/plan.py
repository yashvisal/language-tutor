"""The dispatch metadata: what the frontend declares about this session.

Two things arrive on `JobContext.job.metadata` as one JSON string, set by the
token route's `RoomAgentDispatch`:

- the **billing** facts (`balance_s`, `user_id`) that the clock meters against,
  and
- the **session plan** (`plan`) — the learner's declared intent for this
  conversation: a topic or a scenario, focus tenses, vocab themes, a level.

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

from config import SESSION_LANGUAGES

logger = logging.getLogger("tutor.plan")

# The budget a session falls back to when the metadata carries no balance —
# a worker run straight from the CLI, with no token route in front of it. In
# production the token route always sends one (and refuses at zero), so this
# only ever applies to development.
DEFAULT_BALANCE_S = 600

# Guard rail on a number that decides how long we pay for an audio model.
MAX_BALANCE_S = 24 * 60 * 60

# How many list entries we accept, and how long each may be. The frontend picks
# a handful; anything past this is either a mistake or an attempt to stuff the
# tutor's system prompt.
MAX_LIST_ITEMS = 8
MAX_ITEM_CHARS = 60
MAX_TEXT_CHARS = 200

# The levels the frontend offers (`LEVEL_VALUES` in `lib/session/plan.ts`).
# `from_raw` still accepts any short string — the prompt reads it as prose —
# but only one of these may appear in an INFO log: a hand-built dispatch can
# put anything in `level`, and anything is learner text (A12; CodeRabbit,
# PR #12).
KNOWN_LEVELS = frozenset(
    {
        "beginner",
        "understands more than they can say",
        "comfortable, wants polish",
    }
)


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
    steers the conversation, the greeting opens inside the scenario, the
    analyzer weights its corrections, and the Review tab builds its material
    from it.
    """

    target_language: str | None = None
    topic: str | None = None
    scenario: str | None = None
    tenses: list[str] = field(default_factory=list)
    # The two open lines the learner typed in their own words, beside the
    # catalogs: what they want pushed on, and anything else we should know.
    # Worth more than the chips around them, and passed through verbatim.
    focus_note: str | None = None
    note: str | None = None
    vocab: list[str] = field(default_factory=list)
    level: str | None = None

    @classmethod
    def from_raw(cls, raw: object) -> SessionPlan:
        if not isinstance(raw, dict):
            return cls()
        return cls(
            target_language=(
                raw["target_language"]
                if isinstance(raw.get("target_language"), str)
                and raw["target_language"] in SESSION_LANGUAGES
                else None
            ),
            topic=_text(raw.get("topic")),
            scenario=_text(raw.get("scenario")),
            tenses=_text_list(raw.get("tenses")),
            focus_note=_text(raw.get("focus_note")),
            note=_text(raw.get("note")),
            vocab=_text_list(raw.get("vocab")),
            level=_text(raw.get("level"), limit=MAX_ITEM_CHARS),
        )

    @property
    def is_empty(self) -> bool:
        """True when the learner declared nothing — "just talk to me"."""
        return not any(
            (
                self.topic,
                self.scenario,
                self.tenses,
                self.focus_note,
                self.note,
                self.vocab,
                self.level,
            )
        )

    @property
    def subject(self) -> str | None:
        """The one thing the conversation is about, scenario first.

        A scenario is a stronger instruction than a topic (it says *who the
        tutor is being*, not just what to talk about), so it wins when both
        are set.
        """
        return self.scenario or self.topic

    def to_wire(self) -> dict[str, object]:
        """The plan as the frontend dispatched it, for `POST /tutor/open`.

        The row the worker opens carries the plan from here on, so it goes
        back over the wire in the dispatch shape (snake_case) and Convex
        bounds it again on arrival.
        """
        return {
            "target_language": self.target_language,
            "topic": self.topic,
            "scenario": self.scenario,
            "tenses": list(self.tenses),
            "focus_note": self.focus_note,
            "note": self.note,
            "vocab": list(self.vocab),
            "level": self.level,
        }

    def log_fields(self) -> dict[str, object]:
        """The plan's SHAPE, for the session's opening INFO line.

        Prefixed: these land in a LogRecord's namespace alongside the worker's
        own fields. No learner-typed prose (A12, phase 8 decision (b)): the
        topic, the scenario, the focus note and the free-text note are all
        things a learner typed, and none of them belong in a log an operator
        reads. What is left is what an operator actually triages on — was a
        plan sent at all, how much of it, and at what level.
        `debug_fields()` has the prose for a laptop.
        """
        return {
            "plan_present": not self.is_empty,
            "plan_has_topic": bool(self.topic),
            "plan_has_scenario": bool(self.scenario),
            "plan_has_focus_note": bool(self.focus_note),
            "plan_has_note": bool(self.note),
            "plan_tenses": len(self.tenses),
            "plan_vocab": len(self.vocab),
            # The level only when it is one of ours; anything else is text a
            # learner (or a hand-built dispatch) wrote, and says so.
            "plan_level": (
                self.level if self.level in KNOWN_LEVELS else ("other" if self.level else None)
            ),
        }

    def debug_fields(self) -> dict[str, object]:
        """The plan's prose, for DEBUG only. Never log this at INFO."""
        return {
            "plan_topic": self.topic,
            "plan_scenario": self.scenario,
            "plan_tenses": list(self.tenses),
            "plan_focus_note": self.focus_note,
            "plan_note": self.note,
            "plan_vocab": list(self.vocab),
            "plan_level": self.level,
        }


@dataclass(frozen=True)
class JobMetadata:
    """The whole dispatch payload, coerced once.

    `balance_s` is the learner's balance in seconds at session start, and it
    is what the clock meters against: the conversation runs until it is spent
    (see `clock.py`), not for a fixed number of minutes. The token route has
    already read the balance and refused at zero, so the worker trusts the
    number but still clamps it to something a session could plausibly be.
    """

    balance_s: int = DEFAULT_BALANCE_S
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
            balance_s=_balance_s(raw.get("balance_s")),
            user_id=_text(raw.get("user_id"), limit=MAX_ITEM_CHARS),
            plan=SessionPlan.from_raw(raw.get("plan")),
        )


def _balance_s(value: object) -> int:
    # bool is an int subclass; a JSON `true` is not a balance.
    if not isinstance(value, (int, float)) or isinstance(value, bool):
        return DEFAULT_BALANCE_S
    if value != value or value in (float("inf"), float("-inf")):  # NaN / inf
        return DEFAULT_BALANCE_S
    seconds = int(value)
    if seconds < 0:
        logger.warning("balance_s %r is negative; using 0", value)
        return 0
    if seconds > MAX_BALANCE_S:
        logger.warning("balance_s %r above the ceiling; using %d", value, MAX_BALANCE_S)
        return MAX_BALANCE_S
    return seconds
