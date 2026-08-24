"""LiveKit Agents worker for the language tutor.

Pipeline (see plans/phases/phase-2-live-pipeline.md and phase-3):

    GPT Realtime (speech-to-speech)    -> the tutor's voice
  + parallel STT (gpt-live-transcribe) -> live target-language transcripts
  + LiveKit semantic turn detector     -> the ONE turn clock for everything
  + on_user_turn_completed             -> background analyzer -> corrections
  + tutor.translate RPC                -> select-to-translate, on demand

Run with `lk agent dev` (or `uv run python src/agent.py dev`).
"""

from __future__ import annotations

import asyncio
import json
import logging
import random
import sys
import time
from dataclasses import dataclass

from dotenv import load_dotenv
from livekit import agents, rtc
from livekit.agents import (
    Agent,
    AgentServer,
    AgentSession,
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
from arc import SessionArc
from ask import AskCoach, register_ask_rpc
from clock import SessionClock, report_minutes_billed
from config import (
    AGENT_NAME,
    ANALYZER_OFF,
    ANALYZER_ON,
    ATTR_ANALYZER,
    ATTR_FALSE,
    ATTR_MINUTES_LEFT,
    ATTR_PAUSED,
    ATTR_SESSION_OVER,
    ATTR_TRUE,
    ATTR_TURN_SEQ,
    RPC_PAUSE,
    RPC_RESUME,
    TutorConfig,
)
from plan import JobMetadata, SessionPlan
from prompts import (
    BRIDGE_INTENTS,
    goodbye_instructions,
    greeting_instructions,
    resume_instructions,
    stt_prompt,
    tutor_instructions,
    wrapup_instructions,
)
from review import ReviewMaterial, register_review_rpc
from state import SessionFacts, SessionState
from translate import SpanTranslator, register_translate_rpc
from usage import UsageTracker

load_dotenv(".env.local")

logger = logging.getLogger("tutor.agent")

# How long the closing goodbye may take before the worker stops waiting for it.
# The session is already over; a stuck speech handle must not hold the room.
GOODBYE_TIMEOUT_S = 20.0

# The pause surface's tabs, wire value -> how the brief names it. Must match the
# `tab` union in `frontend/lib/session/protocol.ts`.
STUDY_TABS = {"transcript": "Transcript", "review": "Review", "ask": "Ask"}

# How many of a hold's questions ride back on the resume payload, and how long
# each may be. Mirrors `MAX_RESUME_ASKS` in the frontend's protocol module; the
# cap is re-applied here because this is untrusted input on its way to a prompt.
MAX_RESUME_ASKS = 5
MAX_ASK_CHARS = 200


# Publishes in flight. Fire-and-forget tasks are garbage collected unless
# something holds a reference to them, so they are parked here until they end.
_turn_seq_tasks: set[asyncio.Task[None]] = set()


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

    task = asyncio.create_task(_publish(), name="tutor-turn-seq")
    _turn_seq_tasks.add(task)
    task.add_done_callback(_turn_seq_tasks.discard)


class TutorAgent(Agent):
    """The conversation partner. Analysis happens beside it, never inside it."""

    def __init__(
        self,
        cfg: TutorConfig,
        analyzer: CorrectionAnalyzer | None,
        state: SessionState,
        room: rtc.Room,
        plan: SessionPlan | None = None,
        phase_block: str = "",
    ) -> None:
        super().__init__(instructions=tutor_instructions(cfg, plan, phase_block))
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
            "max_minutes": meta.max_minutes,
            "user_id": meta.user_id,
            **meta.plan.log_fields(),
        },
    )

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
    # `phase` is read late, on purpose: the arc below is assigned after this.
    coach = AskCoach(cfg, meta.plan, facts, phase=lambda: arc.phase)
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
                # However the session ended — clock, learner leaving, or a
                # crash — this is the number the ledger owes a debit for.
                report_minutes_billed(meta.user_id, clock.minutes_billed, ctx.room.name)
            except Exception:
                logger.warning("billing report failed", exc_info=True)
            try:
                # What it cost us, for pricing decisions: tokens, talk share,
                # estimated dollars. Logged, never billed.
                usage.log_summary(active_minutes=clock.minutes_billed, room=ctx.room.name)
            except Exception:
                logger.warning("usage summary failed", exc_info=True)
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

    # The arc owns the phase; the model is told which one it is in through the
    # standing instructions, and never decides for itself. It is built before
    # the agent because the agent opens *in* the first phase.
    arc = _build_arc(cfg, session, state, facts, meta)

    await session.start(
        agent=TutorAgent(cfg, analyzer, state, ctx.room, meta.plan, arc.brief(cfg)),
        room=ctx.room,
        room_options=room_io.RoomOptions(
            # Text input is off: this is a voice surface, not a chat box.
            text_input=False,
        ),
    )

    clock = _build_clock(ctx, session, state, cfg, meta, arc)

    await _register_pause_rpc(ctx, session, state, facts, cfg, clock, arc, analyzer)
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
        }
    )

    # The clock starts with the conversation, not with the job: the greeting is
    # requested first so the learner's first minute is a minute of tutoring, and
    # the clock starts without waiting for that greeting to finish playing.
    session.generate_reply(instructions=greeting_instructions(cfg, meta.plan))
    await clock.start()


