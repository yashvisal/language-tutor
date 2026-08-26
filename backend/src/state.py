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
session, summarised into the tutor's context brief. Three sources today: the
analyzer's published corrections, each learner turn's language (the
anchor-language ratio), and the session's `SessionGoal` — what the learner
agreed this conversation is for. Prior-session summaries and the reflection
agent plug into the same seam later (see phase 3, WS4 layer 3). Deliberately
NOT the learner profile: profile is configuration that is *set*, this is
evidence that is *observed*.
"""

from __future__ import annotations

from collections import Counter
from collections.abc import Iterable, Mapping
from dataclasses import dataclass, field

from plan import SessionPlan

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

# The goal's bounds, and the ledger's (`/tutor/summary`, phase 7 step 3). Same
# rule as the corrections above: applied where the object is built, so a goal
# can never be the reason a session's record is refused.
MAX_GOAL_CHARS = 200
MAX_GOAL_FORMS = 8
MAX_GOAL_FORM_CHARS = 60

# Where a goal came from. `plan` is the deterministic pre-seed from the cards
# the learner filled in (unconfirmed until they say yes), `tool` is the tutor
# calling `set_session_goal` once the learner confirmed, `extracted` is the
# silent safety net reading it off the transcript.
GOAL_SOURCES = ("plan", "tool", "extracted")

# The per-turn language verdict the analyzer returns, and how much each one
# counts towards the anchor-language ratio. A learner who reaches for one word
# in the anchor language is halfway to needing support; one who answers
# entirely in it is there (phase 7 step 3, "support on evidence").
TURN_LANGUAGES = ("target", "anchor", "mixed")
_ANCHOR_WEIGHT = {"target": 0.0, "mixed": 0.5, "anchor": 1.0}

# Below this many judged turns the ratio is noise — one anchor-language answer
# out of two is not a pattern — so no brief mentions it.
MIN_TURNS_FOR_RATIO = 3

# Category names read fine in a brief as-is; only this one needs rewording.
# Anything absent falls through to the category name itself.
_CATEGORY_LABELS = {"naturalness": "phrasing"}


def _clean(value: object, limit: int) -> str:
    return " ".join(str(value or "").split())[:limit]


@dataclass(frozen=True)
class SessionGoal:
    """What this conversation is for, in the learner's own terms.

    The session's spine (phase 7 step 3): it drives the tutor's standing
    instructions, the analyzer's focus, the Ask context, the Review material
    and the after-session record. Small and flat on purpose — one line the
    tutor can restate, plus the forms it invites.

    `confirmed` is the difference between "the cards suggested this" and "the
    learner said yes to this". Only a confirmed goal is treated as settled; an
    unconfirmed pre-seed is what the opening exchange asks about.
    """

    text: str
    forms: tuple[str, ...] = ()
    source: str = "plan"
    confirmed: bool = False

    @classmethod
    def make(
        cls,
        text: object,
        forms: object = (),
        *,
        source: str = "plan",
        confirmed: bool = False,
    ) -> SessionGoal | None:
        """Build a bounded goal, or None when there is no goal in the input.

        The single constructor: every caller (the plan pre-seed, the function
        tool, the transcript extraction) is untrusted input of some kind, so the
        bounds live here rather than at three call sites.
        """
        cleaned = _clean(text, MAX_GOAL_CHARS)
        if not cleaned:
            return None
        items: list[str] = []
        if isinstance(forms, (list, tuple)):
            for entry in forms:
                form = _clean(entry, MAX_GOAL_FORM_CHARS)
                if form and form not in items:
                    items.append(form)
                if len(items) >= MAX_GOAL_FORMS:
                    break
        return cls(
            text=cleaned,
            forms=tuple(items),
            source=source if source in GOAL_SOURCES else "plan",
            confirmed=bool(confirmed),
        )

    @property
    def settled(self) -> bool:
        """Whether this goal is the session's, rather than a proposal.

        The plan pre-seed is a proposal until the learner says yes: it is what
        the OPENING asks about, and it must not appear in the standing
        instructions or a brief as though it were agreed. Anything captured
        during the conversation — the tool's goal, or the extraction's — is the
        session's goal, even when nobody said it out loud.
        """
        return self.confirmed or self.source != "plan"

    def as_wire(self) -> dict[str, object]:
        """The shape `/tutor/summary` takes. camelCase is Convex's, not ours."""
        return {"text": self.text, "forms": list(self.forms), "source": self.source}

    def log_fields(self) -> dict[str, object]:
        return {
            "goal_text": self.text,
            "goal_forms": list(self.forms),
            "goal_source": self.source,
            "goal_confirmed": self.confirmed,
        }


_QUOTE_PAIRS = (('"', '"'), ("“", "”"), ("‘", "’"))


