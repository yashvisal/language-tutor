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

# How many of this session's corrections are kept for the after-session record,
# and how long any one of their strings may be. Both are the ledger's bounds
# (`SUMMARY_LIMITS` in `convex/validators.ts`), re-applied at the place the
# list is built so the record can never be refused for being too big. The most
# recent are kept, like the transcript: a session that produced 300 findings is
# a session whose first fifty are nobody's evidence any more.
MAX_RECORDED_CORRECTIONS = 200
MAX_CORRECTION_CHARS = 500

# The fields one correction carries on the wire, in the order the frontend's
# `Correction` declares them (`lib/session/contract.ts`).
CORRECTION_FIELDS = ("id", "original", "replacement", "category", "severity", "explanation")

# Category names read fine in a brief as-is; only this one needs rewording.
# Anything absent falls through to the category name itself.
_CATEGORY_LABELS = {"naturalness": "phrasing"}


@dataclass
class SessionState:
    paused: bool = False
    # The OTHER thing that holds the meter, and it is not the UI's hold: the
    # learner's participant has left the room (a wifi drop, a closed laptop, a
    # crashed tab). `paused` is mirrored to the frontend as `tutor.paused` and
    # is edge-triggered by the pause RPC, so it must not be borrowed for this —
    # a disconnect that set it would make the *next* pause a no-op. The clock
    # meters against `clock_held`, the union of the two (audit B4).
    learner_absent: bool = False
    # The third hold source, and the only one that never releases: the realtime
    # model died unrecoverably (audit §4.2). The conversation is over — the
    # meter stops here, the teardown debits, and the session ends through the
    # normal `session_over` path — but the seconds between the socket dying and
    # the shutdown landing must not be billed as tutoring.
    model_failed: bool = False
    # The fourth hold source, and the other one that never releases: the
    # ledger stopped answering. Five consecutive failed debits (phase 7 step 1,
    # `billing.MAX_CONSECUTIVE_DEBIT_FAILURES`) mean the worker can no longer
    # tell anyone what this conversation costs, so it stops the meter and ends
    # the session rather than talking on unbilled. The seconds between the last
    # landed debit and the shutdown are not billed — accepted, learner-
    # favouring, and the Convex reconciliation cron closes the row.
    ledger_failed: bool = False
    # The last bridge intent used, so consecutive resumes never repeat a line.
    last_bridge_intent: str | None = None

    # How many learner turns have committed this session. Published as
    # `tutor.turn_seq` (see `_publish_turn_commit` in agent.py): the frontend
    # closes the learner's bubble when this number rises, because no transcript
    # event marks the end of a turn.
    turn_seq: int = 0

    # What the hold interrupted, captured when `tutor.pause` fires. Resume reads
    # it to decide whether the tutor owes the learner a re-entry or should stay
    # quiet and let them lead.
    paused_at: float | None = None
    tutor_was_speaking: bool = False
    reply_was_pending: bool = False
    learner_was_speaking: bool = False

    @property
    def clock_held(self) -> bool:
        """Every reason the meter is not running. The clock's only question."""
        return self.paused or self.learner_absent or self.model_failed or self.ledger_failed

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
    # The corrections themselves, not just their shape. The counts above are
    # what the tutor's brief needs; this is what the after-session record needs
    # (phase 7 step 2) — Convex's backstop for a tab that closed before its
    # `finish` ran, in which case the worker's copy is the only one left.
    corrections: list[dict[str, str]] = field(default_factory=list)

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
            recorded = {
                name: " ".join(str(correction.get(name) or "").split())[:MAX_CORRECTION_CHARS]
                for name in CORRECTION_FIELDS
            }
            if recorded["original"] and recorded["replacement"]:
                self.corrections.append(recorded)
        if counted:
            self.turns_with_corrections += 1
        # Trimmed here rather than at the reader, so a four-hour session's
        # memory is bounded too.
        if len(self.corrections) > MAX_RECORDED_CORRECTIONS:
            del self.corrections[:-MAX_RECORDED_CORRECTIONS]

    def summary(self) -> str | None:
        """One line of evidence, or None when there is nothing worth saying."""
        if not self.corrections_by_category:
            return None
        parts = [
            f"{count} {_CATEGORY_LABELS.get(category, category)}"
            for category, count in self.corrections_by_category.most_common()
        ]
        return "corrections shown to them so far this session: " + ", ".join(parts)
