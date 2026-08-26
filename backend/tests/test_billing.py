"""Checks for the ledger seam (`src/billing.py`).

What is actually at stake here is the shape of one JSON body and one piece of
arithmetic — `billed_before + active` — so that is what these check, plus the
two states that decide whether a session may continue: `enabled`, and the
unacknowledged zero-hold debit.

The transport is faked at two depths. Most checks stub `_post_json`, the last
place the payload is still a dict, so everything above it (the ref's
ingredients, the cumulative total, the sequence number, the failure ceiling) is
exercised for real. The auth checks stub one layer lower — the aiohttp session
itself — because what is at stake there is which URL, which body and which
bearer actually go out.

Run either way:

    uv run pytest tests
    uv run python tests/test_billing.py
"""

from __future__ import annotations

import asyncio
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from billing import (  # noqa: E402
    BALANCE_PATH,
    CLERK_API_URL_DEFAULT,
    DEBIT_PATH,
    MAX_ABOUT_CHARS,
    MAX_BODY_BYTES,
    MAX_CONSECUTIVE_DEBIT_FAILURES,
    MAX_CORRECTIONS,
    MAX_REVIEW_TABLES,
    MAX_REVIEW_VOCAB,
    MAX_TRANSCRIPT_TURNS,
    MAX_TURN_CHARS,
    MINT_PATH,
    SUMMARY_PATH,
    TOKEN_TTL_S,
    BillingClient,
)
from clock import report_seconds_billed  # noqa: E402

