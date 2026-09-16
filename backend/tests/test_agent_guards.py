"""The worker's guard paths: the refusals, the silent tutor, and the logs.

What is at stake, all of it from the 2026-09-14 launch checklist:

- **A1.** A tutor that never speaks ENDS the session. Publishing `tutor_silent`
  and returning left the lease renewing every 60 s against a room with no
  conversation in it, and the learner could not start another one until the tab
  closed and the three-minute lease lapsed.
- **A2.** Every fail-closed refusal reaches the learner. `no user_id`,
  `ledger unreachable` and a per-job `TutorConfig.from_env()` failure used to be
  a bare `ctx.shutdown()`: a room the agent never joined, indistinguishable
  from a dispatch that never landed.
- **A12.** Ids only, never transcript or free text, at INFO.
- **C5.** `_open_ledger`'s four branches, and the zero-balance resume.
- **C6.** Select-to-translate is capped per session, like Ask.

Everything is faked: no room, no socket, no ledger, no model.

Run either way:

    uv run pytest tests
    uv run python tests/test_agent_guards.py
"""

from __future__ import annotations

import asyncio
import json
import logging
import sys
from pathlib import Path
from typing import Any

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

import agent as agent_module  # noqa: E402
import translate as translate_module  # noqa: E402
from agent import (  # noqa: E402
    TutorAgent,
    _meter_from_first_tutor_audio,
    _open_ledger,
    _register_pause_rpc,
    _renew_lease,
)
from clock import SessionClock  # noqa: E402
from config import (  # noqa: E402
    ATTR_ERROR,
    ATTR_SESSION_OVER,
    ERROR_CONFIG_FAULT,
    ERROR_LEDGER_UNREACHABLE,
    ERROR_NO_LEARNER,
    ERROR_TUTOR_SILENT,
    TutorConfig,
)
from goal import GoalKeeper  # noqa: E402
from plan import JobMetadata, SessionPlan  # noqa: E402
from state import SessionFacts, SessionGoal, SessionState  # noqa: E402
from translate import MAX_LOOKUPS_PER_SESSION, SpanTranslator, register_translate_rpc  # noqa: E402

# --- fakes ----------------------------------------------------------------


class FakeParticipant:
    def __init__(self) -> None:
        self.attributes: dict[str, str] = {}
        self.rpcs: dict[str, Any] = {}

    async def set_attributes(self, values: dict[str, str]) -> None:
        self.attributes.update(values)

    def register_rpc_method(self, name: str, fn: Any) -> None:
        self.rpcs[name] = fn


class FakeRoom:
    def __init__(self, name: str = "lesson-test-1-abc") -> None:
        self.name = name
        self.local_participant = FakeParticipant()
        self.remote_participants: dict[str, Any] = {}


class FakeJob:
    def __init__(self, metadata: str = "{}") -> None:
        self.id = "AJ_test"
        self.metadata = metadata


class FakeCtx:
    """Just enough `JobContext` for the guard paths."""

    def __init__(self, metadata: str = "{}") -> None:
        self.room = FakeRoom()
        self.job = FakeJob(metadata)
        self.connected = False
        self.shutdown_reason: str | None = None
        self.shutdowns = 0
        self._callbacks: list[Any] = []

    async def connect(self) -> None:
        self.connected = True

    def add_shutdown_callback(self, fn: Any) -> None:
        self._callbacks.append(fn)

    def shutdown(self, reason: str = "") -> None:
        # The framework runs the shutdown callbacks; this mirrors that, which
        # is what makes "the lease stops renewing" observable in a test.
        self.shutdowns += 1
        self.shutdown_reason = reason
        for fn in self._callbacks:
            asyncio.get_event_loop().create_task(fn())

    @property
    def published_error(self) -> str | None:
        return self.room.local_participant.attributes.get(ATTR_ERROR)


