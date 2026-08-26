"""Checks for the session clock (`src/clock.py`).

The clock is the thing that turns talk into money, and it is pure: every edge
it has to the world — publish, nudge, zero, idle end, debit, and now `now`
itself — is an injected callback. So all of this runs without a real second
passing and without a network.

Run either way:

    uv run pytest tests
    uv run python tests/test_clock.py
"""

from __future__ import annotations

import asyncio
import sys
from collections.abc import Callable
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from clock import SessionClock  # noqa: E402


class FakeTime:
    """A monotonic clock the test moves by hand."""

    def __init__(self, start: float = 1000.0) -> None:
        self.t = start

    def __call__(self) -> float:
        return self.t


class Recorder:
    """Everything the clock said to the outside world, in order."""

    def __init__(self) -> None:
        self.published: list[tuple[int, int, bool]] = []
        # Fires inside `publish`, which is where a pause RPC realistically
        # lands relative to the clock's own transitions.
        self.on_publish: Callable[[], None] | None = None
        self.nudges = 0
        self.zeros = 0
        self.idle_ends = 0
        self.debits: list[int] = []

    async def publish(self, elapsed_s: int, remaining_s: int, out_of_minutes: bool) -> None:
        self.published.append((elapsed_s, remaining_s, out_of_minutes))
        if self.on_publish is not None:
            self.on_publish()

    async def nudge(self) -> None:
        self.nudges += 1

    async def idle_end(self) -> None:
        self.idle_ends += 1


class Harness:
    """A started clock with its task stopped, driven one tick at a time."""

    def __init__(self, clock: SessionClock, time_source: FakeTime, rec: Recorder) -> None:
        self.clock = clock
        self.time = time_source
        self.rec = rec
        self.paused = False

    async def resume(self, balance_s: int) -> bool:
        """What `tutor.resume` does after a purchase: re-budget, then unhold."""
        granted = await self.clock.apply_balance(balance_s)
        if granted:
            self.paused = False
        return granted

    async def advance(self, seconds: float, *, step: float = 1.0) -> None:
        for _ in range(int(seconds / step)):
            self.time.t += step
            await self.clock.tick()


async def build(
    balance_s: int,
    *,
    on_debit: bool = False,
    debit_interval_s: float = 60.0,
    idle_timeout_s: float = 600.0,
) -> Harness:
    rec = Recorder()
    clock_time = FakeTime()
    harness: Harness

    async def debit() -> None:
        rec.debits.append(harness.clock.seconds_billed)

    async def zero() -> None:
        # What the worker does at zero: `hold.apply(True)`, which is a hold like
        # any other. Without it the clock would keep accruing into a held
        # session, so the harness has to do it too.
        rec.zeros += 1
        harness.paused = True

    clock = SessionClock(
        balance_s,
        publish=rec.publish,
        on_nudge=rec.nudge,
        on_zero=zero,
        on_idle_end=rec.idle_end,
        on_debit=debit if on_debit else None,
        is_paused=lambda: harness.paused,
        debit_interval_s=debit_interval_s,
        idle_timeout_s=idle_timeout_s,
        now=clock_time,
    )
    harness = Harness(clock, clock_time, rec)
    await clock.start()
    # The loop task sleeps on real time; the test drives `tick()` itself.
    await clock.aclose()
    return harness


# --- active-seconds accounting -------------------------------------------


async def test_pause_time_is_not_billed() -> None:
    h = await build(600)
    await h.advance(10)
    assert h.clock.seconds_billed == 10

    h.paused = True
    await h.advance(30)
    # Thirty seconds of study cost nothing (decision 2026-08-20).
    assert h.clock.seconds_billed == 10

    h.paused = False
    await h.advance(5)
    assert h.clock.seconds_billed == 15
    assert int(h.clock.remaining_s) == 585


async def test_seconds_billed_never_exceeds_the_budget() -> None:
    h = await build(20)
    await h.advance(60)
    # The clock holds at zero, but even a clock driven past it cannot bill more
    # than the learner had.
    assert h.clock.seconds_billed == 20
    assert h.clock.remaining_s == 0.0


# --- the nudge ------------------------------------------------------------


async def test_nudge_fires_once_at_thirty_seconds_left() -> None:
    h = await build(100)
    await h.advance(69)
    assert h.rec.nudges == 0
    await h.advance(2)
    assert h.rec.nudges == 1
    await h.advance(5)
    # One nudge per budget, never a second.
    assert h.rec.nudges == 1


async def test_nudge_is_deferred_while_paused_and_delivered_on_resume() -> None:
    h = await build(100)
    await h.advance(69)
    # The learner pauses in the window the transition itself opens: the clock
    # publishes the 0:30 state, and the hold lands before the brief goes out.
    h.rec.on_publish = lambda: setattr(h, "paused", True)
    await h.advance(2)
    # The transition happened, but nobody was listening.
    assert h.rec.nudges == 0

    h.paused = False
    await h.clock.notify_resumed()
    assert h.rec.nudges == 1
    # And it is not delivered twice.
    await h.clock.notify_resumed()
    assert h.rec.nudges == 1


