"""Checks for the after-session record (`src/summary.py`).

What is at stake: the transcript that reaches Convex is the conversation and
nothing else (no system prompts, no tool calls, no empty turns), it is the
MOST RECENT turns when a session is long, and the whole seam degrades to
"post what we have" when the `about` model call fails or hangs.

The model and the ledger are both faked; nothing here opens a socket.

Run either way:

    uv run pytest tests
    uv run python tests/test_summary.py
"""

from __future__ import annotations

import asyncio
import sys
from dataclasses import dataclass
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

import summary as summary_module  # noqa: E402
from billing import (  # noqa: E402
    MAX_TRANSCRIPT_TURNS,
    MAX_TURN_CHARS,
    SUMMARY_PATH,
    BillingClient,
)
from config import TutorConfig  # noqa: E402
from state import MAX_RECORDED_CORRECTIONS, SessionFacts  # noqa: E402
from summary import (  # noqa: E402
    about_line,
    report_session_summary,
    transcript_text,
    transcript_turns,
)


@dataclass
class FakeItem:
    role: str
    text_content: str | None
    type: str = "message"
    id: str = "item"


class FakeHistory:
    def __init__(self, items: list[object]) -> None:
        self.items = items


def cfg() -> TutorConfig:
    return TutorConfig(openai_api_key="x")


def conversation(n: int) -> FakeHistory:
    items: list[object] = []
    for i in range(n):
        items.append(FakeItem(role="user", text_content=f"learner {i}"))
        items.append(FakeItem(role="assistant", text_content=f"tutor {i}"))
    return FakeHistory(items)


# --- the transcript -------------------------------------------------------


def test_the_transcript_is_the_conversation_in_order() -> None:
    turns = transcript_turns(conversation(2))
    assert turns == [
        {"role": "learner", "text": "learner 0"},
        {"role": "tutor", "text": "tutor 0"},
        {"role": "learner", "text": "learner 1"},
        {"role": "tutor", "text": "tutor 1"},
    ]


def test_only_conversation_reaches_the_record() -> None:
    history = FakeHistory(
        [
            FakeItem(role="system", text_content="the tutor's standing instructions"),
            FakeItem(role="user", text_content="  hola   ¿qué tal?  "),
            FakeItem(role="assistant", text_content="   "),
            FakeItem(role="assistant", text_content=None),
            FakeItem(role="user", text_content="call", type="function_call"),
            FakeItem(role="assistant", text_content="bien"),
        ]
    )
    assert transcript_turns(history) == [
        {"role": "learner", "text": "hola ¿qué tal?"},
        {"role": "tutor", "text": "bien"},
    ]


def test_a_long_session_keeps_its_most_recent_turns() -> None:
    turns = transcript_turns(conversation(MAX_TRANSCRIPT_TURNS))
    assert len(turns) == MAX_TRANSCRIPT_TURNS
    # The last turn of the conversation is the last turn of the record.
    assert turns[-1] == {"role": "tutor", "text": f"tutor {MAX_TRANSCRIPT_TURNS - 1}"}


def test_a_long_turn_is_cut_not_dropped() -> None:
    history = FakeHistory([FakeItem(role="user", text_content="x" * (MAX_TURN_CHARS + 500))])
    (turn,) = transcript_turns(history)
    assert len(turn["text"]) == MAX_TURN_CHARS


def test_a_history_that_is_not_one_yields_nothing() -> None:
    assert transcript_turns(None) == []
    assert transcript_turns(FakeHistory([])) == []


def test_the_about_input_is_truncated_from_the_front() -> None:
    turns = [{"role": "learner", "text": f"turn {i}"} for i in range(50)]
    text = transcript_text(turns, max_chars=40)
    assert len(text) == 40
    assert text.endswith("learner: turn 49")


# --- the about line -------------------------------------------------------


class FakeResponses:
    def __init__(self, outcome: object) -> None:
        self.outcome = outcome
        self.kwargs: dict = {}

    async def create(self, **kwargs: object) -> object:
        self.kwargs = kwargs
        if isinstance(self.outcome, Exception):
            raise self.outcome
        return self.outcome


