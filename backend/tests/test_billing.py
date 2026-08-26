"""Checks for the ledger seam (`src/billing.py`).

What is actually at stake here is the shape of one JSON body and one piece of
arithmetic — `billed_before + active` — so that is what these check, plus the
two states that decide whether a session may continue: `enabled`, and the
unacknowledged zero-hold debit.

The transport is faked at `_post_json`, which is the last place the payload is
still a dict: everything above it (the ref's ingredients, the cumulative
total, the sequence number) is exercised for real.

Run either way:

    uv run pytest tests
    uv run python tests/test_billing.py
"""

from __future__ import annotations

import asyncio
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from billing import BALANCE_PATH, DEBIT_PATH, BillingClient  # noqa: E402
from clock import report_seconds_billed  # noqa: E402

SITE = "https://example.convex.site"
SECRET = "shhh"


class FakeLedger:
    """Records every call and answers from a scripted queue."""

    def __init__(self, answers: list[object] | None = None) -> None:
        self.calls: list[tuple[str, dict]] = []
        self.answers = answers if answers is not None else []
        self.default: object = {"balanceSeconds": 100}

    async def __call__(self, path: str, payload: dict) -> object | None:
        self.calls.append((path, payload))
        if self.answers:
            return self.answers.pop(0)
        return self.default

    @property
    def debits(self) -> list[dict]:
        return [payload for path, payload in self.calls if path == DEBIT_PATH]


def make(
    ledger: FakeLedger,
    *,
    user_id: str | None = "user_abc",
    site_url: str = SITE,
    secret: str = SECRET,
    job_id: str = "JOB_1",
) -> BillingClient:
    client = BillingClient(
        room="room_xyz",
        user_id=user_id,
        job_id=job_id,
        site_url=site_url,
        secret=secret,
    )
    client._post_json = ledger  # type: ignore[method-assign]
    return client


# --- the gate -------------------------------------------------------------


async def test_no_learner_no_http() -> None:
    ledger = FakeLedger()
    client = make(ledger, user_id=None)
    assert not client.enabled
    assert await client.debit(30) is None
    assert await client.balance() is None
    assert ledger.calls == []


async def test_no_site_url_or_secret_no_http() -> None:
    for kwargs in ({"site_url": ""}, {"secret": ""}):
        ledger = FakeLedger()
        client = make(ledger, **kwargs)  # type: ignore[arg-type]
        assert not client.enabled
        assert await client.debit(30) is None
        assert ledger.calls == []


# --- the payload ----------------------------------------------------------


async def test_the_debit_body_is_the_agreed_shape() -> None:
    ledger = FakeLedger()
    client = make(ledger)
    assert await client.debit(42) == 100
    path, payload = ledger.calls[0]
    assert path == DEBIT_PATH
    assert payload == {
        "room": "room_xyz",
        "userId": "user_abc",
        "jobId": "JOB_1",
        "seconds": 42,
        "seq": 1,
    }
    # `final` is absent unless this is the teardown report.
    assert "final" not in payload


async def test_seconds_are_room_cumulative() -> None:
    ledger = FakeLedger()
    client = make(ledger)
    # This room was already billed 300s by an earlier job (a redispatch after a
    # crash). Everything this job reports sits on top of that, or the ledger's
    # high-water mark would swallow the whole second conversation (audit B3).
    client.set_billed_before(300)
    await client.debit(0)
    await client.debit(60)
    await client.debit(125)
    assert [d["seconds"] for d in ledger.debits] == [300, 360, 425]


async def test_seq_increments_per_call_and_the_job_id_rides_along() -> None:
    ledger = FakeLedger()
    client = make(ledger, job_id="JOB_2")
    for _ in range(3):
        await client.debit(10)
    assert [d["seq"] for d in ledger.debits] == [1, 2, 3]
    assert {d["jobId"] for d in ledger.debits} == {"JOB_2"}


async def test_only_the_teardown_debit_is_final() -> None:
    """`final: true` closes the session row, so only teardown may send it.

    A periodic or zero-hold debit that closed the row would take the learner's
    "buy more and continue this conversation" away from them.
    """
    ledger = FakeLedger()
    client = make(ledger)
    await client.debit(60)
    await client.debit(120, zero_hold=True)
    await report_seconds_billed(client, "user_abc", 120, "room_xyz")
    assert [d.get("final") for d in ledger.debits] == [None, None, True]