class FakeSession:
    def __init__(self) -> None:
        self.handlers: dict[str, Any] = {}
        self.interrupted = 0
        self.closed = 0
        self.replies: list[str] = []
        self._input = FakeAudioIO()
        self._output = FakeAudioIO()

    def on(self, event: str, fn: Any) -> None:
        self.handlers[event] = fn

    async def interrupt(self) -> None:
        self.interrupted += 1

    async def aclose(self) -> None:
        self.closed += 1

    def generate_reply(self, instructions: str = "") -> None:
        self.replies.append(instructions)

    @property
    def input(self) -> FakeAudioIO:
        return self._input

    @property
    def output(self) -> FakeAudioIO:
        return self._output


class FakeAudioIO:
    """`session.input` / `session.output`: only the one switch the worker flips."""

    def __init__(self) -> None:
        self.audio_enabled: bool | None = None
        self.history: list[bool] = []

    def set_audio_enabled(self, enabled: bool) -> None:
        self.audio_enabled = enabled
        self.history.append(enabled)


class FakeOpenResult:
    def __init__(self, ok: bool, code: str = "", balance: int = 0, billed: int = 0) -> None:
        self.ok = ok
        self.code = code
        self.balance_seconds = balance
        self.seconds_billed = billed


class FakeBilling:
    """A `BillingClient` with the ledger taken out of it."""

    def __init__(self, *, enabled: bool = True, opened: FakeOpenResult | None = None) -> None:
        self.enabled = enabled
        self._opened = opened
        self.billed_before: int | None = None
        self.end_reason: str | None = None
        self.end_reason_weak: bool | None = None
        self.renews = 0
        self.debits: list[int] = []
        self.zero_debit_unacked = False
        self.closed = False

    async def open(self, _plan: dict[str, object]) -> FakeOpenResult | None:
        return self._opened

    def set_billed_before(self, seconds: int) -> None:
        self.billed_before = seconds

    def set_end_reason(self, reason: str, weak: bool = False) -> None:
        if weak and self.end_reason is not None:
            return
        self.end_reason = reason
        self.end_reason_weak = weak

    async def renew(self) -> Any:
        self.renews += 1
        return FakeOpenResult(True)

    async def debit(self, seconds: int, **_kw: Any) -> int | None:
        self.debits.append(seconds)
        return 0

    async def balance(self) -> Any:
        return None

    async def aclose(self) -> None:
        self.closed = True


class FakeRpcData:
    def __init__(self, payload: str = "{}") -> None:
        self.payload = payload


def cfg(**kw: Any) -> TutorConfig:
    return TutorConfig(openai_api_key="x", **kw)


def run(coro: Any) -> Any:
    return asyncio.run(coro)


# --- A1: a tutor that never speaks ends the session -----------------------


def test_a_silent_tutor_ends_the_session_and_stops_the_lease() -> None:
    """A1. The watchdog must END, not just announce.

    Publishing `tutor_silent` and returning left `_renew_lease` holding the
    room for as long as the tab stayed open, so the learner could not start
    another conversation. The watchdog now goes through `_end_session`, whose
    `ctx.shutdown()` runs the teardown that cancels the renewal.
    """

    async def scenario() -> tuple[FakeCtx, FakeBilling, FakeSession, int]:
        ctx = FakeCtx()
        session = FakeSession()
        billing = FakeBilling()
        state = SessionState()
        clock = SessionClock(
            600,
            publish=lambda *_a: asyncio.sleep(0),
            on_nudge=lambda: asyncio.sleep(0),
            on_zero=lambda: asyncio.sleep(0),
            on_idle_end=lambda: asyncio.sleep(0),
            is_paused=lambda: False,
        )

        # The lease, wired exactly as the entrypoint wires it: a background
        # renewal task that the shutdown callback cancels.
        renew = asyncio.create_task(_renew_lease(ctx, billing))  # type: ignore[arg-type]

        async def _teardown() -> None:
            renew.cancel()

        ctx.add_shutdown_callback(_teardown)

        _meter_from_first_tutor_audio(ctx, session, clock, state, billing)  # type: ignore[arg-type]
        # No `agent_state_changed` → `"speaking"` ever fires: the tutor never
        # spoke. Let the watchdog's window elapse.
        await asyncio.sleep(0.3)
        renewed = billing.renews
        await asyncio.sleep(0.15)
        assert billing.renews == renewed, "the lease is still renewing after the session ended"
        renew.cancel()
        return ctx, billing, session, renewed

    original_timeout = agent_module.FIRST_AUDIO_TIMEOUT_S
    original_renew = agent_module.LEASE_RENEW_S
    agent_module.FIRST_AUDIO_TIMEOUT_S = 0.05
    agent_module.LEASE_RENEW_S = 0.02
    try:
        ctx, billing, session, renewed = run(scenario())
    finally:
        agent_module.FIRST_AUDIO_TIMEOUT_S = original_timeout
        agent_module.LEASE_RENEW_S = original_renew

    # The learner is told, and told before the stage goes away.
    assert ctx.published_error == ERROR_TUTOR_SILENT
    assert ctx.room.local_participant.attributes[ATTR_SESSION_OVER] == "true"
    # The session really ended, through the ordinary path.
    assert session.closed == 1
    assert ctx.shutdowns == 1
    # And the final debit will say why — not weakly, this IS the ending.
    assert billing.end_reason == "tutor_silent"
    assert billing.end_reason_weak is False
    # The lease was live before the watchdog fired, and stopped after.
    assert renewed > 0