class FakeClient:
    def __init__(self, outcome: object) -> None:
        self.responses = FakeResponses(outcome)
        self.closed = False

    async def close(self) -> None:
        self.closed = True


@dataclass
class FakeResponse:
    output_text: str
    usage: object | None = None


@dataclass
class FakeUsage:
    input_tokens: int
    output_tokens: int


TURNS = [
    {"role": "learner", "text": "quiero pedir un café"},
    {"role": "tutor", "text": "claro, ¿con leche?"},
]


async def test_the_about_line_is_collapsed_and_returned() -> None:
    client = FakeClient(FakeResponse(output_text="  Ordering coffee\n  and paying.  "))
    line = await about_line(cfg(), TURNS, client=client)  # type: ignore[arg-type]
    assert line == "Ordering coffee and paying."
    # Cheap model, no thinking: this is a shutdown path.
    assert client.responses.kwargs["reasoning"] == {"effort": "none"}
    # A caller-owned client is not closed under the caller.
    assert not client.closed


async def test_nothing_to_say_is_no_line() -> None:
    for answer in ("NONE", "none.", "", "   "):
        client = FakeClient(FakeResponse(output_text=answer))
        assert await about_line(cfg(), TURNS, client=client) is None  # type: ignore[arg-type]


async def test_one_turn_is_not_a_conversation() -> None:
    client = FakeClient(FakeResponse(output_text="should never be asked for"))
    assert await about_line(cfg(), TURNS[:1], client=client) is None  # type: ignore[arg-type]
    assert client.responses.kwargs == {}


async def test_a_failed_about_call_is_no_line_never_a_raise() -> None:
    client = FakeClient(RuntimeError("the model is down"))
    assert await about_line(cfg(), TURNS, client=client) is None  # type: ignore[arg-type]


async def test_a_hung_about_call_gives_up() -> None:
    class Hanging(FakeClient):
        async def _never(self, **kwargs: object) -> object:
            await asyncio.sleep(3600)

    client = Hanging(FakeResponse(output_text=""))
    client.responses.create = client._never  # type: ignore[method-assign]
    original = summary_module.ABOUT_TIMEOUT_S
    summary_module.ABOUT_TIMEOUT_S = 0.01
    try:
        assert await about_line(cfg(), TURNS, client=client) is None  # type: ignore[arg-type]
    finally:
        summary_module.ABOUT_TIMEOUT_S = original


async def test_the_about_call_is_counted_into_usage() -> None:
    from usage import UsageTracker

    usage = UsageTracker()
    client = FakeClient(
        FakeResponse(output_text="Ordering coffee.", usage=FakeUsage(1200, 30)),
    )
    await about_line(cfg(), TURNS, usage=usage, client=client)  # type: ignore[arg-type]
    line = usage.summary(active_s=60, room="room_xyz")
    assert line["aux_text_in_tokens"] == 1200
    assert line["aux_text_out_tokens"] == 30
    assert line["est_cost_usd"] > 0


# --- the corrections the tab would otherwise take with it ----------------


def a_correction(index: int) -> dict[str, str]:
    return {
        "id": f"c_{index}",
        "original": "yo es",
        "replacement": "yo soy",
        "category": "agreement",
        "severity": "error",
        "explanation": "  first   person\nof ser  ",
    }


def test_facts_keep_the_corrections_they_count() -> None:
    facts = SessionFacts()
    facts.record_corrections([a_correction(1), a_correction(2)])
    assert facts.turns_with_corrections == 1
    assert [c["id"] for c in facts.corrections] == ["c_1", "c_2"]
    # Whitespace-collapsed on the way in, like every other string that travels.
    assert facts.corrections[0]["explanation"] == "first person of ser"
    # Exactly the six fields Convex stores.
    assert set(facts.corrections[0]) == {
        "id",
        "original",
        "replacement",
        "category",
        "severity",
        "explanation",
    }


def test_facts_keep_only_the_most_recent_corrections() -> None:
    facts = SessionFacts()
    facts.record_corrections([a_correction(i) for i in range(MAX_RECORDED_CORRECTIONS + 5)])
    assert len(facts.corrections) == MAX_RECORDED_CORRECTIONS
    assert facts.corrections[-1]["id"] == f"c_{MAX_RECORDED_CORRECTIONS + 4}"


