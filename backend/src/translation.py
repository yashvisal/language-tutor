"""Live learner-speech translation side-task.

There is no LiveKit plugin for `gpt-realtime-translate`, so this is a raw
WebSocket to OpenAI's realtime translations endpoint, fed from the learner's
audio track and forwarded to the frontend as text streams on the
`tutor.translation` topic.

Two rules govern this module:
  1. It fails soft. Translation going down must never take the session with it.
  2. It produces text only. The translate session also emits audio deltas — we
     discard them; nobody wants spoken English over the tutor.

v0 is learner-only. Tutor-side translation would reuse this same class pointed
at the agent's output track (see the phase-2 plan's open questions).
"""

from __future__ import annotations

import asyncio
import base64
import contextlib
import json
import logging

import aiohttp
from livekit import rtc

from config import TOPIC_TRANSLATION, TutorConfig
from state import SessionState

logger = logging.getLogger("tutor.translation")

SAMPLE_RATE = 24000
NUM_CHANNELS = 1
# 50ms frames, matching what the OpenAI STT plugin sends.
FRAME_MS = 50

_RECONNECT_DELAY = 2.0
_MAX_ATTEMPTS = 3


class TranslationTask:
    """Streams one participant's audio to the translate model and republishes
    the running transcript as text streams."""

    def __init__(
        self,
        *,
        cfg: TutorConfig,
        room: rtc.Room,
        state: SessionState,
        source_lang: str | None = None,
        output_lang: str | None = None,
    ) -> None:
        self._cfg = cfg
        self._room = room
        self._state = state
        self._source_lang = source_lang or cfg.target_lang
        self._output_lang = output_lang or cfg.anchor_lang
        self._task: asyncio.Task[None] | None = None
        self._http: aiohttp.ClientSession | None = None

    def start(self, track: rtc.Track) -> None:
        if not self._cfg.translation_enabled:
            logger.info("translation disabled by config")
            return
        if not self._cfg.openai_api_key:
            logger.warning("OPENAI_API_KEY missing; translation disabled")
            return
        if self._task is not None:
            return
        self._task = asyncio.create_task(self._run_forever(track))

    async def aclose(self) -> None:
        if self._task is not None:
            self._task.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await self._task
            self._task = None
        if self._http is not None:
            await self._http.close()
            self._http = None

    # -- internals ---------------------------------------------------------

    async def _run_forever(self, track: rtc.Track) -> None:
        for attempt in range(1, _MAX_ATTEMPTS + 1):
            try:
                await self._run_once(track)
                return
            except asyncio.CancelledError:
                raise
            except Exception:
                logger.warning(
                    "translation session failed (attempt %d/%d)",
                    attempt,
                    _MAX_ATTEMPTS,
                    exc_info=True,
                )
                if attempt == _MAX_ATTEMPTS:
                    logger.error("translation giving up; session continues without it")
                    return
                await asyncio.sleep(_RECONNECT_DELAY)

    async def _run_once(self, track: rtc.Track) -> None:
        if self._http is None:
            self._http = aiohttp.ClientSession()

        url = f"{self._cfg.translation_url}?model={self._cfg.translation_model}"
        headers = {"Authorization": f"Bearer {self._cfg.openai_api_key}"}

        async with self._http.ws_connect(url, headers=headers) as ws:
            await ws.send_json(self._session_update())
            logger.info("translation session open (%s -> %s)", self._source_lang, self._output_lang)

            send = asyncio.create_task(self._send_audio(ws, track))
            recv = asyncio.create_task(self._recv(ws))
            try:
                done, _ = await asyncio.wait((send, recv), return_when=asyncio.FIRST_COMPLETED)
                for task in done:
                    task.result()
            finally:
                for task in (send, recv):
                    task.cancel()
                await asyncio.gather(send, recv, return_exceptions=True)

    def _session_update(self) -> dict:
        # TODO(wiring): the exact translations-session payload is not covered by
        # public docs yet; verify against a live session and adjust. Failures
        # here surface as an `error` event and are logged, not fatal.
        return {
            "type": "session.update",
            "session": {
                "type": "translation",
                "audio": {
                    "input": {
                        "format": {"type": "audio/pcm", "rate": SAMPLE_RATE},
                        "transcription": {
                            "model": "gpt-live-transcribe",
                            "language": self._source_lang,
                        },
                    },
                    "output": {"language": self._output_lang},
                },
            },
        }

    async def _send_audio(self, ws: aiohttp.ClientWebSocketResponse, track: rtc.Track) -> None:
        stream = rtc.AudioStream.from_track(
            track=track,
            sample_rate=SAMPLE_RATE,
            num_channels=NUM_CHANNELS,
            frame_size_ms=FRAME_MS,
        )
        try:
            async for event in stream:
                if self._state.paused:
                    # Paused means "I am not talking to you" — don't ship the
                    # audio at all, not just the transcript.
                    continue
                audio = base64.b64encode(event.frame.data.tobytes()).decode("utf-8")
                await ws.send_json({"type": "input_audio_buffer.append", "audio": audio})
        finally:
            await stream.aclose()

    async def _recv(self, ws: aiohttp.ClientWebSocketResponse) -> None:
        # One text-stream writer per translated item, closed when the item is done.
        writers: dict[str, rtc.TextStreamWriter] = {}
        try:
            async for msg in ws:
                if msg.type is not aiohttp.WSMsgType.TEXT:
                    continue
                event = json.loads(msg.data)
                await self._handle_event(event, writers)
        finally:
            for writer in writers.values():
                with contextlib.suppress(Exception):
                    await writer.aclose()

    async def _handle_event(self, event: dict, writers: dict[str, rtc.TextStreamWriter]) -> None:
        event_type = event.get("type", "")

        if event_type == "error":
            logger.warning("translate error: %s", event.get("error"))
            return

        # Audio output is explicitly discarded.
        if "audio" in event_type and "transcript" not in event_type:
            return

        if event_type == "session.output_transcript.delta":
            delta = event.get("delta") or ""
            if not delta or self._state.paused:
                return
            item_id = event.get("item_id") or "translation"
            writer = writers.get(item_id)
            if writer is None:
                writer = await self._room.local_participant.stream_text(
                    topic=TOPIC_TRANSLATION,
                    attributes={
                        "tutor.language": self._output_lang,
                        "tutor.source_language": self._source_lang,
                        "tutor.item_id": item_id,
                    },
                )
                writers[item_id] = writer
            await writer.write(delta)
            return

        if event_type == "session.output_transcript.done":
            item_id = event.get("item_id") or "translation"
            writer = writers.pop(item_id, None)
            if writer is not None:
                await writer.aclose()