async def test_a_fresh_pack_earns_a_fresh_nudge() -> None:
    h = await build(100)
    await h.advance(75)
    assert h.rec.nudges == 1
    assert await h.resume(300)
    await h.advance(200)
    assert h.rec.nudges == 1
    await h.advance(80)
    assert h.rec.nudges == 2


# --- re-budgeting ---------------------------------------------------------


async def test_apply_balance_grows_the_budget_under_the_same_elapsed_time() -> None:
    h = await build(30)
    await h.advance(35)
    assert h.clock.out_of_minutes
    assert h.rec.zeros == 1

    # 300 seconds bought mid-session: the same conversation, 300s more of it.
    assert await h.resume(300)
    assert not h.clock.out_of_minutes
    assert h.clock.seconds_billed == 30
    assert int(h.clock.remaining_s) == 300

    await h.advance(10)
    assert h.clock.seconds_billed == 40
    assert int(h.clock.remaining_s) == 290


async def test_apply_balance_with_nothing_bought_keeps_the_hold() -> None:
    h = await build(30)
    await h.advance(35)
    assert not await h.resume(0)
    assert h.clock.out_of_minutes


# --- zero, and the abandoned hold ----------------------------------------


async def test_zero_holds_the_session_and_the_meter_stops() -> None:
    h = await build(10)
    await h.advance(15)
    assert h.rec.zeros == 1
    assert h.clock.out_of_minutes
    billed = h.clock.seconds_billed
    await h.advance(60)
    # Held: nothing accrues, and zero fires once.
    assert h.clock.seconds_billed == billed
    assert h.rec.zeros == 1
    assert h.rec.published[-1][2] is True


async def test_an_abandoned_hold_ends_the_session() -> None:
    h = await build(10, idle_timeout_s=120.0)
    await h.advance(15)
    assert h.rec.idle_ends == 0
    await h.advance(104)
    assert h.rec.idle_ends == 0
    await h.advance(15)
    assert h.rec.idle_ends == 1
    assert h.clock.ended
    # Ended once, whatever happens next.
    await h.advance(300)
    assert h.rec.idle_ends == 1


# --- the periodic debit ---------------------------------------------------


async def test_periodic_debit_fires_every_interval_of_active_time() -> None:
    h = await build(600, on_debit=True, debit_interval_s=60.0)
    await h.advance(59)
    assert h.rec.debits == []
    await h.advance(2)
    assert h.rec.debits == [60]
    await h.advance(60)
    assert h.rec.debits == [60, 120]


async def test_a_hold_does_not_owe_a_periodic_debit() -> None:
    h = await build(600, on_debit=True, debit_interval_s=60.0)
    await h.advance(30)
    h.paused = True
    await h.advance(300)
    assert h.rec.debits == []
    h.paused = False
    await h.advance(31)
    assert h.rec.debits == [60]


async def test_the_zero_hold_owns_its_own_debit() -> None:
    # The budget runs out mid-interval: the zero handler debits, and the
    # periodic reporter does not fire a second time for the same seconds.
    h = await build(90, on_debit=True, debit_interval_s=60.0)
    await h.advance(95)
    assert h.rec.zeros == 1
    assert h.rec.debits == [60]
    assert await h.resume(300)
    await h.advance(30)
    assert h.rec.debits == [60]
    await h.advance(31)
    assert h.rec.debits == [60, 150]


async def test_a_failing_debit_never_stops_the_clock() -> None:
    rec = Recorder()
    clock_time = FakeTime()

    async def debit() -> None:
        raise RuntimeError("convex is down")

    async def zero() -> None:
        rec.zeros += 1

    clock = SessionClock(
        600,
        publish=rec.publish,
        on_nudge=rec.nudge,
        on_zero=zero,
        on_idle_end=rec.idle_end,
        on_debit=debit,
        is_paused=lambda: False,
        debit_interval_s=60.0,
        now=clock_time,
    )
    await clock.start()
    await clock.aclose()
    for _ in range(130):
        clock_time.t += 1.0
        await clock.tick()
    assert clock.seconds_billed == 130
    assert not clock.ended


def main() -> int:
    checks = [value for name, value in sorted(globals().items()) if name.startswith("test_")]
    failures = 0
    for check in checks:
        try:
            asyncio.run(check())
        except AssertionError as exc:
            failures += 1
            print(f"FAIL {check.__name__}: {exc}")
        else:
            print(f"ok   {check.__name__}")
    print(f"\n{len(checks) - failures}/{len(checks)} checks passed")
    return 1 if failures else 0


if __name__ == "__main__":
    raise SystemExit(main())