async def test_a_runaway_clock_is_clamped_not_rejected() -> None:
    # The ledger bounds `seconds` at 24h; a 400 would cost the whole session.
    ledger = FakeLedger()
    client = make(ledger)
    client.set_billed_before(86_000)
    await client.debit(10_000)
    assert ledger.debits[0]["seconds"] == 86_400


async def test_negative_seconds_are_floored() -> None:
    ledger = FakeLedger()
    client = make(ledger)
    await client.debit(-5)
    assert ledger.debits[0]["seconds"] == 0


# --- the balance read -----------------------------------------------------


async def test_balance_reads_both_numbers() -> None:
    ledger = FakeLedger([{"balanceSeconds": 540, "secondsBilled": 300}])
    client = make(ledger)
    read = await client.balance()
    assert read is not None
    assert read.balance_seconds == 540
    assert read.seconds_billed == 300
    path, payload = ledger.calls[0]
    assert path == BALANCE_PATH
    assert payload == {"userId": "user_abc", "room": "room_xyz"}


async def test_a_room_nobody_has_billed_reads_zero() -> None:
    ledger = FakeLedger([{"balanceSeconds": 600}])
    client = make(ledger)
    read = await client.balance()
    assert read is not None and read.seconds_billed == 0


async def test_junk_answers_are_not_balances() -> None:
    for body in (None, {}, {"balanceSeconds": True}, {"balanceSeconds": "600"}, ["600"]):
        client = make(FakeLedger([body]))
        assert await client.balance() is None


# --- failure, retry, and the zero hold ------------------------------------


async def test_a_failed_debit_returns_none_and_never_raises() -> None:
    ledger = FakeLedger([None])
    client = make(ledger)
    assert await client.debit(30) is None


async def test_the_teardown_report_retries_exactly_once() -> None:
    ledger = FakeLedger([None, {"balanceSeconds": 0}])
    client = make(ledger)
    await report_seconds_billed(client, "user_abc", 120, "room_xyz")
    assert [d["seconds"] for d in ledger.debits] == [120, 120]
    assert [d["seq"] for d in ledger.debits] == [1, 2]


async def test_the_teardown_report_does_not_retry_a_debit_that_landed() -> None:
    ledger = FakeLedger()
    client = make(ledger)
    await report_seconds_billed(client, "user_abc", 120, "room_xyz")
    assert len(ledger.debits) == 1


async def test_a_failed_zero_debit_is_remembered_until_it_lands() -> None:
    ledger = FakeLedger([None])
    client = make(ledger)
    assert not client.zero_debit_unacked

    # The hold at zero could not tell the ledger. Those seconds are still in the
    # balance a resume would re-budget from (audit §3.1.6).
    assert await client.debit(600, zero_hold=True) is None
    assert client.zero_debit_unacked

    # The resume retries it first, and only a success clears the debt.
    ledger.answers = [None]
    assert await client.debit(600, zero_hold=True) is None
    assert client.zero_debit_unacked

    ledger.answers = [{"balanceSeconds": 0}]
    assert await client.debit(600, zero_hold=True) == 0
    assert not client.zero_debit_unacked


async def test_an_ordinary_debit_that_lands_settles_the_zero_debt() -> None:
    # Any successful debit reports a total that covers the missed seconds.
    ledger = FakeLedger([None])
    client = make(ledger)
    await client.debit(600, zero_hold=True)
    assert client.zero_debit_unacked
    ledger.answers = [{"balanceSeconds": 30}]
    assert await client.debit(600) == 30
    assert not client.zero_debit_unacked


async def test_a_failed_ordinary_debit_does_not_invent_a_zero_debt() -> None:
    ledger = FakeLedger([None])
    client = make(ledger)
    assert await client.debit(60) is None
    assert not client.zero_debit_unacked


async def test_debits_are_serialized() -> None:
    """Two debits in flight must not interleave and report out of order."""
    order: list[str] = []

    class SlowLedger(FakeLedger):
        async def __call__(self, path: str, payload: dict) -> object | None:
            order.append(f"enter:{payload['seq']}")
            await asyncio.sleep(0)
            order.append(f"exit:{payload['seq']}")
            return await FakeLedger.__call__(self, path, payload)

    client = make(SlowLedger())
    await asyncio.gather(client.debit(10), client.debit(20))
    assert order == ["enter:1", "exit:1", "enter:2", "exit:2"]


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
