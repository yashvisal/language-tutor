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

And one bound on the other side of the hold, added 2026-08-25 (audit §3.3):
**no hold lasts forever.** A hold is free, which is exactly why an abandoned
one is expensive to us — a learner who paused and closed the laptop held the
room, the worker slot and the realtime socket indefinitely, because the idle
timeout was only ever checked at zero balance. Any hold older than
`hold_idle_timeout_s` (`TUTOR_HOLD_IDLE_S`) now ends the session through the
same `on_idle_end` path the abandoned zero hold uses.

One more, added 2026-08-25 (audit §4.1): **the ledger is told every minute, not
only at the end.** Debits used to fire at zero and in the shutdown callback, so
a SIGKILL at minute 45 billed nothing. The clock now calls `on_debit` every
`DEBIT_INTERVAL_S` *active* seconds; the report is cumulative and the ledger
takes only the delta, so the extra calls cost nothing and a killed worker has
lost at most a minute.

The clock talks to the outside world only through the callbacks it is given —
including its clock: `now` is injected, which is what makes the whole thing
exercisable with fakes and no sleeping.
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

# The same question for an ORDINARY hold (audit §3.3): a learner who paused to
# read a correction and then closed the laptop lid used to hold the room, the
# worker slot and the realtime socket forever, because the idle timeout above
# was only ever checked at zero balance. Holds are free, so this costs the
# learner nothing and costs us a slot — which is exactly why it is bounded.
# Overridden per-session from `TUTOR_HOLD_IDLE_S`.
HOLD_IDLE_TIMEOUT_S = 600.0

# Loop granularity. Fine enough that the nudge and zero land within a second of
# their mark, coarse enough to be free.
TICK_S = 1.0

