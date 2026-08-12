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
import time

import aiohttp
from livekit import rtc

from config import (
    ATTR_ITEM_ID,
    ATTR_LANGUAGE,
    ATTR_SOURCE_LANGUAGE,
    TOPIC_TRANSLATION,
    TutorConfig,
)
from state import SessionState

logger = logging.getLogger("tutor.translation")

SAMPLE_RATE = 24000
NUM_CHANNELS = 1
# 50ms frames, matching what the OpenAI STT plugin sends.
FRAME_MS = 50

# Reconnect policy. A translate session ends for boring reasons all the time —
# server-side idle timeout, session length cap — and those closes are *clean*,
# so they must be retried like any other, or translation quietly dies for the
# rest of a long lesson.
_RECONNECT_DELAY = 2.0
_MAX_BACKOFF = 30.0
# Consecutive failures before the reconnect chatter is promoted to warning.
_NOISY_AFTER_FAILURES = 3
# A connection that stayed up this long counts as healthy: the failure budget
# resets, so three transient blips spread over an hour don't add up to a
# permanent give-up.
_HEALTHY_AFTER = 60.0
# WebSocket ping interval; a missing PONG closes the socket instead of hanging.
_HEARTBEAT = 20.0

# Event types from the translations session we act on. Anything else is
# unknown and logged once — API evolution should be loud, not silent.
_EVENT_TRANSCRIPT_DELTA = "session.output_transcript.delta"
_EVENT_TRANSCRIPT_DONE = "session.output_transcript.done"
_EVENT_ERROR = "error"
# The translate session also speaks the translation. We only want text, so the
# audio events are dropped on purpose (both the `session.*` and `response.*`
# spellings, since the endpoint is still in flux).
_AUDIO_EVENTS = frozenset(
    {
        "session.output_audio.delta",
        "session.output_audio.done",
        "response.output_audio.delta",
        "response.output_audio.done",
    }
)


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
        self._stopped = False
        # Unknown event types we have already complained about, so a chatty
        # new event doesn't flood the log.
        self._logged_unknown: set[str] = set()

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
        self._stopped = True
        if self._task is not None:
            self._task.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await self._task
            self._task = None
        if self._http is not None:
            await self._http.close()
            self._http = None

    # -- internals ---------------------------------------------------------

    def _track_alive(self, track: rtc.Track) -> bool:
        """True while the source track is still published and subscribed.

        Once the learner's mic goes away there is nothing left to translate, so
        the supervisor stops rather than reconnecting into an empty socket.
        """
        for participant in self._room.remote_participants.values():
            for publication in participant.track_publications.values():
                if publication.track is not None and publication.track.sid == track.sid:
                    return True
        return False

    async def _run_forever(self, track: rtc.Track) -> None:
        """Supervise the translate socket for the life of the lesson.

        A clean close is not success: the server ends idle or over-long sessions
        by design, and each one is just a reconnect. We only stop for good when
        the task is closed or the source track disappears.
        """
        failures = 0
        while not self._stopped and self._track_alive(track):
            started = time.monotonic()
            try:
                await self._run_once(track)
            except asyncio.CancelledError:
                raise
            except Exception:
                connected_for = time.monotonic() - started
                if connected_for >= _HEALTHY_AFTER:
                    # The connection was healthy for a good while; this is a new
                    # problem, not an escalating one.
                    failures = 0
                failures += 1
                delay = min(_RECONNECT_DELAY * 2 ** (failures - 1), _MAX_BACKOFF)
                log = logger.warning if failures >= _NOISY_AFTER_FAILURES else logger.info
                log(
                    "translation session failed (%d in a row); reconnecting in %.0fs",
                    failures,
                    delay,
                    exc_info=True,
                )
            else:
                # Clean close (idle timeout, session cap). Reconnect promptly.
                if time.monotonic() - started >= _HEALTHY_AFTER:
                    failures = 0
                logger.info("translation session closed cleanly; reconnecting")
                delay = _RECONNECT_DELAY

            if self._stopped or not self._track_alive(track):
                break
            await asyncio.sleep(delay)

        if self._stopped:
            logger.info("translation supervisor stopped")
        else:
            logger.warning("translation source track gone; session continues without translation")

    async def _run_once(self, track: rtc.Track) -> None:
        if self._http is None:
            self._http = aiohttp.ClientSession()

        url = f"{self._cfg.translation_url}?model={self._cfg.translation_model}"
        headers = {"Authorization": f"Bearer {self._cfg.openai_api_key}"}

        # `heartbeat` is what makes a *dead* connection fail: without a PING the
        # socket can hang open forever with no traffic, and `_recv` would just
        # wait instead of letting the supervisor reconnect.
        async with self._http.ws_connect(url, headers=headers, heartbeat=_HEARTBEAT) as ws:
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
            # Deliberately not `async for msg in ws`: that iterator ends on a
            # close frame *and* silently on an error, so a broken endpoint would
            # look like a clean close and retry at the fixed 2s delay forever.
            while True:
                msg = await ws.receive()
                if msg.type is aiohttp.WSMsgType.ERROR:
                    exc = ws.exception()
                    if exc is not None:
                        raise exc
                    raise RuntimeError("translate websocket error")
                if msg.type in (
                    aiohttp.WSMsgType.CLOSE,
                    aiohttp.WSMsgType.CLOSING,
                    aiohttp.WSMsgType.CLOSED,
                ):
                    # Clean close (idle timeout, session cap): let the
                    # supervisor reconnect promptly.
                    break
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

        if event_type == _EVENT_TRANSCRIPT_DELTA:
            delta = event.get("delta") or ""
            if not delta or self._state.paused:
                return
            item_id = event.get("item_id") or "translation"
            writer = writers.get(item_id)
            if writer is None:
                writer = await self._room.local_participant.stream_text(
                    topic=TOPIC_TRANSLATION,
                    attributes={
                        ATTR_LANGUAGE: self._output_lang,
                        ATTR_SOURCE_LANGUAGE: self._source_lang,
                        ATTR_ITEM_ID: item_id,
                    },
                )
                writers[item_id] = writer
            await writer.write(delta)
            return

        if event_type == _EVENT_TRANSCRIPT_DONE:
            item_id = event.get("item_id") or "translation"
            writer = writers.pop(item_id, None)
            if writer is not None:
                await writer.aclose()
            return

        if event_type == _EVENT_ERROR:
            logger.warning("translate error: %s", event.get("error"))
            return

        if event_type in _AUDIO_EVENTS:
            # Spoken translation, deliberately dropped: nobody wants English
            # over the tutor's voice.
            return

        # Anything else is an event this code was not written against. Matching
        # on substrings here used to swallow those silently; now the first one
        # of each type says so.
        if event_type not in self._logged_unknown:
            self._logged_unknown.add(event_type)
            logger.info("unhandled translate event type %r", event_type)


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

    # Handler first, snapshot second. The other order drops a subscription that
    # lands in between, and the wait then burns its full timeout for a track
    # that is already there. `future.done()` de-duplicates if both fire.
    room.on("track_subscribed", _on_subscribed)
    try:
        track = _existing()
        if track is not None:
            return track
        return await asyncio.wait_for(future, timeout=timeout)
    except asyncio.TimeoutError:
        logger.warning("no audio track for %s after %.0fs", identity, timeout)
        return None
    finally:
        room.off("track_subscribed", _on_subscribed)