def test_a_hold_does_not_count_against_the_silent_tutor_budget() -> None:
    """A learner who pauses during a cold start is not evidence of a dead tutor.

    The watchdog spends a budget of UNHELD seconds: held time does not count
    (live, 2026-09-15 — a 20 s wall clock ended a session that was held for
    part of it and whose tutor was still connecting).
    """

    async def scenario() -> tuple[FakeCtx, FakeSession]:
        ctx = FakeCtx()
        session = FakeSession()
        state = SessionState()
        clock = SessionClock(
            600,
            publish=lambda *_a: asyncio.sleep(0),
            on_nudge=lambda: asyncio.sleep(0),
            on_zero=lambda: asyncio.sleep(0),
            on_idle_end=lambda: asyncio.sleep(0),
            is_paused=lambda: state.clock_held,
        )
        _meter_from_first_tutor_audio(ctx, session, clock, state, None)  # type: ignore[arg-type]
        # Held for longer than the whole budget: nothing must end.
        state.paused = True
        await asyncio.sleep(0.3)
        assert ctx.shutdowns == 0, "the watchdog counted held time"
        # Released: the budget resumes, and only now runs out.
        state.paused = False
        await asyncio.sleep(0.3)
        return ctx, session

    original = agent_module.FIRST_AUDIO_TIMEOUT_S
    agent_module.FIRST_AUDIO_TIMEOUT_S = 0.1
    try:
        ctx, session = run(scenario())
    finally:
        agent_module.FIRST_AUDIO_TIMEOUT_S = original

    assert ctx.published_error == ERROR_TUTOR_SILENT
    assert ctx.shutdowns == 1


def test_a_permanent_hold_releases_the_watchdog() -> None:
    """A model that died is an ending with its own teardown, not a silent
    tutor: the watchdog steps aside instead of waiting behind a hold that
    never releases (CodeRabbit, 2026-09-15)."""

    async def scenario() -> tuple[FakeCtx, bool]:
        ctx = FakeCtx()
        session = FakeSession()
        state = SessionState()
        clock = SessionClock(
            600,
            publish=lambda *_a: asyncio.sleep(0),
            on_nudge=lambda: asyncio.sleep(0),
            on_zero=lambda: asyncio.sleep(0),
            on_idle_end=lambda: asyncio.sleep(0),
            is_paused=lambda: state.clock_held,
        )
        _meter_from_first_tutor_audio(ctx, session, clock, state, None)  # type: ignore[arg-type]
        state.model_failed = True
        await asyncio.sleep(0.2)
        pending = [t for t in asyncio.all_tasks() if t.get_name() == "tutor-first-audio-watchdog"]
        return ctx, len(pending) == 0

    original = agent_module.FIRST_AUDIO_TIMEOUT_S
    agent_module.FIRST_AUDIO_TIMEOUT_S = 0.1
    try:
        ctx, released = run(scenario())
    finally:
        agent_module.FIRST_AUDIO_TIMEOUT_S = original

    assert released, "the watchdog is still waiting behind a permanent hold"
    assert ctx.shutdowns == 0
    assert ctx.published_error is None


