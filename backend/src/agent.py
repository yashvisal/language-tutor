"""LiveKit Agents worker for the language tutor.

Pipeline (see plans/phases/phase-2-live-pipeline.md and phase-3):

    GPT Realtime (speech-to-speech)    -> the tutor's voice
  + parallel STT (gpt-live-transcribe) -> live target-language transcripts
  + LiveKit semantic turn detector     -> the ONE turn clock for everything
  + on_user_turn_completed             -> background analyzer -> corrections
  + tutor.translate RPC                -> select-to-translate, on demand

Run with `lk agent dev`.
"""

from __future__ import annotations

import asyncio
import json
import logging
import random
import sys
import time
from collections.abc import Coroutine
from dataclasses import dataclass
from typing import Any

from dotenv import load_dotenv
from livekit import agents, rtc
from livekit.agents import (
    Agent,
    AgentServer,
    AgentSession,
    CloseEvent,
    CloseReason,
    ErrorEvent,
    JobContext,
    StopResponse,
    TurnHandlingOptions,
    inference,
    llm,
    room_io,
    utils,
)
from livekit.plugins import openai

from analyzer import CorrectionAnalyzer, recent_context
from ask import AskCoach, register_ask_rpc
from billing import BillingClient
from clock import SessionClock, report_seconds_billed
from config import (
    AGENT_NAME,
    ANALYZER_OFF,
    ANALYZER_ON,
    ATTR_ANALYZER,
    ATTR_ELAPSED_S,
    ATTR_ERROR,
    ATTR_FALSE,
    ATTR_OUT_OF_MINUTES,
    ATTR_PAUSED,
    ATTR_REMAINING_S,
    ATTR_SESSION_OVER,
    ATTR_TRUE,
    ATTR_TURN_SEQ,
    ERROR_MODEL,
    ERROR_NONE,
    ERROR_TUTOR_SILENT,
    RPC_PAUSE,
    RPC_RESUME,
    TutorConfig,
)
from plan import JobMetadata, SessionPlan
from prompts import (
    BRIDGE_INTENTS,
    greeting_instructions,
    nudge_instructions,
    resume_instructions,
    stt_prompt,
    tutor_instructions,
)
from review import ReviewMaterial, register_review_rpc
from state import SessionFacts, SessionState
from summary import SUMMARY_BUDGET_S, report_session_summary
from translate import SpanTranslator, register_translate_rpc
from usage import UsageTracker

load_dotenv(".env.local")

logger = logging.getLogger("tutor.agent")

# The pause surface's tabs, wire value -> how the brief names it. Must match the
# `tab` union in `frontend/lib/session/protocol.ts`.
STUDY_TABS = {"transcript": "Transcript", "review": "Review", "ask": "Ask"}

# The shortest interval between two balance re-reads on a session held at zero.
BALANCE_RECHECK_MIN_S = 5.0

# How long the worker waits for a learner whose participant left the room before
# it gives the job up (audit B4). The clock is held for the whole grace, so the
# wait is free to the learner; a reconnect inside it resumes the same
# conversation in the same room.
DISCONNECT_GRACE_S = 60.0

# How long after the session starts we will wait for the tutor's first audio
# frame before saying so at error level. Nothing is billed in the meantime —
# the clock does not start until that frame plays — so this is an alarm, not a
# timeout: it is the "the tutor never spoke" case, and it is invisible without
# it (audit B4b, B6).
FIRST_AUDIO_TIMEOUT_S = 20.0

# How many of a hold's questions ride back on the resume payload, and how long
# each may be. Mirrors `MAX_RESUME_ASKS` in the frontend's protocol module; the
# cap is re-applied here because this is untrusted input on its way to a prompt.
MAX_RESUME_ASKS = 5
MAX_ASK_CHARS = 200


# Work in flight. Fire-and-forget tasks are garbage collected unless something
# holds a reference to them, so they are parked here until they end. Module
# level on purpose: several of these outlive the entrypoint's frame (the
# entrypoint returns as soon as the session is wired; the job runs on).
_background_tasks: set[asyncio.Task[None]] = set()


def _spawn(coro: Coroutine[Any, Any, None], name: str) -> asyncio.Task[None]:
    task = asyncio.create_task(coro, name=name)
    _background_tasks.add(task)
    task.add_done_callback(_background_tasks.discard)
    return task


def _publish_turn_commit(room: rtc.Room, state: SessionState) -> None:
    """Announce that a learner turn just committed, as a monotonic counter.

    WHY: the frontend has no other signal for that moment. The STT emits a
    segment per VAD-bounded phrase, so one conversational turn arrives as
    several segments, and only the turn detector here knows which of them was
    the last. The UI closes the learner's bubble when this number rises; before
    it existed the UI waited for the analyzer's answer instead, which lands
    ~2s late, so a learner who started their next sentence inside that window
    saw it appended to the previous bubble (live, 2026-08-23).

    Fire-and-forget: publishing must never sit in front of a reply or a hold.
    A dropped publish costs one merged bubble, never a stalled session.
    """
    state.turn_seq += 1
    seq = state.turn_seq

    async def _publish() -> None:
        try:
            await room.local_participant.set_attributes({ATTR_TURN_SEQ: str(seq)})
        except Exception:
            logger.warning("failed to publish turn seq %d", seq, exc_info=True)

    _spawn(_publish(), "tutor-turn-seq")