async def wait_for_audio_track(
    room: rtc.Room, identity: str, *, timeout: float = 30.0
) -> rtc.Track | None:
    """Resolve a participant's subscribed microphone track, or None on timeout.

    RoomIO already subscribes to the learner's audio, so in practice this either
    returns immediately or waits for the subscription to land.
    """

    def _existing() -> rtc.Track | None:
        participant = room.remote_participants.get(identity)
        if participant is None:
            return None
        for publication in participant.track_publications.values():
            if publication.kind == rtc.TrackKind.KIND_AUDIO and publication.track:
                return publication.track
        return None

    track = _existing()
    if track is not None:
        return track

    future: asyncio.Future[rtc.Track] = asyncio.get_running_loop().create_future()

    def _on_subscribed(
        track: rtc.Track,
        _publication: rtc.RemoteTrackPublication,
        participant: rtc.RemoteParticipant,
    ) -> None:
        if (
            not future.done()
            and participant.identity == identity
            and track.kind == rtc.TrackKind.KIND_AUDIO
        ):
            future.set_result(track)

    room.on("track_subscribed", _on_subscribed)
    try:
        return await asyncio.wait_for(future, timeout=timeout)
    except asyncio.TimeoutError:
        logger.warning("no audio track for %s after %.0fs", identity, timeout)
        return None
    finally:
        room.off("track_subscribed", _on_subscribed)
