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

from analyzer import AnalysisContextTurn, CorrectionAnalyzer
from config import AGENT_NAME, ATTR_PAUSED, TutorConfig
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
    turn_ctx: llm.ChatContext, *, exclude_id: str, limit: int = 10
) -> list[AnalysisContextTurn]:
    """Flatten the chat context into speaker-tagged lines for the analyzer."""
    turns: list[AnalysisContextTurn] = []
    for item in turn_ctx.items:
        if getattr(item, "type", None) != "message":
            continue
        if item.id == exclude_id:
            continue
        text = (item.text_content or "").strip()
        if not text:
            continue
        speaker = "learner" if item.role == "user" else "tutor"
        turns.append(AnalysisContextTurn(speaker=speaker, text=text))
    return turns[-limit:]


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

    async def _shutdown() -> None:
        await translation.aclose()
        if analyzer is not None:
            await analyzer.aclose()

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

    participant = await ctx.wait_for_participant()
    track = await wait_for_audio_track(ctx.room, participant.identity)
    if track is not None:
        translation.start(track)

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
            # Stop mid-sentence, drop whatever was buffered, go deaf and mute.
            await session.interrupt()
            session.clear_user_turn()
            session.input.set_audio_enabled(False)
            session.output.set_audio_enabled(False)
        else:
            session.input.set_audio_enabled(True)
            session.output.set_audio_enabled(True)

        await ctx.room.local_participant.set_attributes(
            {ATTR_PAUSED: "true" if paused else "false"}
        )
        logger.info("session %s", "paused" if paused else "resumed")

    async def _pause(_data: rtc.RpcInvocationData) -> str:
        await _apply(True)
        return json.dumps({"paused": True})

    async def _resume(_data: rtc.RpcInvocationData) -> str:
        await _apply(False)
        return json.dumps({"paused": False})

    ctx.room.local_participant.register_rpc_method("tutor.pause", _pause)
    ctx.room.local_participant.register_rpc_method("tutor.resume", _resume)

    # Publish the initial state so a client that joins (or rejoins) mid-session
    # renders the right thing without asking.
    await ctx.room.local_participant.set_attributes({ATTR_PAUSED: "false"})


if __name__ == "__main__":
    agents.cli.run_app(server)
