"""Shared per-session state.

Two separate primitives live here, and they must stay separate:

`SessionState` is the *moment* — pause, and what the pause interrupted. Pause is
a first-class interaction state in this product. The *set of holds* semantics
live client-side (see the product vision): the frontend collapses overlapping
holds and sends a single pause / resume. The worker tracks the resulting boolean
(mirrored onto a participant attribute so it survives a frontend reconnect) plus
a snapshot of what the tutor was doing when the hold opened, which is what makes
a conversational resume possible.

`SessionFacts` is the *evidence* — quiet observations accumulated across the
session, summarised into the tutor's context brief. The analyzer's corrections
are source #1; prior-session summaries, the reflection agent and goal tracking
plug into the same seam later (see phase 3, WS4 layer 3). Deliberately NOT the
learner profile: profile is configuration that is *set*, this is evidence that
is *observed*.
"""

from __future__ import annotations

from collections import Counter
from collections.abc import Iterable, Mapping
from dataclasses import dataclass, field

# Category names read fine in a brief as-is; only this one needs rewording.
# Anything absent falls through to the category name itself.
_CATEGORY_LABELS = {"naturalness": "phrasing"}


@dataclass
class SessionState:
    paused: bool = False

    # What the hold interrupted, captured when `tutor.pause` fires. Resume reads
    # it to decide whether the tutor owes the learner a re-entry or should stay
    # quiet and let them lead.
    paused_at: float | None = None
    tutor_was_speaking: bool = False
    reply_was_pending: bool = False
    learner_was_speaking: bool = False

    def clear_pause_context(self) -> None:
        self.paused_at = None
        self.tutor_was_speaking = False
        self.reply_was_pending = False
        self.learner_was_speaking = False

    @property
    def tutor_owes_reentry(self) -> bool:
        """True when the hold cut the tutor off mid-thought.

        A learner who was mid-utterance when they paused keeps the floor: they
        came back to finish their own sentence, not to be talked at.
        """
        if self.learner_was_speaking:
            return False
        return self.tutor_was_speaking or self.reply_was_pending


@dataclass
class SessionFacts:
    """Rolling, factual observations about this session.

    Small on purpose. It counts things and renders one line; deciding what to do
    with that line belongs to whoever composes the brief.
    """

    corrections_by_category: Counter[str] = field(default_factory=Counter)
    turns_with_corrections: int = 0

    def record_corrections(self, corrections: Iterable[Mapping[str, str]]) -> None:
        """Called with the corrections that were actually published to the UI.

        Only published corrections count: unpublished findings are not evidence
        the learner ever saw.
        """
        counted = 0
        for correction in corrections:
            category = correction.get("category")
            if category:
                self.corrections_by_category[category] += 1
                counted += 1
        if counted:
            self.turns_with_corrections += 1

    def summary(self) -> str | None:
        """One line of evidence, or None when there is nothing worth saying."""
        if not self.corrections_by_category:
            return None
        parts = [
            f"{count} {_CATEGORY_LABELS.get(category, category)}"
            for category, count in self.corrections_by_category.most_common()
        ]
        return "corrections shown to them so far this session: " + ", ".join(parts)