def _build_arc(
    cfg: TutorConfig,
    session: AgentSession,
    state: SessionState,
    facts: SessionFacts,
    meta: JobMetadata,
) -> SessionArc:
    """Wire the arc to this session. See `arc.py`.

    A phase change rewrites the standing instructions rather than speaking:
    `update_instructions` never interrupts an in-flight turn, so the model
    simply picks the new phase up on its next one. The brief is rendered at
    transition time, not up front, because the debrief's brief carries the
    session facts as they stand when the debrief actually starts.
    """
    arc: SessionArc

    async def _enter_phase() -> None:
        await session.current_agent.update_instructions(
            tutor_instructions(cfg, meta.plan, arc.brief(cfg, facts.summary()))
        )

    arc = SessionArc(
        meta.max_minutes,
        meta.plan,
        on_phase=_enter_phase,
        is_paused=lambda: state.paused,
    )
    return arc


def _build_clock(
    ctx: JobContext,
    session: AgentSession,
    state: SessionState,
    cfg: TutorConfig,
    meta: JobMetadata,
    arc: SessionArc,
) -> SessionClock:
    """Wire the clock's callbacks to this session. See `clock.py`."""

    async def _publish_minutes(minutes: int) -> None:
        await ctx.room.local_participant.set_attributes({ATTR_MINUTES_LEFT: str(minutes)})

    async def _warn() -> None:
        # The same seam as the resume brief: state the situation, let the tutor
        # decide how to land it. Fire-and-forget — the wrap-up is a turn in the
        # conversation, not a barrier in front of it.
        session.generate_reply(instructions=wrapup_instructions())

    async def _end() -> None:
        await _end_session(ctx, session, state, cfg)

    return SessionClock(
        meta.max_minutes,
        publish=_publish_minutes,
        on_warning=_warn,
        on_end=_end,
        is_paused=lambda: state.paused,
        # The arc rides on billed (active) time: one elapsed, not two.
        on_tick=arc.tick,
    )


async def _end_session(
    ctx: JobContext,
    session: AgentSession,
    state: SessionState,
    cfg: TutorConfig,
) -> None:
    """Out of minutes: cut whatever is in flight, say goodbye, disconnect.

    Every step is guarded — the disconnect at the end must happen even if the
    model never says the last line.
    """
    try:
        await session.interrupt()
    except Exception:
        logger.warning("interrupt before goodbye failed", exc_info=True)

    if state.paused:
        # A goodbye into a muted session is a goodbye nobody hears. Output comes
        # back on; input stays off, because the conversation is over.
        state.paused = False
        session.output.set_audio_enabled(True)
        try:
            await ctx.room.local_participant.set_attributes({ATTR_PAUSED: ATTR_FALSE})
        except Exception:
            logger.warning("failed to clear paused attribute at session end", exc_info=True)

    try:
        handle = session.generate_reply(instructions=goodbye_instructions(cfg))
        # Awaiting the handle waits for the audio to finish playing out, which
        # is the whole point: the attribute below means "it's done", and the
        # disconnect after it must not cut the last word.
        await asyncio.wait_for(handle.wait_for_playout(), timeout=GOODBYE_TIMEOUT_S)
    except asyncio.TimeoutError:
        logger.warning("goodbye did not finish within %.0fs; closing anyway", GOODBYE_TIMEOUT_S)
    except Exception:
        logger.exception("goodbye failed")

    try:
        await ctx.room.local_participant.set_attributes({ATTR_SESSION_OVER: ATTR_TRUE})
    except Exception:
        logger.warning("failed to publish session over", exc_info=True)

    try:
        await session.aclose()
    except Exception:
        logger.warning("session close failed", exc_info=True)

    # Leaves the room to the learner (the summary surface is still theirs) and
    # runs the shutdown callbacks, which is where the minutes are reported.
    ctx.shutdown(reason="session minutes exhausted")


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