class TutorAgent(Agent):
    """The conversation partner. Analysis happens beside it, never inside it."""

    def __init__(
        self,
        cfg: TutorConfig,
        analyzer: CorrectionAnalyzer | None,
        state: SessionState,
        room: rtc.Room,
        plan: SessionPlan | None = None,
    ) -> None:
        super().__init__(instructions=tutor_instructions(cfg, plan))
        self._cfg = cfg
        self._analyzer = analyzer
        self._state = state
        self._room = room

    # The analyzer trigger. Fires with the full committed turn because turn
    # detection happens agent-side — with model-owned turn detection this node
    # never runs (the reason Grok support was dropped; see config.py).
    async def on_user_turn_completed(
        self, turn_ctx: llm.ChatContext, new_message: llm.ChatMessage
    ) -> None:
        # The turn is committed — tell the UI so it can close the learner's
        # bubble. BEFORE the hold branch below: a turn that commits during a
        # hold is still a committed turn, and the StopResponse it raises only
        # suppresses the tutor's reply.
        _publish_turn_commit(self._room, self._state)

        text = (new_message.text_content or "").strip()
        if text and self._analyzer is not None:
            self._analyzer.analyze_in_background(
                turn_id=new_message.id,
                text=text,
                context=recent_context(turn_ctx, exclude_id=new_message.id),
            )

        # A turn already in flight when the learner paused (STT finals lag the
        # audio) still commits DURING the hold. Replying now would speak into a
        # muted session and dump ghost text on resume (found live 2026-08-12) —
        # suppress the reply, and mark it owed so the conversational re-entry
        # answers this turn when the learner returns.
        if self._state.paused:
            self._state.reply_was_pending = True
            # The utterance they were mid-way through at pause time has now
            # committed — the "learner keeps the floor" veto no longer applies,
            # or the owed answer above would be suppressed on resume.
            self._state.learner_was_speaking = False
            raise StopResponse()


server = AgentServer()


@server.rtc_session(agent_name=AGENT_NAME)
async def tutor(ctx: JobContext) -> None:
    cfg = TutorConfig.from_env()
    meta = JobMetadata.parse(ctx.job.metadata)
    state = SessionState()
    facts = SessionFacts()
    # Assigned once the session exists; the shutdown callback below is
    # registered before that and reads it late, on purpose.
    clock: SessionClock | None = None

    logger.info(
        "starting tutor session",
        extra={
            "realtime_model": cfg.realtime_model,
            "target_lang": cfg.target_lang,
            "anchor_lang": cfg.anchor_lang,
            "balance_s": meta.balance_s,
            "user_id": meta.user_id,
            "job_id": ctx.job.id,
            "room": ctx.room.name,
            **meta.plan.log_fields(),
        },
    )

    # The ledger's client. The job id rides in every debit's ref, which is what
    # keeps a redispatch of this room from replaying the first job's refs.
    billing = BillingClient(room=ctx.room.name, user_id=meta.user_id, job_id=ctx.job.id)

    # Metering is fail-closed, and this is the gate (audit B10). It also
    # produces the budget: a balance read here is fresher and more trustworthy
    # than the number the token route signed into dispatch metadata minutes ago.
    budget_s = await _open_ledger(ctx, cfg, meta, billing)
    if budget_s is None:
        await billing.aclose()
        return

    session: AgentSession = AgentSession(
        llm=cfg.build_realtime_model(),
        # Parallel STT owns every transcript the UI shows. Both languages are
        # listed because code-switching is expected in a tutoring session.
        stt=openai.STT(
            model=cfg.stt_model,
            language=[cfg.target_lang, cfg.anchor_lang],
            prompt=stt_prompt(cfg),
        ),
        # ONE turn clock: the semantic turn detector owns endpointing for the
        # model's replies, the transcript segmentation, and the analyzer
        # trigger alike.
        turn_handling=TurnHandlingOptions(
            turn_detection=inference.TurnDetector(),
            # min_delay must outlast the STT flush lag or late transcripts
            # double-commit the turn and interrupt the reply (see TutorConfig).
            endpointing={
                "min_delay": cfg.min_endpointing_s,
                "max_delay": cfg.max_endpointing_s,
            },
            # Plain VAD, not the adaptive detector: the learner speaking is the
            # interruption, every time. The ML detector guesses whether
            # overlapping speech is "real" and, when it guesses wrong, resumes
            # the tutor over the learner — three times in one session (live,
            # 2026-08-22), which is the one thing this product promises never
            # happens. A real interruption that VAD misses costs far less than
            # a tutor that talks over someone.
            interruption={"mode": "vad"},
        ),
    )

    analyzer = CorrectionAnalyzer(cfg, ctx.room, facts, meta.plan) if cfg.analyzer_enabled else None
    translator = SpanTranslator(cfg)
    # The study surface (phase 4, WS4c). Both are text-only and run while the
    # session is held, which is exactly when the voice model costs nothing.
    coach = AskCoach(cfg, meta.plan, facts)
    review = ReviewMaterial(cfg, meta.plan)
    usage = UsageTracker()
    session.on("session_usage_updated", usage.on_usage)

    async def _shutdown() -> None:
        # Every step is guarded and independent: one failing teardown must not
        # strand the ones behind it.
        if clock is not None:
            try:
                await clock.aclose()
            except Exception:
                logger.warning("clock shutdown failed", exc_info=True)
            try:
                # However the session ended — the idle timeout on an
                # out-of-minutes hold, the learner leaving, or a crash — this is
                # the cumulative number the ledger settles against.
                await report_seconds_billed(
                    billing, meta.user_id, clock.seconds_billed, ctx.room.name
                )
            except Exception:
                logger.warning("billing report failed", exc_info=True)
            try:
                # The after-session record (phase 7 step 2): what this was
                # about, the transcript, the Review material and the
                # corrections — the things that used to die with the tab. Order-independent with the
                # debit above; bounded so a hung model cannot hold a shutdown.
                await asyncio.wait_for(
                    report_session_summary(
                        cfg,
                        history=session.history,
                        billing=billing,
                        review=review,
                        facts=facts,
                        usage=usage,
                    ),
                    timeout=SUMMARY_BUDGET_S,
                )
            except Exception:
                logger.warning("session summary failed", exc_info=True)
            try:
                # What it cost us, for pricing decisions: tokens, talk share,
                # estimated dollars. Logged, never billed.
                usage.log_summary(active_s=clock.seconds_billed, room=ctx.room.name)
            except Exception:
                logger.warning("usage summary failed", exc_info=True)
        try:
            await billing.aclose()
        except Exception:
            logger.warning("billing client shutdown failed", exc_info=True)
        try:
            await translator.aclose()
        except Exception:
            logger.warning("translator shutdown failed", exc_info=True)
        try:
            await coach.aclose()
        except Exception:
            logger.warning("ask shutdown failed", exc_info=True)
        try:
            await review.aclose()
        except Exception:
            logger.warning("review shutdown failed", exc_info=True)
        if analyzer is not None:
            try:
                await analyzer.aclose()
            except Exception:
                logger.warning("analyzer shutdown failed", exc_info=True)

    ctx.add_shutdown_callback(_shutdown)

    await session.start(
        agent=TutorAgent(cfg, analyzer, state, ctx.room, meta.plan),
        room=ctx.room,
        room_options=room_io.RoomOptions(
            # Text input is off: this is a voice surface, not a chat box.
            text_input=False,
        ),
    )

    # One hold, two sources: the learner's pause RPC and the clock at zero
    # balance. Both go through this object so the two feel identical on screen.
    hold = SessionHold(ctx, session, state, analyzer)
    clock = _build_clock(ctx, cfg, session, state, budget_s, hold, billing)

    # The learner leaving the room is the second thing that holds the meter.
    _watch_learner_presence(ctx, state, clock, billing)
    # The model dying is the third, and the only one that ends the session
    # rather than waiting for it to come back (audit §4.2).
    _watch_session_errors(ctx, session, state, clock, billing)

    await _register_pause_rpc(ctx, session, state, facts, cfg, clock, hold, billing)
    await register_translate_rpc(ctx, session, translator)
    await register_ask_rpc(ctx, session, coach)
    await register_review_rpc(ctx, review)

    # Warm the translate client off the critical path: the first RPC otherwise
    # pays TLS + CA-bundle setup on the learner's first card. Same for the
    # coach's client, whose first question is a learner sitting on a spinner.
    translator.warm_in_background()
    coach.warm_in_background()
    # The Review tab's material is made once per session and never changes, so
    # it is made NOW rather than on the first open — by the time anyone pauses
    # to study, it is already sitting there.
    review.generate_in_background()

    # Tell the frontend whether corrections are coming at all, so it can skip
    # the analyzing phase entirely when the analyzer is off.
    await ctx.room.local_participant.set_attributes(
        {
            ATTR_ANALYZER: ANALYZER_ON if cfg.analyzer_enabled else ANALYZER_OFF,
            ATTR_SESSION_OVER: ATTR_FALSE,
            # Explicitly empty: "nothing has gone wrong", published up front so
            # a client that joins late never has to guess.
            ATTR_ERROR: ERROR_NONE,
        }
    )

    # The clock starts with the tutor's VOICE, not with the request for it: a
    # session where the model never speaks used to be billed from the moment
    # the greeting was asked for (audit B4b). The greeting is still requested
    # here, first, so the learner's first metered second is a second of
    # tutoring.
    session.generate_reply(instructions=greeting_instructions(cfg, meta.plan))
    _meter_from_first_tutor_audio(ctx, session, clock)