def quoted_spans(text: str) -> list[str]:
    """Quoted fragments inside a line, in order. Language-neutral by design.

    The one thing a focus note can be parsed for without knowing a word of any
    language: a learner who wrote `work on "he comido" vs "comi"` has named the
    forms themselves. Anything subtler than that is the opening exchange's job
    and the goal tool's — nothing here may hardcode a lexicon (`config.py`'s
    opening rule).
    """
    spans: list[str] = []
    for opener, closer in _QUOTE_PAIRS:
        rest = text
        while True:
            start = rest.find(opener)
            if start < 0:
                break
            end = rest.find(closer, start + 1)
            if end < 0:
                break
            span = " ".join(rest[start + 1 : end].split())
            if span and span not in spans:
                spans.append(span)
            rest = rest[end + 1 :]
    return spans


def goal_from_plan(plan: SessionPlan | None) -> SessionGoal | None:
    """The pre-seeded goal: what the learner's own cards already said.

    Deterministic composition, no model call (phase 7 step 3). The text is the
    most specific thing they typed — the focus note first, because it is the
    most valuable line on the pre-flight screen (audit B7) — and the forms are
    the tenses they picked, or the fragments they quoted in that note.

    Unconfirmed by construction: the cards are a proposal, and the learner
    saying yes in the first exchange is what makes it the session's goal.
    """
    if plan is None:
        return None
    text = plan.focus_note or plan.topic or plan.scenario or plan.note
    if not text:
        return None
    forms: list[str] = list(plan.tenses)
    if not forms and plan.focus_note:
        forms = quoted_spans(plan.focus_note)
    return SessionGoal.make(text, forms, source="plan", confirmed=False)


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
    # The session's spine (phase 7 step 3). Pre-seeded from the plan before the
    # conversation starts, then replaced once by the confirmed goal — the
    # tool's, or the extraction's if the tool never fired. See `set_goal`: a
    # session with two goals has none.
    goal: SessionGoal | None = None
    # How the learner's turns split across the two languages, as the analyzer
    # judged them. The evidence "support on evidence" was always missing
    # (audit §3.2): nothing anywhere measured the mix.
    turn_languages: Counter[str] = field(default_factory=Counter)
    # The corrections themselves, not just their shape. The counts above are
    # what the tutor's brief needs; this is what the after-session record needs
    # (phase 7 step 2) — Convex's backstop for a tab that closed before its
    # `finish` ran, in which case the worker's copy is the only one left.
    corrections: list[dict[str, str]] = field(default_factory=list)

    def set_goal(self, goal: SessionGoal | None) -> bool:
        """Adopt a goal. Returns whether it actually became the session's goal.

        First writer wins: the tool and the extraction safety net can race (a
        slow extraction landing just after the learner confirmed), and the
        second one to arrive must not rewrite what the conversation has
        already been told it is doing. Once a CONFIRMED goal is in place
        nothing replaces it; an unconfirmed pre-seed is always replaceable,
        which is the whole point of it.
        """
        if goal is None:
            return False
        if self.goal is not None and self.goal.confirmed:
            return False
        self.goal = goal
        return True

    def record_turn_language(self, language: object) -> None:
        """One learner turn's language verdict, from the analyzer."""
        if language not in TURN_LANGUAGES:
            # Absent or unknown means the ordinary case: they spoke the target
            # language. Never a reason to drop the turn from the denominator.
            language = "target"
        self.turn_languages[str(language)] += 1

    @property
    def learner_turns_judged(self) -> int:
        return sum(self.turn_languages.values())

    @property
    def anchor_ratio(self) -> float | None:
        """0..1 — how much of the learner's talking was in the anchor language.

        `None` until there is a turn to divide by. A mixed turn counts half:
        reaching for one word in the anchor language is not the same as
        answering in it, and the support rule cares about the difference.
        """
        total = self.learner_turns_judged
        if not total:
            return None
        weighted = sum(_ANCHOR_WEIGHT.get(lang, 0.0) * n for lang, n in self.turn_languages.items())
        return round(min(1.0, max(0.0, weighted / total)), 3)

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

    def evidence(self) -> list[str]:
        """The quiet observations, as plain lines for a brief.

        The goal first (it is what the conversation is for), then the turn
        count and the anchor-language mix once there is enough of both to mean
        anything, then the corrections.
        """
        lines: list[str] = []
        goal = self.goal
        if goal is not None and goal.settled:
            line = f"what this session is for, as they agreed it: {goal.text}"
            if goal.forms:
                line += " (the forms to invite: " + ", ".join(goal.forms) + ")"
            lines.append(line)
        ratio = self.anchor_ratio
        if ratio is not None and self.learner_turns_judged >= MIN_TURNS_FOR_RATIO:
            lines.append(
                f"they have taken {self.learner_turns_judged} turns, and about "
                f"{round(ratio * 100)}% of their talking has been in the anchor language"
            )
        summary = self.summary()
        if summary:
            lines.append(summary)
        return lines

    def summary(self) -> str | None:
        """One line of evidence, or None when there is nothing worth saying."""
        if not self.corrections_by_category:
            return None
        parts = [
            f"{count} {_CATEGORY_LABELS.get(category, category)}"
            for category, count in self.corrections_by_category.most_common()
        ]
        return "corrections shown to them so far this session: " + ", ".join(parts)
