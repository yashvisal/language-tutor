"""The session clock. The worker's clock is authoritative (phase 4, WS2).

A credit buys minutes of live conversation, so *something* has to own the
number and it cannot be the browser. The worker starts a wall clock when the
session starts, publishes the minutes left as a participant attribute (the
frontend displays that number; it never computes it), asks the tutor to wrap up
about a minute before the end, and at zero says one short goodbye and closes
the session.

Three deliberate semantics:

- **Pause time is not billed.** The clock accrues only while the session is
  unheld: a learner studying a correction is not spending their minutes
  (decision 2026-08-20, reversing the earlier 'pause billed' call).
- **The wrap-up brief waits for a resumed conversation.** If the learner is
  paused when the one-minute mark passes there is nobody to hear it, so the
  brief is deferred and delivered on resume instead — the same seam the
  conversational resume uses.
- **Active time is the session's heartbeat.** `on_tick` publishes it once per
  tick, which is what the session arc advances on (see `arc.py`): one clock,
  one notion of elapsed, and the arc cannot drift from the billing.

The clock talks to the outside world only through the callbacks it is given,
which is what makes it exercisable with fakes.
"""

from __future__ import annotations

import asyncio
import logging
import math
import time
from collections.abc import Awaitable, Callable

logger = logging.getLogger("tutor.clock")

# How long before the end the tutor is told to start closing. One minute is
# roughly two exchanges at this tutor's turn length.
WARNING_S = 60.0

# The frontend's balance pill updates on this cadence. Cheap (an attribute
# update), and coarse enough not to look like a stopwatch.
PUBLISH_INTERVAL_S = 30.0

# Loop granularity. Fine enough that the warning and the end land within a
# second of their mark, coarse enough to be free.
TICK_S = 1.0