async def _open_ledger(
    ctx: JobContext,
    cfg: TutorConfig,
    meta: JobMetadata,
    billing: BillingClient,
) -> int | None:
    """Open the money seam, or refuse the job. Returns the clock's budget.

    Fail-closed (audit B10). Metering used to fail *open*: one unset variable
    and `BillingClient.enabled` was False, every ledger call returned silently,
    and every learner talked for free with nothing to notice it. So a job that
    carries a learner id and cannot reach the ledger is now refused —
    `TUTOR_ALLOW_UNMETERED=1` is the local-development escape hatch, and it says
    so on every session.

    A job with no learner id is a different thing entirely: that is the worker
    run straight from the CLI, with no token route in front of it, and it keeps
    running on the dispatched budget exactly as before.

    The successful path is also where the budget comes from: the balance read
    here is fresher than the one the token route signed into dispatch metadata,
    and `seconds_billed` seeds the room-cumulative total (audit B3). It is also
    what mints the job's M2M token, since it is the job's first ledger call.

    This read is deliberately outside the debit failure ceiling
    (`billing.MAX_CONSECUTIVE_DEBIT_FAILURES`): a failure here already refuses
    the whole job, which is a stronger answer than counting toward five.
    """
    if not meta.user_id:
        logger.info(
            "no learner on this job: running unmetered against the dispatched balance",
            extra={"balance_s": meta.balance_s},
        )
        return meta.balance_s

    if not billing.enabled:
        reason = "CONVEX_SITE_URL or CLERK_WORKER_MACHINE_SECRET_KEY is not set"
    else:
        read = await billing.balance()
        if read is not None:
            billing.set_billed_before(read.seconds_billed)
            logger.info(
                "ledger open",
                extra={
                    "balance_s": read.balance_seconds,
                    "billed_before_s": read.seconds_billed,
                    "dispatched_balance_s": meta.balance_s,
                },
            )
            return read.balance_seconds
        reason = "the balance read failed"

    if cfg.allow_unmetered:
        logger.warning(
            "TUTOR_ALLOW_UNMETERED=1: running this session UNMETERED (%s). "
            "Nothing will be billed. Never set this in production.",
            reason,
        )
        return meta.balance_s

    logger.error(
        "refusing this job: the learner is metered but the ledger is unreachable (%s). "
        "Set CONVEX_SITE_URL and CLERK_WORKER_MACHINE_SECRET_KEY, or "
        "TUTOR_ALLOW_UNMETERED=1 for "
        "local development.",
        reason,
        extra={"user_id": meta.user_id, "room": ctx.room.name, "job_id": ctx.job.id},
    )
    ctx.shutdown(reason="ledger unreachable: refusing to run an unmetered paid session")
    return None


def _meter_from_first_tutor_audio(
    ctx: JobContext, session: AgentSession, clock: SessionClock
) -> None:
    """Start the clock on the first frame of tutor audio that actually plays.

    `agent_state_changed` → `"speaking"` is that frame: the framework flips the
    state from the playout task's first-frame callback, once, per speech
    (`agent_activity`, 1.6.x), and publishes it as `lk.agent.state`. Requesting
    a reply is not the same event — the model can fail, the socket can die, and
    the audio can never arrive.

    The watchdog does not end anything. It cannot: nothing has been billed (the
    clock never started), so there is no money question — only an operational
    one. It does now SAY so, to the learner as well as to the logs: a stage
    that has been silent for twenty seconds is a failure the learner can act on
    (reload), and until `tutor.error` existed they had no way to know that
    (audit §4.2).
    """

    def _on_agent_state(ev: object) -> None:
        if getattr(ev, "new_state", None) != "speaking" or clock.started:
            return
        _spawn(clock.start(), "tutor-clock-start")

    session.on("agent_state_changed", _on_agent_state)

    async def _watchdog() -> None:
        await asyncio.sleep(FIRST_AUDIO_TIMEOUT_S)
        if clock.started:
            return
        logger.error(
            "the tutor has not spoken %.0fs after the session started; nothing is being "
            "metered and the learner is looking at a silent stage",
            FIRST_AUDIO_TIMEOUT_S,
        )
        await _publish_error(ctx.room, ERROR_TUTOR_SILENT)

    _spawn(_watchdog(), "tutor-first-audio-watchdog")


