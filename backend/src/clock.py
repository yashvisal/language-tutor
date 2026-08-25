"""The session clock. The worker's clock is authoritative (phase 4, WS2).

Minutes are money, so *something* has to own the number and it cannot be the
browser. The learner arrives with a balance in seconds (dispatch metadata from
the token route); the worker starts a wall clock, meters the seconds the
conversation is actually active, publishes elapsed and remaining as participant
attributes (the frontend displays them; it never computes them), nudges the
tutor to finish the thought at 30 s left, and **at zero holds the session** —
it does not end it.

Four deliberate semantics:

- **Pause time is not billed.** The clock accrues only while the session is
  unheld: a learner studying a correction is not spending their minutes
  (decision 2026-08-20).
- **Zero is a hold, not an ending.** The conversation stops and waits: buy more
  and continue in the same room, or leave (decision 2026-08-24). Only an
  abandoned hold ends the session, after `IDLE_TIMEOUT_S`.
- **The budget can grow.** A purchase mid-session re-reads the balance and
  `apply_balance()` moves the budget out from under the same elapsed time, so
  the conversation continues rather than restarting.
- **The nudge waits for a resumed conversation.** If the learner is paused when
  the 30 s mark passes there is nobody to hear it, so the brief is deferred and
  delivered on resume instead — the same seam the conversational resume uses.

The clock talks to the outside world only through the callbacks it is given,
which is what makes it exercisable with fakes.
"""

from __future__ import annotations

import asyncio
import logging
import time
from collections.abc import Awaitable, Callable

from billing import BillingClient

logger = logging.getLogger("tutor.clock")

# How close to zero the tutor is told to finish the thought. Half a minute is
# about one exchange at this tutor's turn length — enough to land a sentence,
# too short to start anything.
NUDGE_S = 30.0

# The frontend's stopwatch updates on this cadence, plus immediately on every
# transition that changes what it should say (hold, resume, nudge, zero).
PUBLISH_INTERVAL_S = 5.0

# How long a session held at zero waits before the worker gives up on it. The
# learner has gone to buy minutes, or has gone.
IDLE_TIMEOUT_S = 600.0

# Loop granularity. Fine enough that the nudge and zero land within a second of
# their mark, coarse enough to be free.
TICK_S = 1.0