def test_the_mic_is_closed_until_the_tutor_has_spoken() -> None:
    """Nothing the learner says before the first tutor audio is a turn.

    The input is closed at the start and opened on the first "speaking"
    state — the same event that starts the clock — so the transcriber cannot
    make a turn out of room noise ahead of the greeting (live, 2026-09-15).
    """
    ctx = FakeCtx()
    session = FakeSession()
    state = SessionState()
    clock = SessionClock(
        600,
        publish=lambda *_a: asyncio.sleep(0),
        on_nudge=lambda: asyncio.sleep(0),
        on_zero=lambda: asyncio.sleep(0),
        on_idle_end=lambda: asyncio.sleep(0),
        is_paused=lambda: False,
    )

    async def scenario() -> None:
        _meter_from_first_tutor_audio(ctx, session, clock, state, None)  # type: ignore[arg-type]
        assert session.input.audio_enabled is False
        # Model ready, still nothing said: still closed.
        session.handlers["agent_state_changed"](type("Ev", (), {"new_state": "listening"})())
        assert session.input.audio_enabled is False
        # The first word: open.
        session.handlers["agent_state_changed"](type("Ev", (), {"new_state": "speaking"})())
        await asyncio.sleep(0)
        assert session.input.audio_enabled is True
        assert state.tutor_spoken is True

    original = agent_module.FIRST_AUDIO_TIMEOUT_S
    agent_module.FIRST_AUDIO_TIMEOUT_S = 5.0
    try:
        run(scenario())
    finally:
        agent_module.FIRST_AUDIO_TIMEOUT_S = original


def test_first_audio_cancels_the_watchdog() -> None:
    """The other half: a tutor that DOES speak ends nothing."""

    async def scenario() -> tuple[FakeCtx, FakeSession]:
        ctx = FakeCtx()
        session = FakeSession()
        state = SessionState()
        started: list[bool] = []

        class TinyClock:
            started_flag = False

            @property
            def started(self) -> bool:
                return self.started_flag

            async def start(self) -> None:
                self.started_flag = True
                started.append(True)

        clock = TinyClock()
        _meter_from_first_tutor_audio(ctx, session, clock, state, FakeBilling())  # type: ignore[arg-type]

        class Ev:
            new_state = "speaking"

        session.handlers["agent_state_changed"](Ev())
        await asyncio.sleep(0.25)
        assert started == [True]
        return ctx, session

    original = agent_module.FIRST_AUDIO_TIMEOUT_S
    agent_module.FIRST_AUDIO_TIMEOUT_S = 0.05
    try:
        ctx, session = run(scenario())
    finally:
        agent_module.FIRST_AUDIO_TIMEOUT_S = original

    assert ctx.published_error is None
    assert ctx.shutdowns == 0
    assert session.closed == 0


# --- A2 + C5: `_open_ledger`'s four branches ------------------------------


def test_no_learner_in_production_refuses_and_tells_the_learner() -> None:
    """A2 + C5. The refusal is published, not silent."""
    ctx = FakeCtx()
    billing = FakeBilling(enabled=False)
    budget = run(_open_ledger(ctx, cfg(), JobMetadata(balance_s=600), billing))  # type: ignore[arg-type]

    assert budget is None
    assert ctx.connected, "the room must be joined or the attribute reaches nobody"
    assert ctx.published_error == ERROR_NO_LEARNER
    assert ctx.shutdowns == 1


def test_no_learner_with_the_development_flag_runs_unmetered() -> None:
    """C5. The CLI escape hatch still works, and bills nothing."""
    ctx = FakeCtx()
    billing = FakeBilling(enabled=False)
    budget = run(
        _open_ledger(ctx, cfg(allow_unmetered=True), JobMetadata(balance_s=600), billing)  # type: ignore[arg-type]
    )

    assert budget == 600
    assert ctx.shutdowns == 0
    assert ctx.published_error is None