async def _publish_error(room: rtc.Room, code: str) -> None:
    """Say what went wrong, in one code the frontend renders as one sentence.

    Guarded like every other publish: an error the learner cannot be told about
    is still an error, and the paths that call this are all on their way out.
    """
    try:
        await room.local_participant.set_attributes({ATTR_ERROR: code})
        logger.info("published session error", extra={"code": code})
    except Exception:
        logger.warning("failed to publish the session error %r", code, exc_info=True)


def _watch_session_errors(
    ctx: JobContext,
    session: AgentSession,
    state: SessionState,
    clock: SessionClock,
    billing: BillingClient,
) -> None:
    """The realtime pipeline dying, told to the learner and to the ledger.

    Before this, nothing subscribed to session or model errors (audit §4.2): if
    the OpenAI socket died the learner watched a live stage go quiet and the
    meter kept running against a conversation that no longer existed.

    Two subscriptions, one outcome, fired at most once:

    - `error` with `recoverable=False` on the LLM / realtime model. The
      realtime model is the conversation; when it is unrecoverably gone there
      is nothing left to wait for, and the framework is closing the session
      under us anyway.
    - `close` with `reason=ERROR`, which is the backstop for everything else
      (an STT or TTS failure only becomes unrecoverable after the framework's
      own retry budget — `max_unrecoverable_errors` — and this is where that
      verdict arrives).

    Recoverable errors are logged at warning and do nothing else: the plugin
    retries, the conversation survives, and a `tutor.error` for a hiccup would
    train the learner to ignore the one that matters.

    The order out is deliberate: hold the clock (the seconds between a dead
    socket and a landed shutdown are not tutoring), publish the code, debit
    while the worker is certainly alive, then end through the ordinary
    `session_over` path so the client's `finish` runs and the learner lands on
    a summary rather than a frozen stage. The teardown's final debit and the
    summary post follow from `ctx.shutdown`.
    """
    failed = False

    async def _fail() -> None:
        state.model_failed = True
        try:
            await clock.notify_hold_changed()
        except Exception:
            logger.warning("clock republish on model failure failed", exc_info=True)
        await _publish_error(ctx.room, ERROR_MODEL)
        try:
            await billing.debit(clock.seconds_billed)
        except Exception:
            logger.warning("debit on model failure failed", exc_info=True)
        await _end_session(ctx, session, reason="realtime model error")

    def _fire(why: str) -> None:
        nonlocal failed
        if failed:
            return
        failed = True
        logger.error("ending the session: %s", why, extra={"seconds_billed": clock.seconds_billed})
        _spawn(_fail(), "tutor-model-error")

    def _on_error(ev: ErrorEvent) -> None:
        error = getattr(ev, "error", None)
        kind = getattr(error, "type", "unknown")
        if getattr(error, "recoverable", False):
            logger.warning("recoverable %s; the plugin will retry", kind)
            return
        logger.error("unrecoverable %s", kind)
        if kind in ("realtime_model_error", "llm_error"):
            _fire(f"unrecoverable {kind}")

    def _on_close(ev: CloseEvent) -> None:
        if getattr(ev, "reason", None) != CloseReason.ERROR:
            return
        _fire("the session closed on an unrecoverable error")

    session.on("error", _on_error)
    session.on("close", _on_close)


def _is_learner(participant: rtc.Participant) -> bool:
    """Every remote participant that is not another agent is the learner."""
    return participant.kind != rtc.ParticipantKind.PARTICIPANT_KIND_AGENT


def _learner_present(room: rtc.Room) -> bool:
    return any(_is_learner(p) for p in room.remote_participants.values())


def _watch_learner_presence(
    ctx: JobContext,
    state: SessionState,
    clock: SessionClock,
    billing: BillingClient,
) -> None:
    """Stop metering the moment the learner's participant leaves (audit B4).

    `close_on_disconnect` only covers client-initiated, room-deleted and
    rejected disconnects — a wifi drop, a tab crash and a closed laptop are
    none of those, and before this the clock happily metered an empty room down
    to zero, held it, and sat there until the 10-minute idle timeout.

    Three things happen on the way out, in this order: the meter is held (a
    hold source of its own, never `state.paused` — that boolean is the UI's,
    edge-triggered by the pause RPC, and borrowing it would make the learner's
    next pause a no-op), the seconds so far are debited while the worker is
    definitely still alive, and a grace timer starts. Come back inside the
    grace and the same conversation resumes in the same room; do not, and the
    job ends.
    """
    grace: dict[str, asyncio.Task[None] | None] = {"task": None}

    async def _hold_then_end() -> None:
        try:
            await clock.notify_hold_changed()
        except Exception:
            logger.warning("clock republish on disconnect failed", exc_info=True)
        try:
            # Bill now: the worker is alive now, and it may not be in a minute.
            await billing.debit(clock.seconds_billed)
        except Exception:
            logger.warning("debit on disconnect failed", exc_info=True)
        await asyncio.sleep(DISCONNECT_GRACE_S)
        if not state.learner_absent:
            return
        logger.info(
            "learner did not come back within %.0fs: ending the job",
            DISCONNECT_GRACE_S,
            extra={"seconds_billed": clock.seconds_billed},
        )
        ctx.shutdown(reason="learner disconnected")

    def _on_disconnected(participant: rtc.RemoteParticipant) -> None:
        if not _is_learner(participant) or _learner_present(ctx.room):
            return
        if state.learner_absent:
            return
        state.learner_absent = True
        logger.warning(
            "the learner's participant left the room: holding the clock",
            extra={"identity": participant.identity, "seconds_billed": clock.seconds_billed},
        )
        grace["task"] = _spawn(_hold_then_end(), "tutor-disconnect-grace")

    def _on_connected(participant: rtc.RemoteParticipant) -> None:
        if not _is_learner(participant) or not state.learner_absent:
            return
        state.learner_absent = False
        task = grace["task"]
        grace["task"] = None
        if task is not None and not task.done():
            task.cancel()
        logger.info(
            "the learner came back: releasing the clock hold",
            extra={"identity": participant.identity},
        )
        _spawn(_republish_hold(clock), "tutor-reconnect-republish")

    ctx.room.on("participant_disconnected", _on_disconnected)
    ctx.room.on("participant_connected", _on_connected)