class SessionClock:
    """Balance enforcement for one session.

    State, all one-directional except the last:

        running --(remaining <= NUDGE_S)--> nudged --(remaining <= 0)--> held
        held --(apply_balance with room left)--> running

    plus one deferral: if the session is paused when the nudge is due, the
    transition still happens (it never fires twice) but the brief itself is
    held until `notify_resumed()`.
    """

    def __init__(
        self,
        balance_s: int,
        *,
        publish: Callable[[int, int, bool], Awaitable[None]],
        on_nudge: Callable[[], Awaitable[None]],
        on_zero: Callable[[], Awaitable[None]],
        on_idle_end: Callable[[], Awaitable[None]],
        is_paused: Callable[[], bool],
        nudge_s: float = NUDGE_S,
        publish_interval_s: float = PUBLISH_INTERVAL_S,
        idle_timeout_s: float = IDLE_TIMEOUT_S,
        tick_s: float = TICK_S,
    ) -> None:
        self._budget_s = float(max(0, balance_s))
        self._publish = publish
        self._on_nudge = on_nudge
        self._on_zero = on_zero
        self._on_idle_end = on_idle_end
        self._is_paused = is_paused
        self._nudge_s = nudge_s
        self._publish_interval_s = publish_interval_s
        self._idle_timeout_s = idle_timeout_s
        self._tick_s = tick_s

        self._started_at: float | None = None
        # Billed time is ACTIVE time: the clock accrues between ticks only while
        # the session is not held. A learner studying a correction is not
        # spending their minutes (decision 2026-08-20).
        self._active_s = 0.0
        self._last_tick_at: float | None = None
        self._last_publish_at = 0.0
        self._nudged = False
        self._nudge_held = False
        self._out_of_minutes = False
        self._held_at: float | None = None
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
    def out_of_minutes(self) -> bool:
        """True while the session is held at zero balance."""
        return self._out_of_minutes

    @property
    def elapsed_s(self) -> float:
        """Active (unpaused) seconds — what the learner is billed for."""
        return self._active_s

    @property
    def remaining_s(self) -> float:
        return max(0.0, self._budget_s - self.elapsed_s)

    @property
    def seconds_billed(self) -> int:
        """Actual active seconds used — the ledger's debit. Exact, never rounded."""
        return int(min(self.elapsed_s, self._budget_s))

    # --- lifecycle -------------------------------------------------------

    async def start(self) -> None:
        """Start the clock and publish the opening numbers."""
        if self._started_at is not None:
            return
        self._started_at = time.monotonic()
        self._last_tick_at = self._started_at
        await self.publish_now()
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
        """Deliver a nudge that came due while the session was paused."""
        if not self._nudge_held or self._ended:
            return
        self._nudge_held = False
        await self._fire_nudge()

    async def notify_hold_changed(self) -> None:
        """A pause or resume just landed: republish immediately.

        The stopwatch on screen stops and starts with the hold, so the learner
        must not wait up to a publish interval to see it.
        """
        await self.publish_now()

    async def apply_balance(self, balance_s: int) -> bool:
        """Re-budget from a freshly read balance. Returns True if there is room.

        The balance Convex reports is what is left *after* everything this
        session has already debited, so the new budget is the elapsed time plus
        that number: the same conversation continues with more room, rather
        than a new clock starting at zero.
        """
        self._budget_s = self._active_s + float(max(0, balance_s))
        if self.remaining_s <= 0:
            await self.publish_now()
            return False
        self._out_of_minutes = False
        self._held_at = None
        if self.remaining_s > self._nudge_s:
            # A fresh pack earns a fresh nudge.
            self._nudged = False
            self._nudge_held = False
        await self.publish_now()
        return True

    # --- the loop --------------------------------------------------------

    async def _run(self) -> None:
        try:
            while not self._ended:
                await asyncio.sleep(self._tick_s)
                now = time.monotonic()
                if self._last_tick_at is not None and not self._is_paused():
                    self._active_s += now - self._last_tick_at
                self._last_tick_at = now
                await self._evaluate(now)
        except asyncio.CancelledError:
            raise
        except Exception:
            # A dead clock must not take the conversation with it; the session
            # simply runs unmetered and the shutdown path still bills it.
            logger.exception("session clock stopped unexpectedly")

    async def _evaluate(self, now: float) -> None:
        if self._out_of_minutes:
            # Held at zero. Nothing accrues; the only question left is whether
            # the learner is coming back.
            if self._held_at is not None and now - self._held_at >= self._idle_timeout_s:
                await self._idle_end()
            return

        remaining = self.remaining_s

        if remaining <= 0:
            await self._hold_at_zero(now)
            return

        if not self._nudged and remaining <= self._nudge_s:
            self._nudged = True
            await self.publish_now()
            if self._is_paused():
                # Nobody is listening. Hold it for the resume.
                self._nudge_held = True
                logger.info("nudge held: session is paused")
            else:
                await self._fire_nudge()
            return

        if now - self._last_publish_at >= self._publish_interval_s:
            await self.publish_now()

    async def publish_now(self) -> None:
        self._last_publish_at = time.monotonic()
        try:
            await self._publish(int(self.elapsed_s), int(self.remaining_s), self._out_of_minutes)
        except Exception:
            logger.warning("failed to publish the clock", exc_info=True)

    async def _fire_nudge(self) -> None:
        logger.info("nudge sent", extra={"remaining_s": int(self.remaining_s)})
        try:
            await self._on_nudge()
        except Exception:
            logger.exception("nudge failed")

    async def _hold_at_zero(self, now: float) -> None:
        self._out_of_minutes = True
        self._held_at = now
        self._nudge_held = False
        logger.info("out of minutes: holding", extra={"seconds_billed": self.seconds_billed})
        try:
            await self._on_zero()
        except Exception:
            logger.exception("out-of-minutes hold failed")
        await self.publish_now()

    async def _idle_end(self) -> None:
        if self._ended:
            return
        self._ended = True
        logger.info(
            "out of minutes: idle timeout, ending the session",
            extra={"seconds_billed": self.seconds_billed},
        )
        try:
            await self._on_idle_end()
        except Exception:
            logger.exception("session end sequence failed")


async def report_seconds_billed(
    billing: BillingClient | None,
    user_id: str | None,
    seconds: int,
    room: str,
) -> None:
    """The ledger seam: what this session owes, reported once at teardown.

    The number is the session's CUMULATIVE active seconds; the Convex action is
    idempotent per (room, seq) and debits only the delta since the last report,
    so reporting the same total twice is free and reporting a total after a
    mid-session debit charges exactly the difference.

    Retried once, because this is the last chance to bill the session, and
    never raised: a failed debit is a logged fact, not a crash on the way out.
    """
    logger.info(
        "session seconds billed",
        extra={"user_id": user_id, "seconds": seconds, "room": room},
    )
    if billing is None or not billing.enabled:
        return
    if await billing.debit(seconds) is None:
        await billing.debit(seconds)