class SessionClock:
    """Wall-clock budget enforcement for one session.

    State machine (one direction only, each transition fires once):

        running --(remaining <= WARNING_S)--> warned --(remaining <= 0)--> ended

    plus one holding state: if the session is paused when the warning is due,
    the transition to `warned` still happens (it never fires twice) but the
    brief itself is held until `notify_resumed()`.
    """

    def __init__(
        self,
        max_minutes: int,
        *,
        publish: Callable[[int], Awaitable[None]],
        on_warning: Callable[[], Awaitable[None]],
        on_end: Callable[[], Awaitable[None]],
        is_paused: Callable[[], bool],
        on_tick: Callable[[float], Awaitable[None]] | None = None,
        warning_s: float = WARNING_S,
        publish_interval_s: float = PUBLISH_INTERVAL_S,
        tick_s: float = TICK_S,
    ) -> None:
        self._budget_s = max(0.0, max_minutes * 60.0)
        self._publish = publish
        self._on_warning = on_warning
        self._on_end = on_end
        self._is_paused = is_paused
        self._on_tick = on_tick
        self._warning_s = warning_s
        self._publish_interval_s = publish_interval_s
        self._tick_s = tick_s

        self._started_at: float | None = None
        # Billed time is ACTIVE time: the clock accrues between ticks only while
        # the session is not held. A learner studying a correction is not
        # spending their minutes (decision 2026-08-20, reversing 'pause billed').
        self._active_s = 0.0
        self._last_tick_at: float | None = None
        self._last_publish_at = 0.0
        self._warned = False
        self._warning_held = False
        self._ended = False
        self._task: asyncio.Task[None] | None = None

    # --- observation -----------------------------------------------------

    @property
    def started(self) -> bool:
        return self._started_at is not None

    @property
    def ended(self) -> bool:
        return self._ended

    @property
    def elapsed_s(self) -> float:
        """Active (unpaused) seconds — what the learner is billed for."""
        return self._active_s

    @property
    def remaining_s(self) -> float:
        if self._started_at is None:
            return self._budget_s
        return max(0.0, self._budget_s - self.elapsed_s)

    @property
    def minutes_left(self) -> int:
        """What the frontend shows. Rounded up, so "1" means "still talking"."""
        return max(0, math.ceil(self.remaining_s / 60))

    @property
    def minutes_billed(self) -> int:
        """Actual minutes used, rounded up — the ledger's debit (never over budget)."""
        elapsed = min(self.elapsed_s, self._budget_s)
        if elapsed <= 0:
            return 0
        return max(1, math.ceil(elapsed / 60))

    # --- lifecycle -------------------------------------------------------

    async def start(self) -> None:
        """Start the clock and publish the opening balance."""
        if self._started_at is not None:
            return
        self._started_at = time.monotonic()
        self._last_tick_at = self._started_at
        await self._publish_now()
        self._task = asyncio.create_task(self._run(), name="tutor-session-clock")

    async def aclose(self) -> None:
        """Stop ticking. Never ends the session — teardown is somebody else's."""
        task = self._task
        self._task = None
        if task is None or task.done() or task is asyncio.current_task():
            return
        task.cancel()
        try:
            await task
        except asyncio.CancelledError:
            pass

    async def notify_resumed(self) -> None:
        """Deliver a wrap-up brief that came due while the session was paused."""
        if not self._warning_held or self._ended:
            return
        self._warning_held = False
        await self._fire_warning()

    # --- the loop --------------------------------------------------------

    async def _run(self) -> None:
        try:
            while not self._ended:
                await asyncio.sleep(self._tick_s)
                now = time.monotonic()
                if self._last_tick_at is not None and not self._is_paused():
                    self._active_s += now - self._last_tick_at
                self._last_tick_at = now
                await self._fire_tick()
                await self._evaluate()
        except asyncio.CancelledError:
            raise
        except Exception:
            # A dead clock must not take the conversation with it; the session
            # simply runs unmetered and the shutdown path still bills it.
            logger.exception("session clock stopped unexpectedly")

    async def _fire_tick(self) -> None:
        """Hand the active elapsed time to whoever rides on it (the arc).

        Guarded like every other callback: a subscriber that raises must not
        stop the clock, because the clock is what ends the session.
        """
        if self._on_tick is None:
            return
        try:
            await self._on_tick(self.elapsed_s)
        except Exception:
            logger.exception("clock tick subscriber failed")

    async def _evaluate(self) -> None:
        remaining = self.remaining_s

        if remaining <= 0:
            await self._publish_now()
            await self._end()
            return

        if not self._warned and remaining <= self._warning_s:
            self._warned = True
            await self._publish_now()
            if self._is_paused():
                # Nobody is listening. Hold it for the resume.
                self._warning_held = True
                logger.info("wrap-up brief held: session is paused")
            else:
                await self._fire_warning()
            return

        if time.monotonic() - self._last_publish_at >= self._publish_interval_s:
            await self._publish_now()

    async def _publish_now(self) -> None:
        self._last_publish_at = time.monotonic()
        try:
            await self._publish(self.minutes_left)
        except Exception:
            logger.warning("failed to publish minutes left", exc_info=True)

    async def _fire_warning(self) -> None:
        logger.info("one minute left: sending the wrap-up brief")
        try:
            await self._on_warning()
        except Exception:
            logger.exception("wrap-up brief failed")

    async def _end(self) -> None:
        if self._ended:
            return
        self._ended = True
        logger.info("session time elapsed", extra={"minutes_billed": self.minutes_billed})
        try:
            await self._on_end()
        except Exception:
            logger.exception("session end sequence failed")


def report_minutes_billed(user_id: str | None, minutes: int, room: str) -> None:
    """The ledger seam: what this session owes, reported once at teardown.

    TODO(phase 5, minutes): POST this to the signed Convex HTTP action — the
    only writer of debit rows (see plans/phases/phase-5-product-shell.md).
    Until it exists this logs, so the number is already in the record and the
    call site never has to move.
    """
    logger.info(
        "session minutes billed",
        extra={"user_id": user_id, "minutes": minutes, "room": room},
    )