async def _republish_hold(clock: SessionClock) -> None:
    try:
        await clock.notify_hold_changed()
    except Exception:
        logger.warning("clock republish on reconnect failed", exc_info=True)


def _build_clock(
    ctx: JobContext,
    cfg: TutorConfig,
    session: AgentSession,
    state: SessionState,
    budget_s: int,
    hold: SessionHold,
    billing: BillingClient,
) -> SessionClock:
    """Wire the clock's callbacks to this session. See `clock.py`.

    `clock` is read late inside the callbacks on purpose: the zero handler needs
    the very number the clock is holding at the moment it fires.
    """
    clock: SessionClock

    async def _publish(elapsed_s: int, remaining_s: int, out_of_minutes: bool) -> None:
        await ctx.room.local_participant.set_attributes(
            {
                ATTR_ELAPSED_S: str(elapsed_s),
                ATTR_REMAINING_S: str(remaining_s),
                ATTR_OUT_OF_MINUTES: ATTR_TRUE if out_of_minutes else ATTR_FALSE,
            }
        )

    async def _nudge() -> None:
        # The same seam as the resume brief: state the situation, let the tutor
        # decide how to land it. Fire-and-forget — finishing a thought is a turn
        # in the conversation, not a barrier in front of it.
        session.generate_reply(instructions=nudge_instructions())

    async def _zero() -> None:
        """Out of minutes: stop talking, report what was used, and hold.

        The session does NOT end. The learner buys a pack and resumes into the
        same conversation, or leaves (decision 2026-08-24). The debit goes out
        before the hold so the balance the frontend re-reads is already right by
        the time the out-of-minutes card is on screen.
        """
        try:
            await session.interrupt()
        except Exception:
            logger.warning("interrupt at zero failed", exc_info=True)
        try:
            # `zero_hold=True`: a failure here is REMEMBERED. These seconds are
            # in the balance the resume is about to re-read, so resuming on that
            # balance would spend them twice (audit §3.1.6).
            await billing.debit(clock.seconds_billed, zero_hold=True)
        except Exception:
            logger.warning("debit at zero failed", exc_info=True)
        try:
            await hold.apply(True)
        except Exception:
            logger.exception("hold at zero failed")

    async def _debit() -> None:
        # The periodic report (audit §4.1). Cumulative, so the ledger takes only
        # the delta; a crash now costs at most one interval of revenue.
        await billing.debit(clock.seconds_billed)

    async def _idle_end() -> None:
        await _end_session(ctx, session)

    async def _ledger_ceiling() -> None:
        """The debits stopped landing: hold the meter and end the session.

        Called once, by `BillingClient` itself, after
        `MAX_CONSECUTIVE_DEBIT_FAILURES` consecutive failures. `ledger_failed`
        is a hold source that never releases (like `model_failed`): a worker
        that cannot tell anyone what this conversation costs must not go on
        talking, and must not sit in a retry loop that keeps the job alive.
        The learner lands on the summary through the ordinary `session_over`
        path; the last minutes go unbilled and Convex's cron closes the row.
        """
        state.ledger_failed = True
        try:
            await clock.notify_hold_changed()
        except Exception:
            logger.warning("clock republish on ledger failure failed", exc_info=True)
        await _end_session(ctx, session, reason="ledger failure ceiling reached")

    billing.set_ceiling_handler(_ledger_ceiling)

    clock = SessionClock(
        budget_s,
        publish=_publish,
        on_nudge=_nudge,
        on_zero=_zero,
        on_idle_end=_idle_end,
        on_debit=_debit,
        # Every hold source, not just the UI's: a learner whose connection
        # dropped is not spending minutes either (audit B4).
        is_paused=lambda: state.clock_held,
        # No hold lasts forever (audit §3.3): a learner who paused and left
        # ends the same way an abandoned zero hold does.
        hold_idle_timeout_s=cfg.hold_idle_s,
    )
    return clock


async def _end_session(
    ctx: JobContext,
    session: AgentSession,
    *,
    reason: str = "out of minutes: hold abandoned",
) -> None:
    """End the session: cut whatever is in flight, mark it over, disconnect.

    There is no spoken goodbye any more (vision doc 2026-08-24: no scripted
    goodbye). Every caller is a session nobody is listening to any more: a zero
    hold abandoned for `IDLE_TIMEOUT_S`, an ordinary hold abandoned for
    `TUTOR_HOLD_IDLE_S`, or a realtime model that died under the conversation.

    Every step is guarded: the disconnect at the end must happen even if the
    steps before it fail.
    """
    try:
        await session.interrupt()
    except Exception:
        logger.warning("interrupt before session end failed", exc_info=True)

    try:
        await ctx.room.local_participant.set_attributes({ATTR_SESSION_OVER: ATTR_TRUE})
    except Exception:
        logger.warning("failed to publish session over", exc_info=True)

    try:
        await session.aclose()
    except Exception:
        logger.warning("session close failed", exc_info=True)

    # Leaves the room to the learner (the summary surface is still theirs) and
    # runs the shutdown callbacks, which is where the seconds are reported.
    ctx.shutdown(reason=reason)


def _capture_pause_context(session: AgentSession, state: SessionState) -> None:
    """Snapshot what the hold is interrupting, before we interrupt it.

    Three facts, read off the session's own state machine:

    - `agent_state == "speaking"` (plus a live `current_speech` handle) means the
      tutor was mid-sentence — resuming into silence would leave the thought
      hanging.
    - `agent_state == "thinking"` means a committed learner turn was waiting on
      a reply that the hold is about to kill.
    - `user_state == "speaking"` means the learner was mid-utterance. They keep
      the floor: they paused to look something up, not to be talked at.
    """
    speech = session.current_speech
    state.paused_at = time.monotonic()
    state.tutor_was_speaking = session.agent_state == "speaking" or (
        speech is not None and not speech.done()
    )
    state.reply_was_pending = session.agent_state == "thinking"
    state.learner_was_speaking = session.user_state == "speaking"