SITE = "https://example.convex.site"
# Shaped like a real Clerk machine secret key, and just as fictional.
MACHINE_KEY = "ak_test_not_a_real_key"


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
    machine_key: str = MACHINE_KEY,
    job_id: str = "JOB_1",
) -> BillingClient:
    client = BillingClient(
        room="room_xyz",
        user_id=user_id,
        job_id=job_id,
        site_url=site_url,
        machine_key=machine_key,
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


async def test_no_site_url_or_machine_key_no_http() -> None:
    for kwargs in ({"site_url": ""}, {"machine_key": ""}):
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


# --- the after-session record (phase 7 step 2) ---------------------------


def _summaries(ledger: FakeLedger) -> list[dict]:
    return [payload for path, payload in ledger.calls if path == SUMMARY_PATH]


REVIEW = {
    "vocab": [{"target": "el café", "anchor": "the coffee"}],
    "phrases": [{"target": "¿me cobras?", "anchor": "can I pay?"}],
    "tables": [{"verb": "ser", "tense": "Present", "rows": [{"person": "yo", "form": "soy"}]}],
}

CORRECTION = {
    "id": "c_1",
    "original": "yo es",
    "replacement": "yo soy",
    "category": "agreement",
    "severity": "error",
    "explanation": "first person of ser",
}


async def test_summary_carries_the_room_the_learner_and_the_job() -> None:
    ledger = FakeLedger([{"ok": True}])
    client = make(ledger)
    turns = [{"role": "learner", "text": "hola"}, {"role": "tutor", "text": "buenas"}]
    assert await client.summary(
        about="ordering coffee",
        transcript=turns,
        review=REVIEW,
        corrections=[CORRECTION],
    )
    (body,) = _summaries(ledger)
    assert body["room"] == "room_xyz"
    assert body["userId"] == "user_abc"
    assert body["jobId"] == "JOB_1"
    assert body["about"] == "ordering coffee"
    assert body["transcript"] == turns
    assert body["review"] == REVIEW
    assert body["corrections"] == [CORRECTION]


async def test_summary_omits_what_it_does_not_have() -> None:
    ledger = FakeLedger([{"ok": True}])
    client = make(ledger)
    assert await client.summary(transcript=[{"role": "tutor", "text": "hola"}])
    (body,) = _summaries(ledger)
    assert "about" not in body
    assert "review" not in body
    assert "corrections" not in body


async def test_a_summary_with_nothing_in_it_is_not_sent() -> None:
    ledger = FakeLedger()
    client = make(ledger)
    assert await client.summary() is False
    assert await client.summary(about="", transcript=[], review=None, corrections=[]) is False
    # A review with three empty lists is not a review.
    assert await client.summary(review={"vocab": [], "phrases": [], "tables": []}) is False
    assert ledger.calls == []


async def test_no_learner_no_summary() -> None:
    ledger = FakeLedger()
    client = make(ledger, user_id=None)
    assert await client.summary(about="anything") is False
    assert ledger.calls == []


async def test_summary_bounds_every_string_it_sends() -> None:
    ledger = FakeLedger([{"ok": True}])
    client = make(ledger)
    turns = [{"role": "learner", "text": "x" * (MAX_TURN_CHARS + 200)}] * (
        MAX_TRANSCRIPT_TURNS + 40
    )
    await client.summary(about="  a\n\n  long   " + "y" * 400, transcript=turns)
    (body,) = _summaries(ledger)
    assert len(body["about"]) == MAX_ABOUT_CHARS
    assert "\n" not in body["about"]
    assert len(body["transcript"]) == MAX_TRANSCRIPT_TURNS
    assert all(len(t["text"]) == MAX_TURN_CHARS for t in body["transcript"])


async def test_summary_keeps_the_most_recent_turns() -> None:
    ledger = FakeLedger([{"ok": True}])
    client = make(ledger)
    turns = [{"role": "learner", "text": f"turn {i}"} for i in range(MAX_TRANSCRIPT_TURNS + 5)]
    await client.summary(transcript=turns)
    (body,) = _summaries(ledger)
    assert body["transcript"][0]["text"] == "turn 5"
    assert body["transcript"][-1]["text"] == f"turn {MAX_TRANSCRIPT_TURNS + 4}"


async def test_summary_drops_unrenderable_turns() -> None:
    ledger = FakeLedger([{"ok": True}])
    client = make(ledger)
    await client.summary(
        transcript=[
            {"role": "learner", "text": "kept"},
            {"role": "narrator", "text": "not a speaker"},
            {"role": "tutor", "text": "   "},
            {"role": "tutor"},
            "not a turn",
        ]
    )
    (body,) = _summaries(ledger)
    assert body["transcript"] == [{"role": "learner", "text": "kept"}]


async def test_an_oversized_body_sheds_the_review_then_the_transcript() -> None:
    ledger = FakeLedger([{"ok": True}])
    client = make(ledger)
    turns = [{"role": "learner", "text": "x" * MAX_TURN_CHARS}] * MAX_TRANSCRIPT_TURNS
    huge = {"tables": ["y" * 1000] * 300}
    await client.summary(about="about the thing", transcript=turns, review=huge)
    (body,) = _summaries(ledger)
    assert "review" not in body
    assert body["about"] == "about the thing"
    assert len(json.dumps(body).encode("utf-8")) <= MAX_BODY_BYTES


async def test_a_refused_summary_is_a_returned_false_never_a_raise() -> None:
    ledger = FakeLedger([None, {"ok": False}, {"balanceSeconds": 3}])
    client = make(ledger)
    assert await client.summary(about="a") is False
    assert await client.summary(about="a") is False
    assert await client.summary(about="a") is False


async def test_the_summary_serializes_with_the_debits() -> None:
    """Same lock: a summary must never land between a debit and its sequence."""
    order: list[str] = []

    class SlowLedger(FakeLedger):
        async def __call__(self, path: str, payload: dict) -> object | None:
            order.append(f"enter:{path}")
            await asyncio.sleep(0)
            order.append(f"exit:{path}")
            return {"ok": True} if path == SUMMARY_PATH else {"balanceSeconds": 1}

    client = make(SlowLedger())
    await asyncio.gather(client.debit(10, final=True), client.summary(about="a"))
    assert order == [
        f"enter:{DEBIT_PATH}",
        f"exit:{DEBIT_PATH}",
        f"enter:{SUMMARY_PATH}",
        f"exit:{SUMMARY_PATH}",
    ]


async def test_the_review_snapshot_is_bounded_to_what_the_ledger_takes() -> None:
    """The engine can build twelve tables; the ledger takes eight (`SUMMARY_LIMITS`)."""
    ledger = FakeLedger([{"ok": True}])
    client = make(ledger)
    table = {
        "verb": "ser",
        "tense": "Present",
        "rows": [{"person": f"p{i}", "form": f"f{i}"} for i in range(20)],
    }
    await client.summary(
        review={
            "vocab": [{"target": f"t{i}", "anchor": f"a{i}"} for i in range(MAX_REVIEW_VOCAB + 10)],
            "phrases": [],
            "tables": [table] * 12,
        }
    )
    (body,) = _summaries(ledger)
    assert len(body["review"]["vocab"]) == MAX_REVIEW_VOCAB
    assert len(body["review"]["tables"]) == MAX_REVIEW_TABLES
    assert len(body["review"]["tables"][0]["rows"]) == 12
    # All three keys travel, always: Convex requires them when review is sent.
    assert body["review"]["phrases"] == []


async def test_a_review_of_the_wrong_shape_is_simply_not_sent() -> None:
    ledger = FakeLedger([{"ok": True}])
    client = make(ledger)
    await client.summary(about="a", review={"vocab": "not a list", "tables": 3})
    (body,) = _summaries(ledger)
    assert "review" not in body


async def test_corrections_carry_the_six_fields_and_nothing_else() -> None:
    ledger = FakeLedger([{"ok": True}])
    client = make(ledger)
    await client.summary(corrections=[{**CORRECTION, "turnId": "t_1", "extra": 3}])
    (body,) = _summaries(ledger)
    assert body["corrections"] == [CORRECTION]


async def test_corrections_are_bounded_and_the_unrenderable_are_dropped() -> None:
    ledger = FakeLedger([{"ok": True}])
    client = make(ledger)
    findings = [dict(CORRECTION, id=f"c_{i}") for i in range(MAX_CORRECTIONS + 7)]
    findings.append({**CORRECTION, "id": "c_bad", "replacement": ""})
    findings.append({"id": "c_worse"})
    await client.summary(corrections=findings)
    (body,) = _summaries(ledger)
    assert len(body["corrections"]) == MAX_CORRECTIONS
    # The most recent survive, and the two unrenderable ones never counted.
    assert body["corrections"][-1]["id"] == f"c_{MAX_CORRECTIONS + 6}"


async def test_a_long_explanation_is_cut_not_dropped() -> None:
    ledger = FakeLedger([{"ok": True}])
    client = make(ledger)
    await client.summary(corrections=[{**CORRECTION, "explanation": "x" * 900}])
    (body,) = _summaries(ledger)
    assert len(body["corrections"][0]["explanation"]) == 500


# --- auth: minting, the bearer, and the one re-mint a 401 buys -------------


class FakeResponse:
    def __init__(self, status: int, body: object) -> None:
        self.status = status
        self._body = body

    async def __aenter__(self) -> FakeResponse:
        if isinstance(self._body, Exception):
            raise self._body
        return self

    async def __aexit__(self, *exc: object) -> bool:
        return False

    async def json(self) -> object:
        return self._body

    async def text(self) -> str:
        return self._body if isinstance(self._body, str) else json.dumps(self._body)


class FakeHTTP:
    """Stands in for the aiohttp session: records requests, answers a script."""

    def __init__(self, script: list[tuple[int, object]]) -> None:
        self.script = script
        self.requests: list[dict] = []

    def post(
        self, url: str, *, json: object = None, headers: dict | None = None, **_: object
    ) -> FakeResponse:
        self.requests.append({"url": url, "body": json, "headers": headers or {}})
        status, body = self.script.pop(0) if self.script else (200, {"balanceSeconds": 100})
        return FakeResponse(status, body)

    def bearers(self, path: str) -> list[str | None]:
        return [r["headers"].get("Authorization") for r in self.requests if r["url"].endswith(path)]

    def count(self, path: str) -> int:
        return len([r for r in self.requests if r["url"].endswith(path)])


def wired(script: list[tuple[int, object]], **kwargs: str) -> tuple[BillingClient, FakeHTTP]:
    """A client whose transport is faked one layer below `_post_json`."""
    client = BillingClient(
        room="room_xyz",
        user_id="user_abc",
        job_id="JOB_1",
        site_url=SITE,
        machine_key=MACHINE_KEY,
        **kwargs,
    )
    http = FakeHTTP(script)
    client._client = lambda: http  # type: ignore[method-assign,assignment,return-value]
    return client, http


MINTED = (201, {"token": "jwt_one"})
REMINTED = (201, {"token": "jwt_two"})
BALANCE_OK = (200, {"balanceSeconds": 100})


async def test_the_mint_request_is_the_agreed_shape() -> None:
    client, http = wired([MINTED, BALANCE_OK])
    assert await client.debit(30) == 100
    mint, debit = http.requests
    assert mint["url"] == f"{CLERK_API_URL_DEFAULT}{MINT_PATH}"
    assert mint["body"] == {"token_format": "jwt", "seconds_until_expiration": TOKEN_TTL_S}
    # The machine key goes to Clerk and to nowhere else.
    assert mint["headers"]["Authorization"] == f"Bearer {MACHINE_KEY}"
    assert debit["url"] == f"{SITE}{DEBIT_PATH}"
    assert debit["headers"]["Authorization"] == "Bearer jwt_one"


async def test_clerk_api_url_is_overridable() -> None:
    client, http = wired([MINTED, BALANCE_OK], clerk_api_url="https://clerk.example.test/")
    await client.debit(30)
    assert http.requests[0]["url"] == f"https://clerk.example.test{MINT_PATH}"


async def test_one_token_serves_the_whole_job() -> None:
    client, http = wired([MINTED, BALANCE_OK, BALANCE_OK, BALANCE_OK])
    for _ in range(3):
        await client.debit(30)
    assert http.count(MINT_PATH) == 1
    assert http.bearers(DEBIT_PATH) == ["Bearer jwt_one"] * 3


async def test_a_401_re_mints_once_and_retries_the_call() -> None:
    """An expired JWT under a long session is the ordinary case, not a fault."""
    client, http = wired([MINTED, (401, {}), REMINTED, (200, {"balanceSeconds": 50})])
    assert await client.debit(30) == 50
    assert http.bearers(DEBIT_PATH) == ["Bearer jwt_one", "Bearer jwt_two"]
    assert http.count(MINT_PATH) == 2
    # A call that landed on the retry is not a failure.
    assert client.consecutive_failures == 0


async def test_a_failed_re_mint_after_a_401_counts_as_a_failure() -> None:
    client, http = wired([MINTED, (401, {}), (500, "clerk is down")])
    assert await client.debit(30) is None
    assert client.consecutive_failures == 1
    # No second attempt at the ledger with a token that does not exist.
    assert http.count(DEBIT_PATH) == 1


async def test_a_401_on_the_retry_is_a_failure_not_a_second_re_mint() -> None:
    """A fresh token the ledger still refuses is configuration, not expiry."""
    client, http = wired([MINTED, (401, {}), REMINTED, (401, {})])
    assert await client.debit(30) is None
    assert http.count(MINT_PATH) == 2
    assert http.count(DEBIT_PATH) == 2
    assert client.consecutive_failures == 1


async def test_a_400_is_counted_and_never_retried() -> None:
    """Convex's per-call cap: one report may add at most 3600s to the room's
    total. Re-sending the same body would only be refused again."""
    client, http = wired([MINTED, (400, "delta 7200 exceeds the 3600s per-call cap")])
    assert await client.debit(7200) is None
    assert http.count(DEBIT_PATH) == 1
    assert http.count(MINT_PATH) == 1
    assert client.consecutive_failures == 1


async def test_a_mint_that_answers_no_token_is_a_failed_call() -> None:
    client, http = wired([(201, {"object": "machine_to_machine_token"})])
    assert await client.debit(30) is None
    assert http.count(DEBIT_PATH) == 0
    assert client.consecutive_failures == 1


async def test_a_transport_exception_is_a_failure_not_a_raise() -> None:
    client, _http = wired([MINTED, (0, TimeoutError("convex hung"))])
    assert await client.debit(30) is None
    assert client.consecutive_failures == 1


# --- the failure ceiling --------------------------------------------------


async def test_a_success_resets_the_failure_count() -> None:
    ledger = FakeLedger([None, None, None, {"balanceSeconds": 10}, None])
    client = make(ledger)
    for _ in range(3):
        await client.debit(60)
    assert client.consecutive_failures == 3
    assert await client.debit(60) == 10
    assert client.consecutive_failures == 0
    await client.debit(60)
    assert client.consecutive_failures == 1
    assert not client.ceiling_reached


async def test_five_consecutive_failures_end_the_session_exactly_once() -> None:
    ends: list[str] = []

    async def on_ceiling() -> None:
        ends.append("ended")

    ledger = FakeLedger([None] * 10)
    client = make(ledger)
    client.set_ceiling_handler(on_ceiling)

    for _ in range(MAX_CONSECUTIVE_DEBIT_FAILURES):
        assert await client.debit(60) is None
    assert client.ceiling_reached
    assert ends == ["ended"]
    assert len(ledger.debits) == MAX_CONSECUTIVE_DEBIT_FAILURES

    # No sixth attempt, ever — that is the whole point of the ceiling.
    assert await client.debit(120) is None
    assert len(ledger.debits) == MAX_CONSECUTIVE_DEBIT_FAILURES
    assert ends == ["ended"]


async def test_the_teardown_debit_after_the_ceiling_makes_no_request() -> None:
    """The accepted under-bill (Yash, 2026-08-25): the last minutes of a session
    whose ledger died never bill, and the Convex cron closes the row. Neither
    the teardown debit nor its single retry goes out."""
    ledger = FakeLedger([None] * 10)
    client = make(ledger)
    for _ in range(MAX_CONSECUTIVE_DEBIT_FAILURES):
        await client.debit(60)
    before = len(ledger.debits)
    await report_seconds_billed(client, "user_abc", 600, "room_xyz")
    assert len(ledger.debits) == before


async def test_the_ceiling_handler_runs_outside_the_debit_lock() -> None:
    """It ends the session, whose teardown debits — a held lock would deadlock."""
    ledger = FakeLedger([None] * 10)
    client = make(ledger)

    async def on_ceiling() -> None:
        # Exactly what the teardown does, from inside the handler.
        await asyncio.wait_for(report_seconds_billed(client, "user_abc", 60, "room_xyz"), 1.0)

    client.set_ceiling_handler(on_ceiling)
    for _ in range(MAX_CONSECUTIVE_DEBIT_FAILURES):
        await client.debit(60)
    assert client.ceiling_reached


async def test_a_failing_ceiling_handler_never_raises_into_the_session() -> None:
    async def on_ceiling() -> None:
        raise RuntimeError("the session was already gone")

    client = make(FakeLedger([None] * 10))
    client.set_ceiling_handler(on_ceiling)
    for _ in range(MAX_CONSECUTIVE_DEBIT_FAILURES):
        assert await client.debit(60) is None
    assert client.ceiling_reached


async def test_a_failed_balance_read_never_counts_toward_the_ceiling() -> None:
    """The only balance read that can fail into a running session is the one at
    job start, and that already refuses the job (`agent._open_ledger`)."""
    client = make(FakeLedger([None] * 10))
    for _ in range(MAX_CONSECUTIVE_DEBIT_FAILURES + 2):
        assert await client.balance() is None
    assert client.consecutive_failures == 0
    assert not client.ceiling_reached


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