def test_an_unreachable_ledger_refuses_and_tells_the_learner() -> None:
    """A2 + C5. `CONVEX_SITE_URL` unset in production is a visible error."""
    ctx = FakeCtx()
    billing = FakeBilling(enabled=False)
    meta = JobMetadata(balance_s=600, user_id="user_2abc")
    budget = run(_open_ledger(ctx, cfg(), meta, billing))  # type: ignore[arg-type]

    assert budget is None
    assert ctx.connected
    assert ctx.published_error == ERROR_LEDGER_UNREACHABLE
    assert ctx.shutdowns == 1


def test_a_failed_open_call_refuses_the_same_way() -> None:
    """C5. The ledger is configured but the call did not land."""
    ctx = FakeCtx()
    billing = FakeBilling(enabled=True, opened=None)
    meta = JobMetadata(balance_s=600, user_id="user_2abc")
    budget = run(_open_ledger(ctx, cfg(), meta, billing))  # type: ignore[arg-type]

    assert budget is None
    assert ctx.published_error == ERROR_LEDGER_UNREACHABLE


def test_a_normal_open_returns_the_ledgers_balance() -> None:
    """C5. The happy path: the ledger's balance beats the dispatched one."""
    ctx = FakeCtx()
    billing = FakeBilling(enabled=True, opened=FakeOpenResult(True, balance=1234, billed=60))
    meta = JobMetadata(balance_s=600, user_id="user_2abc")
    budget = run(_open_ledger(ctx, cfg(), meta, billing))  # type: ignore[arg-type]

    assert budget == 1234
    assert billing.billed_before == 60
    assert ctx.shutdowns == 0
    assert ctx.published_error is None


def test_a_ledger_refusal_is_published_as_its_own_code() -> None:
    """C5. `open_session` / `closed` / `rate_limited` still ride their own codes."""
    ctx = FakeCtx()
    billing = FakeBilling(enabled=True, opened=FakeOpenResult(False, code="open_session"))
    meta = JobMetadata(balance_s=600, user_id="user_2abc")
    budget = run(_open_ledger(ctx, cfg(), meta, billing))  # type: ignore[arg-type]

    assert budget is None
    assert ctx.published_error == "open_session"


def test_a_broken_config_tells_the_learner_instead_of_never_joining() -> None:
    """A2. A bad `OPENAI_API_KEY` in production is a card, not a frozen stage."""
    ctx = FakeCtx()

    def boom() -> TutorConfig:
        raise RuntimeError("OPENAI_API_KEY is empty.")

    original = agent_module.TutorConfig.from_env
    agent_module.TutorConfig.from_env = staticmethod(boom)  # type: ignore[assignment]
    try:
        run(agent_module.tutor(ctx))  # type: ignore[arg-type]
    finally:
        agent_module.TutorConfig.from_env = original  # type: ignore[assignment]

    assert ctx.connected
    assert ctx.published_error == ERROR_CONFIG_FAULT
    assert ctx.shutdowns == 1


def test_a_resume_at_zero_with_no_balance_stays_held() -> None:
    """C5. The mid-session-purchase seam, refusing when nothing was bought.

    Testable without a live room: the zero branch answers before it touches the
    hold or the session at all.
    """
    ctx = FakeCtx()
    session = FakeSession()
    state = SessionState()
    facts = SessionFacts()
    billing = FakeBilling()
    clock = SessionClock(
        0,
        publish=lambda *_a: asyncio.sleep(0),
        on_nudge=lambda: asyncio.sleep(0),
        on_zero=lambda: asyncio.sleep(0),
        on_idle_end=lambda: asyncio.sleep(0),
        is_paused=lambda: True,
    )
    # The state the zero hold leaves behind. Set directly: driving the clock to
    # zero would take a whole session's wall time.
    clock._out_of_minutes = True

    class FakeHold:
        applied: list[bool] = []

        async def apply(self, paused: bool) -> bool:
            self.applied.append(paused)
            return True

    hold = FakeHold()

    async def scenario() -> str:
        await _register_pause_rpc(ctx, session, state, facts, cfg(), clock, hold, billing)  # type: ignore[arg-type]
        resume = ctx.room.local_participant.rpcs["tutor.resume"]
        return await resume(FakeRpcData("{}"))

    answer = json.loads(run(scenario()))
    assert answer == {"paused": True, "resumed": False, "out_of_minutes": True}
    assert hold.applied == [], "a refused resume must not release the hold"
    assert session.replies == [], "and must not put the tutor back on the clock"