# A hold must never block on the STT, so the flush below is bounded twice: the
# silence pushed into the STT, the wait for the final it produces, then a hard
# ceiling around the whole thing. The wait must outlast the STT's own final
# latency (~0.85s after its 350ms VAD window, measured 2026-08-23): at 1.0s
# the final never arrived, the provider kept its segment open across the
# hold, and its post-resume final replayed the pre-hold words in front of the
# new ones. The hold is acknowledged before any of this, so the wait costs
# the learner nothing.
HOLD_FLUSH_SILENCE_S = 1.0
HOLD_FLUSH_WAIT_S = 2.5
HOLD_FLUSH_CEILING_S = 3.5


async def _flush_open_user_turn(
    session: AgentSession,
    state: SessionState,
    analyzer: CorrectionAnalyzer | None,
    room: rtc.Room,
) -> None:
    """Close the learner's open transcript segment before the hold goes quiet.

    The STT endpoints on audio, and a held session sends it none — not even
    silence, since the room input is detached. So whatever the learner said in
    the moment before the hold sits in an un-finalized segment for as long as
    the hold lasts, and the first words after resume are appended to *that*
    segment: one utterance split across two transcript messages (live,
    2026-08-21). `commit_user_turn` pushes the silence the STT needs to
    endpoint, which finalizes the pending text and flushes the segment, so the
    next word after resume starts a fresh one.

    With a realtime model the framework forces `skip_reply` down this path
    (`agent_activity.commit_user_turn`), so `TutorAgent.on_user_turn_completed`
    never sees the turn we just closed — what it would have done for a turn that
    commits during a hold is done here instead.
    """
    started = time.monotonic()
    logger.info("hold: flushing open user turn", extra={"user_state": session.user_state})

    text = ""
    result = "empty"
    try:
        text = await asyncio.wait_for(
            session.commit_user_turn(
                skip_reply=True,
                transcript_timeout=HOLD_FLUSH_WAIT_S,
                stt_flush_duration=HOLD_FLUSH_SILENCE_S,
            ),
            timeout=HOLD_FLUSH_CEILING_S,
        )
        result = "committed" if text else "empty"
    except asyncio.TimeoutError:
        # A hold that hangs is worse than a split transcript. The flush itself
        # keeps running; we just stop waiting on it.
        result = "timeout"
    except Exception:
        result = "error"
        logger.warning("hold: user turn flush failed", exc_info=True)

    if text:
        # This path commits a turn without `on_user_turn_completed` ever running
        # (the framework forces `skip_reply`, see the docstring), so the UI's
        # turn-commit signal has to be published here too — otherwise the first
        # words after a resume land in the pre-hold bubble.
        _publish_turn_commit(room, state)
        # The turn is owed an answer, which the conversational re-entry gives on
        # resume — unless a resume raced this flush, in which case it has already
        # decided how to re-enter and the flag would only leak into the next
        # hold. `learner_was_speaking` is deliberately left as captured: unlike a
        # real end-of-turn commit, this one was forced by the hold and says
        # nothing about whether the learner had finished — if they were
        # mid-sentence they still keep the floor.
        if state.paused:
            state.reply_was_pending = True
        if analyzer is not None:
            # The committed message reaches the chat context a moment later (the
            # framework's end-of-turn task), so the context here excludes it
            # already and needs no `exclude_id`.
            analyzer.analyze_in_background(
                turn_id=utils.shortuuid("item_"),
                text=text,
                context=recent_context(session.history),
            )

    logger.info(
        "hold: open user turn flushed",
        extra={
            "result": result,
            "transcript_chars": len(text),
            "elapsed_ms": round((time.monotonic() - started) * 1000),
        },
    )


@dataclass(init=False)
class ResumeBrief:
    """The advisory `tutor.resume` payload, coerced once at the boundary.

    Every field crosses the wire from the client, so every field is optional and
    every type is checked here — once — leaving `_resume_facts` to read plain
    values. `present` records whether the client sent *any* brief at all, which
    is a different question from whether the brief yielded any usable facts.
    """

    present: bool
    held_ms: float | None
    reasons: list[str]
    # (original, replacement, category | None)
    correction: tuple[str, str, str | None] | None
    # The study surface (phase 4, WS4c): which tab was open when the hold
    # released, and what they asked while it was. Both optional — a hold with no
    # overlay has no tab, and a client that predates the study surface sends
    # neither. The ANSWERS never travel: what returns to the voice model is a
    # brief, never the Ask transcript (vision doc, 2026-08-20 #4).
    tab: str | None
    asks: list[str]

    def __init__(self, raw: dict | None = None) -> None:
        raw = raw if isinstance(raw, dict) else {}
        self.present = bool(raw)
        self.held_ms = _coerce_number(raw.get("held_ms"))
        self.reasons = _coerce_reasons(raw.get("reasons"))
        self.correction = _coerce_correction(raw.get("correction"))
        self.tab = _coerce_tab(raw.get("tab"))
        self.asks = _coerce_asks(raw.get("asks"))

    @property
    def studied(self) -> bool:
        """Whether the hold was spent learning something nameable.

        An inspected correction and a question asked are the same thing to the
        re-entry template: both mean the learner has a specific thing in their
        head that a comprehension check can land on.
        """
        return self.correction is not None or bool(self.asks)


def _coerce_number(value: object) -> float | None:
    # bool is an int subclass; a JSON `true` is not a duration.
    if isinstance(value, (int, float)) and not isinstance(value, bool):
        return float(value)
    return None


def _coerce_reasons(value: object) -> list[str]:
    if not isinstance(value, (list, tuple)):
        return []
    return sorted({r.strip() for r in value if isinstance(r, str) and r.strip()})


def _coerce_correction(value: object) -> tuple[str, str, str | None] | None:
    if not isinstance(value, dict):
        return None
    original = value.get("original")
    replacement = value.get("replacement")
    if not (isinstance(original, str) and original):
        return None
    if not (isinstance(replacement, str) and replacement):
        return None
    category = value.get("category")
    return original, replacement, category if isinstance(category, str) and category else None


def _coerce_tab(value: object) -> str | None:
    return value if isinstance(value, str) and value in STUDY_TABS else None