def test_a_correction_the_ui_could_not_render_is_not_recorded() -> None:
    facts = SessionFacts()
    facts.record_corrections([{"category": "tense", "original": "", "replacement": "fui"}])
    # It still counts as evidence for the brief; it is not a record.
    assert facts.corrections_by_category["tense"] == 1
    assert facts.corrections == []


# --- the whole seam ------------------------------------------------------


class FakeReview:
    def __init__(self, material: dict | None) -> None:
        self._material = material

    def snapshot(self) -> dict | None:
        return self._material


class Ledger:
    def __init__(self) -> None:
        self.calls: list[tuple[str, dict]] = []

    async def __call__(self, path: str, payload: dict) -> object:
        self.calls.append((path, payload))
        return {"ok": True}


def billing_client(ledger: Ledger, *, user_id: str | None = "user_abc") -> BillingClient:
    client = BillingClient(
        room="room_xyz",
        user_id=user_id,
        job_id="JOB_1",
        site_url="https://example.convex.site",
        machine_key="ak_test_not_a_real_key",
    )
    client._post_json = ledger  # type: ignore[method-assign]
    return client


async def with_stub_about(line: str | None, coro_factory) -> object:
    """Run something with the `about` model call stubbed out."""
    original = summary_module.about_line

    async def _stub(*args: object, **kwargs: object) -> str | None:
        return line

    summary_module.about_line = _stub  # type: ignore[assignment]
    try:
        return await coro_factory()
    finally:
        summary_module.about_line = original  # type: ignore[assignment]


async def test_the_record_carries_everything_the_worker_knows() -> None:
    ledger = Ledger()
    billing = billing_client(ledger)
    facts = SessionFacts()
    facts.record_corrections([a_correction(1)])
    review = FakeReview({"vocab": [{"target": "el café", "anchor": "the coffee"}]})

    sent = await with_stub_about(
        "Ordering coffee and paying.",
        lambda: report_session_summary(
            cfg(),
            history=conversation(3),
            billing=billing,
            review=review,  # type: ignore[arg-type]
            facts=facts,
        ),
    )
    assert sent is True
    (path, body) = ledger.calls[0]
    assert path == SUMMARY_PATH
    assert body["about"] == "Ordering coffee and paying."
    assert len(body["transcript"]) == 6
    assert body["review"]["vocab"] == [{"target": "el café", "anchor": "the coffee"}]
    # Convex requires all three review keys when review travels at all.
    assert body["review"]["phrases"] == [] and body["review"]["tables"] == []
    assert [c["id"] for c in body["corrections"]] == ["c_1"]


async def test_a_record_survives_everything_optional_going_missing() -> None:
    ledger = Ledger()
    billing = billing_client(ledger)
    sent = await with_stub_about(
        None,
        lambda: report_session_summary(
            cfg(),
            history=conversation(1),
            billing=billing,
            review=FakeReview(None),  # type: ignore[arg-type]
            facts=None,
        ),
    )
    assert sent is True
    (_, body) = ledger.calls[0]
    assert "about" not in body and "review" not in body and "corrections" not in body
    assert len(body["transcript"]) == 2


async def test_an_unmetered_session_posts_nothing_and_spends_no_model_call() -> None:
    ledger = Ledger()
    billing = billing_client(ledger, user_id=None)
    facts = SessionFacts()
    facts.record_corrections([a_correction(1)])
    sent = await report_session_summary(
        cfg(), history=conversation(3), billing=billing, facts=facts
    )
    assert sent is False
    assert ledger.calls == []


def main() -> int:
    checks = [value for name, value in sorted(globals().items()) if name.startswith("test_")]
    failures = 0
    for check in checks:
        try:
            result = check()
            if asyncio.iscoroutine(result):
                asyncio.run(result)
        except AssertionError as exc:
            failures += 1
            print(f"FAIL {check.__name__}: {exc}")
        else:
            print(f"ok   {check.__name__}")
    print(f"\n{len(checks) - failures}/{len(checks)} checks passed")
    return 1 if failures else 0


if __name__ == "__main__":
    raise SystemExit(main())
