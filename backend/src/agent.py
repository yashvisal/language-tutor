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

import json
import logging
import time
from dataclasses import dataclass

from dotenv import load_dotenv
from livekit import agents, rtc
from livekit.agents import (
    Agent,
    AgentServer,
    AgentSession,
    JobContext,
    TurnHandlingOptions,
    inference,
    llm,
    room_io,
)
from livekit.plugins import openai

from analyzer import CorrectionAnalyzer, recent_context
from config import (
    AGENT_NAME,
    ANALYZER_OFF,
    ANALYZER_ON,
    ATTR_ANALYZER,
    ATTR_FALSE,
    ATTR_PAUSED,
    ATTR_TRUE,
    RPC_PAUSE,
    RPC_RESUME,
    TutorConfig,
)
from prompts import greeting_instructions, resume_instructions, stt_prompt, tutor_instructions
from state import SessionFacts, SessionState
from translate import SpanTranslator, register_translate_rpc

load_dotenv(".env.local")

logger = logging.getLogger("tutor.agent")


class TutorAgent(Agent):
    """The conversation partner. Analysis happens beside it, never inside it."""

    def __init__(self, cfg: TutorConfig, analyzer: CorrectionAnalyzer | None) -> None:
        super().__init__(instructions=tutor_instructions(cfg))
        self._cfg = cfg
        self._analyzer = analyzer

    # The analyzer trigger. Fires with the full committed turn because turn
    # detection happens agent-side — with model-owned turn detection this node
    # never runs (the reason Grok support was dropped; see config.py).
    async def on_user_turn_completed(
        self, turn_ctx: llm.ChatContext, new_message: llm.ChatMessage
    ) -> None:
        if self._analyzer is None:
            return
        text = (new_message.text_content or "").strip()
        if not text:
            return
        self._analyzer.analyze_in_background(
            turn_id=new_message.id,
            text=text,
            context=recent_context(turn_ctx, exclude_id=new_message.id),
        )


server = AgentServer()


@server.rtc_session(agent_name=AGENT_NAME)
async def tutor(ctx: JobContext) -> None:
    cfg = TutorConfig.from_env()
    state = SessionState()
    facts = SessionFacts()

    logger.info(
        "starting tutor session",
        extra={
            "realtime_model": cfg.realtime_model,
            "target_lang": cfg.target_lang,
            "anchor_lang": cfg.anchor_lang,
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
        ),
    )

    analyzer = CorrectionAnalyzer(cfg, ctx.room, facts) if cfg.analyzer_enabled else None
    translator = SpanTranslator(cfg)

    async def _shutdown() -> None:
        # Every step is guarded and independent: one failing teardown must not
        # strand the ones behind it.
        try:
            await translator.aclose()
        except Exception:
            logger.warning("translator shutdown failed", exc_info=True)
        if analyzer is not None:
            try:
                await analyzer.aclose()
            except Exception:
                logger.warning("analyzer shutdown failed", exc_info=True)

    ctx.add_shutdown_callback(_shutdown)

    await session.start(
        agent=TutorAgent(cfg, analyzer),
        room=ctx.room,
        room_options=room_io.RoomOptions(
            # Text input is off: this is a voice surface, not a chat box.
            text_input=False,
        ),
    )

    await _register_pause_rpc(ctx, session, state, facts)
    await register_translate_rpc(ctx, session, translator)

    # Warm the translate client off the critical path: the first RPC otherwise
    # pays TLS + CA-bundle setup on the learner's first card.
    translator.warm_in_background()

    # Tell the frontend whether corrections are coming at all, so it can skip
    # the analyzing phase entirely when the analyzer is off.
    await ctx.room.local_participant.set_attributes(
        {ATTR_ANALYZER: ANALYZER_ON if cfg.analyzer_enabled else ANALYZER_OFF}
    )

    await session.generate_reply(instructions=greeting_instructions(cfg))


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

    def __init__(self, raw: dict | None = None) -> None:
        raw = raw if isinstance(raw, dict) else {}
        self.present = bool(raw)
        self.held_ms = _coerce_number(raw.get("held_ms"))
        self.reasons = _coerce_reasons(raw.get("reasons"))
        self.correction = _coerce_correction(raw.get("correction"))


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

    if brief.correction is not None:
        original, replacement, category = brief.correction
        suffix = f" (a {category} correction)" if category else ""
        lines.append(
            f'they read a correction on their last turn: "{original}" -> "{replacement}"{suffix}'
        )

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
    ctx: JobContext, session: AgentSession, state: SessionState, facts: SessionFacts
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
            return False
        state.paused = paused
        if paused:
            # Read the session's state *before* interrupting it — afterwards
            # there is nothing left to observe.
            _capture_pause_context(session, state)
            # Stop the tutor mid-sentence, then go deaf and mute.
            #
            # Deliberately *not* `clear_user_turn()`: a hold is often opened
            # mid-utterance (the learner taps a correction, or scrolls back,
            # while still speaking), and discarding the buffered turn would
            # throw away what they had just said. Disabling the audio input
            # already stops new audio from arriving; what was already said stays
            # in the turn and settles normally on resume.
            await session.interrupt()
            session.input.set_audio_enabled(False)
            session.output.set_audio_enabled(False)
        else:
            session.input.set_audio_enabled(True)
            session.output.set_audio_enabled(True)

        await ctx.room.local_participant.set_attributes(
            {ATTR_PAUSED: ATTR_TRUE if paused else ATTR_FALSE}
        )
        logger.info("session %s", "paused" if paused else "resumed")
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

        try:
            if not brief.present or not state.tutor_owes_reentry:
                last_resume_ack = json.dumps({"paused": False, "resumed": False})
                return last_resume_ack

            lines = _resume_facts(state, facts, brief)
            try:
                session.generate_reply(instructions=resume_instructions(lines))
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
    agents.cli.run_app(server)