def _coerce_asks(value: object) -> list[str]:
    """The questions asked during the hold, oldest first, capped.

    Whitespace-collapsed and length-capped like every other string that crosses
    into a prompt: this is learner-typed text on its way into the tutor's
    context, and the brief is meant to be two lines, not a transcript.
    """
    if not isinstance(value, (list, tuple)):
        return []
    asks: list[str] = []
    for entry in value:
        if not isinstance(entry, str):
            continue
        cleaned = " ".join(entry.split())[:MAX_ASK_CHARS]
        if cleaned:
            asks.append(cleaned)
    return asks[-MAX_RESUME_ASKS:]


def _resume_facts(state: SessionState, facts: SessionFacts, brief: ResumeBrief) -> list[str]:
    """Turn the resume payload plus the pause snapshot into plain statements."""
    lines: list[str] = []

    # The client's own measurement is authoritative (it owns the set of holds);
    # our timestamp is only a fallback for a payload that omitted it.
    held_ms = brief.held_ms
    if held_ms is None and state.paused_at is not None:
        held_ms = (time.monotonic() - state.paused_at) * 1000
    if held_ms is not None and held_ms > 0:
        seconds = held_ms / 1000
        lines.append(
            f"the conversation was on hold for about {seconds:.0f} seconds"
            if seconds >= 1
            else "the conversation was on hold for a moment"
        )

    if brief.reasons:
        lines.append("the learner was looking at: " + ", ".join(brief.reasons))

    # The study surface, at most two lines: where they were and what they asked.
    # Never the answers — the brief is the cost-containment rule for the voice
    # model (vision doc, 2026-08-20 #4).
    if brief.tab is not None:
        lines.append(f"they were in the {STUDY_TABS[brief.tab]} tab")

    if brief.correction is not None:
        original, replacement, category = brief.correction
        suffix = f" (a {category} correction)" if category else ""
        lines.append(
            f'they read a correction on their last turn: "{original}" -> "{replacement}"{suffix}'
        )

    if brief.asks:
        lines.append("they asked: " + ", ".join(f'"{ask}"' for ask in brief.asks))

    if state.tutor_was_speaking:
        lines.append("you were mid-sentence when the hold began")
    elif state.reply_was_pending:
        lines.append("you were about to reply to their last turn when the hold began")

    summary = facts.summary()
    if summary:
        lines.append(summary)

    return lines


def _parse_brief(payload: str | None) -> ResumeBrief:
    """Resume payloads are advisory. Anything unreadable means "no brief"."""
    if not payload or not payload.strip():
        return ResumeBrief()
    try:
        brief = json.loads(payload)
    except json.JSONDecodeError:
        logger.warning("tutor.resume: unparseable payload, resuming without a brief")
        return ResumeBrief()
    return ResumeBrief(brief)


class SessionHold:
    """The hold: one boolean, edge-triggered, mirrored as `tutor.paused`.

    Two things hold the session and they must take exactly the same path: the
    learner (the pause RPC below) and the clock at zero balance. Out of minutes
    is not a different kind of quiet — it is the study hold the frontend already
    knows how to render, plus one extra attribute.
    """

    def __init__(
        self,
        ctx: JobContext,
        session: AgentSession,
        state: SessionState,
        analyzer: CorrectionAnalyzer | None,
    ) -> None:
        self._ctx = ctx
        self._session = session
        self._state = state
        self._analyzer = analyzer

    async def publish(self, paused: bool) -> None:
        await self._ctx.room.local_participant.set_attributes(
            {ATTR_PAUSED: ATTR_TRUE if paused else ATTR_FALSE}
        )

    async def apply(self, paused: bool) -> bool:
        """Edge-triggered. Returns False when the session was already there.

        The frontend re-sends `tutor.pause` every couple of seconds until it
        observes the paused attribute, so this runs more than once per hold.
        Only the transition may touch the session: a second pause would snapshot
        a session we have already interrupted (recording "nothing was happening"
        over the truth) and re-stamp `paused_at`, and a second resume would fire
        a second `generate_reply`.
        """
        session, state = self._session, self._state
        if state.paused == paused:
            # A retry of a transition that already ran. Re-publish the
            # acknowledgement, idempotently: the frontend keeps re-sending until
            # it sees the attribute, and the only way a retry reaches here with
            # the attribute unseen is that the publish itself failed last time.
            await self.publish(paused)
            return False
        state.paused = paused
        try:
            if paused:
                # Read the session's state *before* interrupting it — afterwards
                # there is nothing left to observe.
                _capture_pause_context(session, state)
                # Stop the tutor mid-sentence, then go deaf and mute.
                #
                # Never `clear_user_turn()`: a hold is often opened mid-utterance
                # (the learner taps a correction, or scrolls back, while still
                # speaking), and discarding the buffered turn would throw away what
                # they had just said. But it cannot simply be left open either — a
                # deaf session starves the STT of the audio it endpoints on, so the
                # turn would still be open when the learner speaks again. So: keep
                # it, and close it. The flush runs *after* the input is detached,
                # which is what lets the framework substitute silence for it.
                await session.interrupt()
                session.input.set_audio_enabled(False)
                session.output.set_audio_enabled(False)
            else:
                session.input.set_audio_enabled(True)
                session.output.set_audio_enabled(True)
        except Exception:
            # A transition that failed halfway must not look finished: the
            # frontend retries, and `state.paused` is what makes the retry a
            # no-op. Put state and audio back the way they were, then surface it.
            state.paused = not paused
            session.input.set_audio_enabled(not paused)
            session.output.set_audio_enabled(not paused)
            raise

        # The transition is complete; only the acknowledgement remains, and it
        # is outside the rollback on purpose — a failed publish must not undo
        # the interrupt or re-run the snapshot on retry (the retry path above
        # re-publishes instead). It goes before the flush below because the
        # flush costs ~1s even when nothing is pending (live, 2026-08-21: eight
        # holds, all empty, all ~1005ms).
        await self.publish(paused)
        logger.info("session %s", "paused" if paused else "resumed")
        if paused:
            await _flush_open_user_turn(session, state, self._analyzer, self._ctx.room)
        return True