async def _register_pause_rpc(
    ctx: JobContext,
    session: AgentSession,
    state: SessionState,
    facts: SessionFacts,
    cfg: TutorConfig,
    clock: SessionClock,
    arc: SessionArc,
    analyzer: CorrectionAnalyzer | None,
) -> None:
    """Pause/resume, driven by the frontend's client-side set of holds.

    The frontend collapses overlapping holds (explicit control, correction
    inspection, selection-to-translate, history scroll) and sends exactly one
    pause or resume; the worker only tracks the resulting boolean and mirrors it
    as an attribute. Short glances never arrive here at all — the frontend
    debounces them, because the surface freeze is client-side and instant.
    """

    # The last answer each side gave, so a retry gets the same answer back.
    last_resume_ack = json.dumps({"paused": False, "resumed": False})

    async def _publish_paused(paused: bool) -> None:
        await ctx.room.local_participant.set_attributes(
            {ATTR_PAUSED: ATTR_TRUE if paused else ATTR_FALSE}
        )

    async def _apply(paused: bool) -> bool:
        """Edge-triggered. Returns False when the session was already there.

        The frontend re-sends `tutor.pause` every couple of seconds until it
        observes the paused attribute, so this runs more than once per hold.
        Only the transition may touch the session: a second pause would snapshot
        a session we have already interrupted (recording "nothing was happening"
        over the truth) and re-stamp `paused_at`, and a second resume would fire
        a second `generate_reply`.
        """
        if state.paused == paused:
            # A retry of a transition that already ran. Re-publish the
            # acknowledgement, idempotently: the frontend keeps re-sending until
            # it sees the attribute, and the only way a retry reaches here with
            # the attribute unseen is that the publish itself failed last time.
            await _publish_paused(paused)
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
        await _publish_paused(paused)
        logger.info("session %s", "paused" if paused else "resumed")
        if paused:
            await _flush_open_user_turn(session, state, analyzer, ctx.room)
        return True

    async def _pause(_data: rtc.RpcInvocationData) -> str:
        await _apply(True)
        return json.dumps({"paused": True})

    async def _resume(data: rtc.RpcInvocationData) -> str:
        # A realtime model cannot resume a truncated reply mid-word, and it
        # should not try: a human tutor interrupted mid-thought re-enters
        # ("como decía…") rather than replaying the tape. So instead of
        # restoring audio, we hand the model a short factual brief and let it
        # re-enter with judgment — and only when it actually owes the learner
        # something. If the learner was mid-utterance, resume stays silent and
        # lets them finish.
        nonlocal last_resume_ack
        brief = _parse_brief(data.payload)
        if not await _apply(False):
            # A retry of a resume we already handled: same answer, no second
            # re-entry.
            return last_resume_ack

        # A wrap-up brief that came due during the hold is delivered now, before
        # any re-entry line, so the tutor re-enters already knowing it is
        # closing. No-op unless the one-minute mark passed while paused.
        try:
            await clock.notify_resumed()
        except Exception:
            logger.exception("deferred wrap-up brief failed")

        # Same deferral, same reason: a phase change that came due during the
        # hold is applied now, before any re-entry line is generated.
        try:
            await arc.notify_resumed()
        except Exception:
            logger.exception("deferred arc phase change failed")

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