# --- A12: ids only, never transcript or free text at INFO -----------------

SECRET = "quiero hablar del fin de semana pasado en Sevilla"


def _info_blob(records: list[logging.LogRecord]) -> str:
    """Everything an INFO record could carry a transcript in."""
    parts: list[str] = []
    for record in records:
        if record.levelno < logging.INFO:
            continue
        parts.append(record.getMessage())
        parts.extend(str(value) for value in record.__dict__.values())
    return "\n".join(parts)


def test_a_turn_dropped_before_the_first_audio_logs_no_transcript(
    caplog: Any,
) -> None:
    """A12. `agent.py`'s turn log used to carry the first 80 chars verbatim."""
    from livekit.agents import StopResponse, llm

    room = FakeRoom()
    state = SessionState()
    state.tutor_spoken = False
    tutor_agent = TutorAgent(cfg(), None, state, room, plan=None, goals=None)  # type: ignore[arg-type]
    message = llm.ChatMessage(role="user", content=[SECRET])

    async def scenario() -> None:
        with caplog.at_level(logging.DEBUG, logger="tutor.agent"):
            try:
                await tutor_agent.on_user_turn_completed(llm.ChatContext.empty(), message)
            except StopResponse:
                pass

    run(scenario())

    records = list(caplog.records)
    assert any(r.getMessage().startswith("dropping a learner turn") for r in records)
    assert SECRET not in _info_blob(records)
    # The length is what a triage actually needs, and it is there.
    assert any(getattr(r, "chars", None) == len(SECRET) for r in records)


def test_the_goal_tool_logs_its_size_and_not_its_words(caplog: Any) -> None:
    """A12. The tool's arguments are the learner's own words."""
    room = FakeRoom()
    state = SessionState()
    tutor_agent = TutorAgent(cfg(), None, state, room, plan=None, goals=None)  # type: ignore[arg-type]

    async def scenario() -> None:
        with caplog.at_level(logging.INFO, logger="tutor.agent"):
            await tutor_agent.set_session_goal(SECRET, ["el pretérito"], "they said so")

    run(scenario())
    assert SECRET not in _info_blob(list(caplog.records))
    assert "they said so" not in _info_blob(list(caplog.records))


def test_the_goal_never_reaches_an_info_log(caplog: Any) -> None:
    """A12. `goal.py`'s "session goal set" carried the whole line."""
    facts = SessionFacts()
    state = SessionState()
    room = FakeRoom()
    keeper = GoalKeeper(cfg(), facts, state, room, plan=None)  # type: ignore[arg-type]

    async def scenario() -> None:
        with caplog.at_level(logging.INFO, logger="tutor.goal"):
            await keeper.adopt(SessionGoal.make(SECRET, ["el pretérito"], source="tool"))

    run(scenario())
    records = list(caplog.records)
    assert any(r.getMessage() == "session goal set" for r in records)
    assert SECRET not in _info_blob(records)