async def _register_pause_rpc(
    ctx: JobContext,
    session: AgentSession,
    state: SessionState,
    facts: SessionFacts,
    cfg: TutorConfig,
    clock: SessionClock,
    hold: SessionHold,
    billing: BillingClient,
) -> None:
    """Pause/resume, driven by the frontend's client-side set of holds.

    The frontend collapses overlapping holds (explicit control, correction
    inspection, selection-to-translate, history scroll) and sends exactly one
    pause or resume; the worker only tracks the resulting boolean and mirrors it
    as an attribute. Short glances never arrive here at all — the frontend
    debounces them, because the surface freeze is client-side and instant.

    One resume is not a resume: a session held because the balance ran out only
    comes back if the balance did. That check is first, and it is the seam a
    mid-session purchase returns through.
    """

    # The last answer each side gave, so a retry gets the same answer back.
    last_resume_ack = json.dumps({"paused": False, "resumed": False})
    # The answer to a resume that could not be granted, likewise stable.
    still_held_ack = json.dumps({"paused": True, "resumed": False, "out_of_minutes": True})
    # The frontend re-sends `tutor.resume` until it observes the attribute, and
    # while the balance is still zero it never will — so the balance re-read is
    # throttled. A purchase takes longer than this anyway.
    last_balance_check = 0.0

    async def _pause(_data: rtc.RpcInvocationData) -> str:
        await hold.apply(True)
        await clock.notify_hold_changed()
        return json.dumps({"paused": True})

    async def _resume(data: rtc.RpcInvocationData) -> str:
        # A realtime model cannot resume a truncated reply mid-word, and it
        # should not try: a human tutor interrupted mid-thought re-enters
        # ("como decía…") rather than replaying the tape. So instead of
        # restoring audio, we hand the model a short factual brief and let it
        # re-enter with judgment — and only when it actually owes the learner
        # something. If the learner was mid-utterance, resume stays silent and
        # lets them finish.
        nonlocal last_resume_ack, last_balance_check
        brief = _parse_brief(data.payload)

        if clock.out_of_minutes:
            # Held at zero. A purchase may have landed while they were looking
            # at the out-of-minutes card, so the balance is re-read here and
            # nowhere else. If it is still zero, the hold simply stays: the
            # session is alive, the room is theirs, and nothing was lost.
            now = time.monotonic()
            if now - last_balance_check < BALANCE_RECHECK_MIN_S:
                return still_held_ack
            last_balance_check = now

            balance_s: int | None = None
            if billing.zero_debit_unacked:
                # The debit at the zero hold never landed, so the seconds it
                # was meant to take are still sitting in the balance. Budgeting
                # from that balance would hand them to the learner a second time
                # (audit §3.1.6) — so the debit is retried FIRST, and the resume
                # is refused if it still fails. Its answer is the balance after
                # the debit, which is exactly the number to re-budget from.
                logger.warning("out of minutes: retrying the unacknowledged zero debit")
                balance_s = await billing.debit(clock.seconds_billed, zero_hold=True)
                if balance_s is None:
                    logger.error("out of minutes: zero debit still failing, refusing the resume")
                    return still_held_ack

            if balance_s is None:
                read = await billing.balance()
                balance_s = read.balance_seconds if read is not None else None
            if balance_s is None or not await clock.apply_balance(balance_s):
                logger.info("out of minutes: resume refused, still held")
                return still_held_ack
            logger.info("out of minutes: balance restored", extra={"balance_s": balance_s})

        if not await hold.apply(False):
            # A retry of a resume we already handled: same answer, no second
            # re-entry.
            return last_resume_ack

        # The stopwatch starts again the moment the hold does.
        try:
            await clock.notify_hold_changed()
        except Exception:
            logger.warning("clock republish on resume failed", exc_info=True)

        # A nudge that came due during the hold is delivered now, before any
        # re-entry line, so the tutor re-enters already knowing it is finishing
        # the thought. No-op unless the 30s mark passed while paused.
        try:
            await clock.notify_resumed()
        except Exception:
            logger.exception("deferred nudge failed")

        try:
            if not brief.present or not state.tutor_owes_reentry:
                last_resume_ack = json.dumps({"paused": False, "resumed": False})
                return last_resume_ack

            lines = _resume_facts(state, facts, brief)
            try:
                # Shuffle the bridge's flavor: same intent twice in a row
                # reads as a canned line, which is the one thing a re-entry
                # must never feel like.
                intent = random.choice([i for i in BRIDGE_INTENTS if i != state.last_bridge_intent])
                state.last_bridge_intent = intent
                session.generate_reply(
                    instructions=resume_instructions(
                        cfg,
                        lines,
                        # An unanswered learner turn gets a real answer; an
                        # interrupted delivery gets a one-line bridge, never a
                        # replay (the message is still on screen).
                        owes_answer=state.reply_was_pending,
                        # A hold spent asking questions is a hold spent
                        # studying: the re-entry has something specific to
                        # check on, exactly as an inspected correction does.
                        studied=brief.studied,
                        intent=intent,
                    )
                )
            except Exception:
                # Never fail the resume: the surface has already unfrozen.
                logger.exception("conversational resume failed")
                last_resume_ack = json.dumps({"paused": False, "resumed": False})
                return last_resume_ack

            logger.info("conversational resume", extra={"facts": len(lines)})
            last_resume_ack = json.dumps({"paused": False, "resumed": True})
            return last_resume_ack
        finally:
            # One exit for the snapshot, whatever path the resume took: a leaked
            # snapshot would describe the *previous* hold on the next resume.
            state.clear_pause_context()

    ctx.room.local_participant.register_rpc_method(RPC_PAUSE, _pause)
    ctx.room.local_participant.register_rpc_method(RPC_RESUME, _resume)

    # Publish the initial state so a client that joins (or rejoins) mid-session
    # renders the right thing without asking.
    await ctx.room.local_participant.set_attributes({ATTR_PAUSED: ATTR_FALSE})


if __name__ == "__main__":
    # Windows consoles default to cp1252, which cannot encode the Spanish the
    # transcripts are full of; without this every "¿" in a debug line is a
    # logging traceback instead of a log line.
    for stream in (sys.stdout, sys.stderr):
        if hasattr(stream, "reconfigure"):
            stream.reconfigure(encoding="utf-8", errors="replace")
    agents.cli.run_app(server)
