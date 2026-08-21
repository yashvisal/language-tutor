"""The session arc: the shape a session moves through, owned by the worker.

Straight role-play for fifteen minutes is bad pedagogy and a realtime model
asked to sustain one rambles to fill the time. So a session is a gradual
release in four phases, proportioned 1 / 4 / 4 / 1 of the minutes budget:

    frame    — anchor language. Name the situation and the focus form, model
               ONE example, invite ONE try. Tiny and applied, never a lecture.
    guided   — bilingual. The tutor hands an INTENT in the anchor language, the
               learner produces the target language, the tutor answers in
               character. "Doing certain bits together."
    scene    — target language. The role-play for real, played through BEATS
               with natural ends.
    debrief  — anchor language. Two things that went well, one to remember.

Three rules hold this together:

- **The worker owns the phase, not the model.** Phase changes are time-driven
  and they ride on the clock's ACTIVE seconds (see `clock.py`): a learner who
  spends four minutes reading a correction has not spent four minutes of arc.
- **Transitions are instruction updates, never interruptions.** The worker
  rewrites the standing prompt's CURRENT PHASE block through
  `Agent.update_instructions()`; the model picks the new phase up on its next
  turn, so nothing cuts an in-flight one.
- **The arc is a guide, never a lock.** Consent lives inside the briefs (the
  worker cannot hear the learner say "yes"), and every brief tells the model to
  follow a learner who asks a question, switches language, skips ahead, or
  wanders — and to come back when it is natural.

Like the clock, this talks to the outside world only through the callbacks it
is given, which is what makes it exercisable with fakes.
"""

from __future__ import annotations

import logging
from collections.abc import Awaitable, Callable
from dataclasses import dataclass

from config import TutorConfig
from plan import SessionPlan
from prompts import arc_phase_block

logger = logging.getLogger("tutor.arc")

FRAME = "frame"
GUIDED = "guided"
SCENE = "scene"
DEBRIEF = "debrief"

# Name and share of the budget. Ten shares total, so a two-minute test session
# still walks all four phases in the same proportions as a ten-minute one.
PHASE_SHARES: tuple[tuple[str, int], ...] = (
    (FRAME, 1),
    (GUIDED, 4),
    (SCENE, 4),
    (DEBRIEF, 1),
)

# The fallback shape for a scenario or topic we have no beats for — including
# every free-text topic a learner types. Three beats, deliberately vague: they
# give the scene an end without pretending to know the situation.
GENERIC_BEATS: tuple[str, ...] = (
    "open the situation and settle into it",
    "develop it — one complication, or one detail worth going into",
    "bring it to a natural close",
)

# Beats for the frontend's curated scenarios (see `frontend/lib/session/plan.ts`
# — these keys must match the `value` strings it sends). Language-neutral
# English descriptions of what happens; the model renders them in the target
# language. Each beat has a natural end, which is what lets the tutor move on
# without narrating a transition.
BEATS_BY_SCENARIO: dict[str, tuple[str, ...]] = {
    "ordering at a restaurant": (
        "arrive and get a table",
        "order something to eat and something to drink",
        "a small problem with the order",
        "pay and leave",
    ),
    "catching up with a friend": (
        "greet each other and ask how things have been",
        "one of you has news worth reacting to",
        "the other one tells their side of it",
        "make a loose plan to meet again, and say goodbye",
    ),
    "telling a story about last weekend": (
        "set the scene: when it was, where, and who was there",
        "what happened, step by step",
        "the part worth telling — the surprise, the problem, the funny bit",
        "how it ended, and what they made of it",
    ),
    "asking for directions": (
        "stop someone politely and say where you are trying to get to",
        "take the directions and repeat them back",
        "something is unclear — ask one more question",
        "thank them and go",
    ),
    "a job interview": (
        "greet each other and introduce yourself",
        "talk about what you have done before",
        "one harder question about how you work",
        "ask a question of your own, and close",
    ),
    # A learner who chose "free conversation" chose not to have a situation.
    "free conversation": GENERIC_BEATS,
}