# How much active time may accrue before the ledger hears about it. The report
# is cumulative and the ledger debits only the delta, so this is the ceiling on
# what a crashed worker can lose, not a cost.
DEBIT_INTERVAL_S = 60.0


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
        on_debit: Callable[[], Awaitable[None]] | None = None,
        nudge_s: float = NUDGE_S,
        publish_interval_s: float = PUBLISH_INTERVAL_S,
        idle_timeout_s: float = IDLE_TIMEOUT_S,
        hold_idle_timeout_s: float = HOLD_IDLE_TIMEOUT_S,
        tick_s: float = TICK_S,
        debit_interval_s: float = DEBIT_INTERVAL_S,
        now: Callable[[], float] = time.monotonic,
    ) -> None:
        self._budget_s = float(max(0, balance_s))
        self._publish = publish
        self._on_nudge = on_nudge
        self._on_zero = on_zero
        self._on_idle_end = on_idle_end
        self._on_debit = on_debit
        self._is_paused = is_paused
        self._nudge_s = nudge_s
        self._publish_interval_s = publish_interval_s
        self._idle_timeout_s = idle_timeout_s
        self._hold_idle_timeout_s = hold_idle_timeout_s
        self._tick_s = tick_s
        self._debit_interval_s = debit_interval_s
        self._now = now

        self._started_at: float | None = None
        # Billed time is ACTIVE time: the clock accrues between ticks only while
        # the session is not held. A learner studying a correction is not
        # spending their minutes (decision 2026-08-20).
        self._active_s = 0.0
        self._last_tick_at: float | None = None
        self._last_publish_at = 0.0
        # Active seconds at the last debit — the periodic report measures
        # ACTIVE time, not wall time, so a long hold does not owe a debit.
        self._last_debit_active_s = 0.0
        self._nudged = False
        self._nudge_held = False
        self._out_of_minutes = False
        self._held_at: float | None = None
        # When the CURRENT ordinary hold began, or None while the session is
        # running. Distinct from `_held_at`, which is the zero hold and is
        # about a balance, not about a learner who walked away.
        self._hold_since: float | None = None
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
        self._started_at = self._now()
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
                await self.tick()
        except asyncio.CancelledError:
            raise
        except Exception:
            # A dead clock must not take the conversation with it; the session
            # simply runs unmetered and the shutdown path still bills it.
            logger.exception("session clock stopped unexpectedly")

    async def tick(self) -> None:
        """One turn of the loop: accrue the interval, then re-evaluate.

        Separated from `_run` so it can be driven directly — with `now`
        injected, the whole clock is exercisable in milliseconds and without a
        single `sleep`.
        """
        now = self._now()
        held = self._is_paused()
        if self._last_tick_at is not None and not held:
            self._active_s += now - self._last_tick_at
        self._last_tick_at = now
        # A hold's age is measured in WALL time — the whole point is that the
        # meter is not running — and it resets the moment the session resumes.
        if held:
            if self._hold_since is None:
                self._hold_since = now
        else:
            self._hold_since = None
        await self._evaluate(now)

    async def _evaluate(self, now: float) -> None:
        if self._out_of_minutes:
            # Held at zero. Nothing accrues; the only question left is whether
            # the learner is coming back.
            if self._held_at is not None and now - self._held_at >= self._idle_timeout_s:
                await self._idle_end()
            return

        if self._hold_since is not None and now - self._hold_since >= self._hold_idle_timeout_s:
            await self._hold_idle_end()
            return

        remaining = self.remaining_s

        if remaining <= 0:
            await self._hold_at_zero(now)
            return

        await self._maybe_debit()

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

    async def _maybe_debit(self) -> None:
        """Tell the ledger, every `DEBIT_INTERVAL_S` active seconds.

        A worker killed mid-session used to bill nothing at all (audit §4.1).
        The mark moves *before* the call so a slow debit cannot queue a second
        one behind it, and a failure is never retried here: the next interval,
        the zero hold, and the teardown report all send the same cumulative
        number, and the ledger takes only the delta.
        """
        if self._on_debit is None or self._ended:
            return
        if self._active_s - self._last_debit_active_s < self._debit_interval_s:
            return
        self._last_debit_active_s = self._active_s
        try:
            await self._on_debit()
        except Exception:
            logger.warning("periodic debit failed", exc_info=True)

    async def publish_now(self) -> None:
        self._last_publish_at = self._now()
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
        # The zero handler debits, so the periodic reporter owes nothing until
        # another interval of active time has passed after a resume.
        self._last_debit_active_s = self._active_s
        logger.info("out of minutes: holding", extra={"seconds_billed": self.seconds_billed})
        try:
            await self._on_zero()
        except Exception:
            logger.exception("out-of-minutes hold failed")
        await self.publish_now()

    async def _idle_end(self) -> None:
        await self._end("out of minutes: idle timeout, ending the session")

    async def _hold_idle_end(self) -> None:
        """An ordinary hold that outlasted `hold_idle_timeout_s` (audit §3.3).

        The same ending as the abandoned zero hold, deliberately: the client's
        `finish` runs off `tutor.session_over` and the teardown debits the
        seconds actually used, so a learner who paused and left is billed for
        the conversation and not for the pause.
        """
        held_s = 0.0
        if self._hold_since is not None:
            held_s = self._now() - self._hold_since
        await self._end(
            "hold idle timeout, ending the session",
            extra={"held_s": int(held_s), "hold_idle_timeout_s": int(self._hold_idle_timeout_s)},
        )

    async def _end(self, message: str, *, extra: dict | None = None) -> None:
        if self._ended:
            return
        self._ended = True
        logger.info(
            message,
            extra={"seconds_billed": self.seconds_billed, **(extra or {})},
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
    """The ledger seam: what this session owes, reported at teardown.

    The number handed in is this JOB's active seconds; `BillingClient.debit`
    turns it into the ROOM's cumulative total by adding what the room had
    already been billed before this job started. The Convex action is
    idempotent per `<room>:<job_id>:<seq>` and debits only the delta above the
    room's high-water mark, so reporting the same total twice is free and
    reporting a total after a periodic debit charges exactly the difference.

    Retried once, because this is the last chance to bill the session, and
    never raised: a failed debit is a logged fact, not a crash on the way out.
    Once, and no further: a shutdown path that retried until it succeeded would
    hold the worker open on exactly the outage that made it fail. If the
    session is ending *because* the debits stopped landing
    (`billing.MAX_CONSECUTIVE_DEBIT_FAILURES`), both calls here return
    immediately without a request — the accepted under-bill of that session's
    last minutes, which Convex's reconciliation cron closes out.
    """
    logger.info(
        "session seconds billed",
        extra={"user_id": user_id, "seconds": seconds, "room": room},
    )
    if billing is None or not billing.enabled:
        return
    # `final=True` here and nowhere else: it closes the session row on the
    # Convex side. The periodic and zero-hold debits must leave it open, or a
    # purchase could not resume the same conversation.
    if await billing.debit(seconds, final=True) is None:
        await billing.debit(seconds, final=True)
