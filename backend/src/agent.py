"""LiveKit Agents worker for the language tutor.

Pipeline (see plans/phases/phase-2-live-pipeline.md):

    realtime speech-to-speech model   <- swappable: xai | openai
  + parallel STT (gpt-live-transcribe) -> live target-language transcripts
  + LiveKit audio turn detector        -> identical turn-taking across models
  + translation side-task              -> lagging anchor-language text
  + on_user_turn_completed             -> background analyzer -> corrections

Run with `lk agent dev` (or `uv run python src/agent.py dev`).
"""

from __future__ import annotations

import asyncio
import json
import logging

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

from analyzer import CONTEXT_TURNS, AnalysisContextTurn, CorrectionAnalyzer
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
from prompts import greeting_instructions, stt_prompt, tutor_instructions
from state import SessionState
from translation import TranslationTask, wait_for_audio_track

load_dotenv(".env.local")

logger = logging.getLogger("tutor.agent")


class TutorAgent(Agent):
    """The conversation partner. Analysis happens beside it, never inside it."""

    def __init__(self, cfg: TutorConfig, analyzer: CorrectionAnalyzer | None) -> None:
        super().__init__(instructions=tutor_instructions(cfg))
        self._cfg = cfg
        self._analyzer = analyzer

    async def on_user_turn_completed(
        self, turn_ctx: llm.ChatContext, new_message: llm.ChatMessage
    ) -> None:
        if self._analyzer is None:
            return

        text = (new_message.text_content or "").strip()
        if not text:
            return

        # Fire and forget: the tutor's reply is generated the moment this
        # returns, and must not wait on the analyzer.
        self._analyzer.analyze_in_background(
            turn_id=new_message.id,
            text=text,
            context=_recent_context(turn_ctx, exclude_id=new_message.id),
        )


def _recent_context(
    turn_ctx: llm.ChatContext, *, exclude_id: str, limit: int = CONTEXT_TURNS
) -> list[AnalysisContextTurn]:
    """The last `limit` messages of the chat context, as speaker-tagged lines.

    `limit` defaults to the analyzer's own `CONTEXT_TURNS`, which is the single
    knob for how much history the analyzer sees: the truncation happens here,
    once, and the analyzer sends what it is given. Walking backwards means a
    long lesson's full history is never flattened just to throw most of it away.
    """
    turns: list[AnalysisContextTurn] = []
    for item in reversed(turn_ctx.items):
        if len(turns) >= limit:
            break
        if getattr(item, "type", None) != "message":
            continue
        if item.id == exclude_id:
            continue
        text = (item.text_content or "").strip()
        if not text:
            continue
        speaker = "learner" if item.role == "user" else "tutor"
        turns.append(AnalysisContextTurn(speaker=speaker, text=text))
    turns.reverse()
    return turns


server = AgentServer()