def beats_for(plan: SessionPlan | None) -> tuple[str, ...]:
    """The scene's beats for this plan: scenario first, then topic, then generic."""
    if plan is not None:
        for key in (plan.scenario, plan.topic):
            if key:
                beats = BEATS_BY_SCENARIO.get(key.strip().lower())
                if beats:
                    return beats
    return GENERIC_BEATS


@dataclass(frozen=True)
class PhaseWindow:
    """One phase and the slice of active session time it owns."""

    name: str
    start_s: float
    end_s: float


def phase_windows(max_minutes: int) -> list[PhaseWindow]:
    """Cut the budget into the four phases, proportionally.

    Boundaries are computed from the running share rather than accumulated per
    phase, so the last window ends exactly on the budget at any duration.
    """
    budget = max(0.0, max_minutes * 60.0)
    total = sum(share for _, share in PHASE_SHARES)
    windows: list[PhaseWindow] = []
    cursor = 0.0
    consumed = 0
    for name, share in PHASE_SHARES:
        consumed += share
        end = budget * consumed / total
        windows.append(PhaseWindow(name, cursor, end))
        cursor = end
    return windows


class SessionArc:
    """The phase machine for one session.

    Monotonic by construction: the index only ever moves forward, and each
    phase is entered at most once. If the session is paused when a boundary
    passes, the transition is *held* and applied on `notify_resumed()` — the
    same deferral the clock uses for its wrap-up brief, for the same reason
    (a phase change the learner is not present for is a phase change wasted).
    """

    def __init__(
        self,
        max_minutes: int,
        plan: SessionPlan | None = None,
        *,
        on_phase: Callable[[], Awaitable[None]],
        is_paused: Callable[[], bool],
    ) -> None:
        self._windows = phase_windows(max_minutes)
        self._plan = plan
        self._beats = beats_for(plan)
        self._on_phase = on_phase
        self._is_paused = is_paused
        self._index = 0
        self._pending: int | None = None

    # --- observation -----------------------------------------------------

    @property
    def phase(self) -> str:
        return self._windows[self._index].name

    @property
    def windows(self) -> list[PhaseWindow]:
        return list(self._windows)

    @property
    def beats(self) -> list[str]:
        return list(self._beats)

    def brief(self, cfg: TutorConfig, facts: str | None = None) -> str:
        """The CURRENT PHASE block for the phase the session is in right now."""
        return arc_phase_block(
            cfg,
            phase=self.phase,
            subject=self._plan.subject if self._plan is not None else None,
            beats=self._beats,
            facts=facts,
        )

    # --- the machine -----------------------------------------------------

    async def tick(self, active_s: float) -> None:
        """Called with the clock's active seconds, once per tick."""
        target = self._index_at(active_s)
        if target <= self._index:
            return
        if self._is_paused():
            if self._pending != target:
                self._pending = target
                logger.info(
                    "arc phase held: session is paused",
                    extra={"arc_phase": self._windows[target].name},
                )
            return
        await self._enter(target, active_s)

    async def notify_resumed(self) -> None:
        """Apply a phase change that came due while the session was paused."""
        pending = self._pending
        self._pending = None
        if pending is None or pending <= self._index:
            return
        await self._enter(pending, self._windows[pending].start_s)

    async def _enter(self, index: int, active_s: float) -> None:
        self._index = index
        self._pending = None
        logger.info(
            "arc phase",
            extra={"arc_phase": self._windows[index].name, "active_s": round(active_s, 1)},
        )
        try:
            await self._on_phase()
        except Exception:
            # A failed instruction update must not take the conversation with
            # it: the model simply keeps the previous phase's brief.
            logger.exception("arc phase transition failed")

    def _index_at(self, active_s: float) -> int:
        index = 0
        for i, window in enumerate(self._windows):
            if active_s >= window.start_s:
                index = i
        return index