def test_the_plans_prose_is_debug_only() -> None:
    """A12. `plan.log_fields()` is the shape; `debug_fields()` is the prose."""
    plan = SessionPlan(
        topic=SECRET,
        scenario="ordering at a restaurant",
        focus_note="the preterite",
        note="my sister lives there",
        tenses=("preterite",),
        vocab=("food",),
        level="early intermediate",
    )
    info = repr(plan.log_fields())
    assert SECRET not in info
    assert "ordering at a restaurant" not in info
    assert "my sister lives there" not in info
    # Still useful: how much plan there was, and at what level.
    assert plan.log_fields()["plan_present"] is True
    assert plan.log_fields()["plan_tenses"] == 1
    # The level is free text on the wire, so only one of ours is logged as
    # itself; anything else — "early intermediate" here, or a sentence — is
    # "other" (CodeRabbit, PR #12).
    assert plan.log_fields()["plan_level"] == "other"
    assert "early intermediate" not in info
    assert SessionPlan(level="beginner").log_fields()["plan_level"] == "beginner"
    assert SessionPlan().log_fields()["plan_level"] is None
    # The prose is still reachable, at DEBUG.
    assert SECRET in repr(plan.debug_fields())


def test_the_goals_prose_is_debug_only() -> None:
    """A12, the other half of the same rule."""
    goal = SessionGoal.make(SECRET, ["el pretérito"], source="tool", confirmed=True)
    assert goal is not None
    assert SECRET not in repr(goal.log_fields())
    assert goal.log_fields()["goal_chars"] == len(SECRET)
    assert SECRET in repr(goal.debug_fields())


def test_scrub_fields_reaches_into_nested_values() -> None:
    """A11/A12. A nested bag is scrubbed at every depth (CodeRabbit, PR #12)."""
    from observability import scrub_fields

    fields = {
        "room": "room-1",
        "transcript": SECRET,
        "context": {"transcript": SECRET, "seq": 3, "plan_topic": SECRET},
        "turns": [{"text": SECRET, "chars": 12}, SECRET],
    }
    scrubbed = scrub_fields(fields)
    assert scrubbed["room"] == "room-1"
    assert "transcript" not in scrubbed
    assert scrubbed["context"] == {"seq": 3}
    # A bare string in a list has no key to judge it by; the key above it does.
    assert scrubbed["turns"][0] == {"chars": 12}


# --- C6: the select-to-translate cap --------------------------------------


def test_translate_is_capped_per_session_like_ask() -> None:
    """C6. Past the cap, no model call goes out and the overlay is told."""
    ctx = FakeCtx()
    session = FakeSession()
    translator = SpanTranslator(cfg())
    calls: list[str] = []

    async def fake_translate(*, text: str, speaker: str, context: Any) -> str:
        calls.append(text)
        translator._record(text, "the translation")
        return "the translation"

    translator.translate = fake_translate  # type: ignore[assignment]

    async def scenario() -> list[dict[str, Any]]:
        await register_translate_rpc(ctx, session, translator)  # type: ignore[arg-type]
        rpc = ctx.room.local_participant.rpcs["tutor.translate"]
        answers = []
        for index in range(MAX_LOOKUPS_PER_SESSION + 3):
            payload = json.dumps({"text": f"palabra {index}", "speaker": "learner"})
            answers.append(json.loads(await rpc(FakeRpcData(payload))))
        return answers

    # `recent_context` reads a real chat history; an empty one is enough.
    from livekit.agents import llm

    session.history = llm.ChatContext.empty()  # type: ignore[attr-defined]

    answers = run(scenario())

    assert len(calls) == MAX_LOOKUPS_PER_SESSION, "the cap is before the model call"
    assert all("translation" in a for a in answers[:MAX_LOOKUPS_PER_SESSION])
    for refused in answers[MAX_LOOKUPS_PER_SESSION:]:
        assert refused == {"error": translate_module.LIMIT_LINE}


def test_a_failed_translation_does_not_spend_one_of_the_cap() -> None:
    """C6, Ask's rule: only a real answer counts."""
    translator = SpanTranslator(cfg())
    assert translator.translated == 0
    assert not translator.at_limit
    # `_record` is the only thing that counts, and only a non-empty
    # translation reaches it.
    translator._record("una palabra", "a word")
    assert translator.translated == 1


if __name__ == "__main__":  # pragma: no cover
    import pytest

    raise SystemExit(pytest.main([__file__, "-q"]))