@server.rtc_session(agent_name=AGENT_NAME)
async def tutor(ctx: JobContext) -> None:
    cfg = TutorConfig.from_env()
    state = SessionState()

    logger.info(
        "starting tutor session",
        extra={
            "realtime_provider": cfg.realtime_provider,
            "target_lang": cfg.target_lang,
            "anchor_lang": cfg.anchor_lang,
        },
    )

    session: AgentSession = AgentSession(
        # Swappable speech-to-speech core (TUTOR_REALTIME_MODEL).
        llm=cfg.build_realtime_model(),
        # Parallel STT owns every transcript the UI shows. Both languages are
        # listed because code-switching is expected in a tutoring session.
        stt=openai.STT(
            model=cfg.stt_model,
            language=[cfg.target_lang, cfg.anchor_lang],
            prompt=stt_prompt(cfg),
        ),
        # LiveKit's audio turn detector rather than either model's server-side
        # VAD, so turn-taking feels identical whichever realtime model is on.
        turn_handling=TurnHandlingOptions(turn_detection=inference.TurnDetector()),
    )

    analyzer = CorrectionAnalyzer(cfg, ctx.room) if cfg.analyzer_enabled else None
    translation = TranslationTask(cfg=cfg, room=ctx.room, state=state)
    wiring_task: asyncio.Task[None] | None = None

    async def _shutdown() -> None:
        # Every step is guarded and independent: one failing teardown must not
        # strand the ones behind it (a leaked socket outlives the job).
        if wiring_task is not None:
            wiring_task.cancel()
            try:
                await wiring_task
            except asyncio.CancelledError:
                pass
            except Exception:
                logger.warning("translation wiring failed during shutdown", exc_info=True)
        try:
            await translation.aclose()
        except Exception:
            logger.warning("translation shutdown failed", exc_info=True)
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

    await _register_pause_rpc(ctx, session, state)

    # Tell the frontend whether corrections are coming at all, so it can skip
    # the analyzing phase entirely when the analyzer is off.
    await ctx.room.local_participant.set_attributes(
        {ATTR_ANALYZER: ANALYZER_ON if cfg.analyzer_enabled else ANALYZER_OFF}
    )

    # Greet first, wire translation second. Resolving the participant and their
    # microphone track can take seconds (or the full 30s timeout if the mic is
    # slow or denied), and none of that should stand between the learner
    # arriving and the tutor saying hello. Translation lagging the greeting by a
    # few seconds is invisible; a silent session is not.
    async def _start_translation() -> None:
        participant = await ctx.wait_for_participant()
        track = await wait_for_audio_track(ctx.room, participant.identity)
        if track is not None:
            translation.start(track)

    def _on_wiring_done(task: asyncio.Task[None]) -> None:
        # Translation is fail-soft, but it must fail *loudly*: without this the
        # exception is only surfaced as asyncio's "never retrieved" noise at GC.
        if task.cancelled():
            return
        exc = task.exception()
        if exc is not None:
            logger.warning("translation wiring failed", exc_info=exc)

    # Held on a local so the shutdown callback can cancel it cleanly.
    wiring_task = asyncio.create_task(_start_translation())
    wiring_task.add_done_callback(_on_wiring_done)

    await session.generate_reply(instructions=greeting_instructions(cfg))


async def _register_pause_rpc(ctx: JobContext, session: AgentSession, state: SessionState) -> None:
    """Pause/resume, driven by the frontend's client-side set of holds.

    The frontend collapses overlapping holds (explicit control, correction
    inspection, history scroll) and sends exactly one pause or resume; the
    worker only tracks the resulting boolean and mirrors it as an attribute.
    """

    async def _apply(paused: bool) -> None:
        state.paused = paused
        if paused:
            # Stop the tutor mid-sentence, then go deaf and mute.
            #
            # Deliberately *not* `clear_user_turn()`: a hold is often opened
            # mid-utterance (the learner taps a correction, or scrolls back,
            # while still speaking), and discarding the buffered turn would
            # throw away what they had just said. Disabling the audio input
            # already stops new audio from arriving; what was already said stays
            # in the turn and settles normally on resume.
            #
            # Known gap: a realtime model cannot resume a truncated reply
            # mid-utterance, so resuming after we interrupt the tutor can leave
            # a beat of dead air until the learner speaks again. Interrupting is
            # still the right call — a tutor that keeps talking through a pause
            # is worse — but the resume behaviour is a product decision to
            # revisit with live testing.
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

    async def _pause(_data: rtc.RpcInvocationData) -> str:
        await _apply(True)
        return json.dumps({"paused": True})

    async def _resume(_data: rtc.RpcInvocationData) -> str:
        await _apply(False)
        return json.dumps({"paused": False})

    ctx.room.local_participant.register_rpc_method(RPC_PAUSE, _pause)
    ctx.room.local_participant.register_rpc_method(RPC_RESUME, _resume)

    # Publish the initial state so a client that joins (or rejoins) mid-session
    # renders the right thing without asking.
    await ctx.room.local_participant.set_attributes({ATTR_PAUSED: ATTR_FALSE})


if __name__ == "__main__":
    agents.cli.run_app(server)
