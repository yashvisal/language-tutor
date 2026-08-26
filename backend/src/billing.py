"""The money seam: the worker reports seconds, Convex owns the ledger.

Three authenticated HTTP calls, all against `CONVEX_SITE_URL`, all bearing a
Clerk machine-to-machine JWT the worker mints once per job (see "auth" below):

- `POST /tutor/debit` — "this ROOM has used N cumulative active seconds so
  far". The action is idempotent per `ref = <room>:<jobId>:<seq>` and debits
  only the delta above the room's high-water mark, so the worker never has to
  remember what it already reported: it always sends the running total and lets
  the ledger difference it. Returns the learner's balance after the debit.
  The teardown debit — and only that one — carries `final: true`, which is what
  closes the session row (`endedAt`) on the Convex side; a periodic or
  zero-hold debit must leave it open, or a purchase could not resume the same
  conversation.
- `POST /tutor/summary` — "here is what this conversation WAS". One line about
  what was actually talked about, the transcript, and the session's Review
  material, posted once at teardown so the after-session summary and the
  History modal render the same record instead of losing everything when the
  tab closes (phase 7 step 2). Order-independent with the final debit: the
  Convex side upserts onto the session row either way.
- `POST /tutor/balance` — "what is this learner's balance now, and what has
  this room already been billed?". Read once at job start (to seed the
  room-cumulative total, and to budget the clock from a number nobody signed
  into dispatch metadata), and again when a session held at zero is resumed,
  which is how a purchase mid-session continues the same conversation.

The wire is camelCase (`userId`, `jobId`, `balanceSeconds`, `secondsBilled`) —
it is Convex's shape, and Convex owns the ledger.

**Room-cumulative, not job-cumulative** (audit B3, 2026-08-25). A LiveKit
redispatch after a crash starts a second job whose clock begins at zero. If the
worker reported only its own active seconds, every report in the second job
would sit below the room's high-water mark and the delta would be zero — the
whole second conversation free. So the job reads `secondsBilled` for the room
at start, keeps it as `billed_before`, and every debit reports
`billed_before + active`. The job id in the ref keeps two jobs' refs from
colliding.

Four rules hold here:

- **Billing never raises into the session.** Every failure is caught and
  logged. A learner mid-sentence must not lose the conversation because a
  ledger write timed out; the periodic debit and the teardown report are the
  backstops, and the debit is idempotent, so a lost call costs at most one
  un-debited delta.
- **Debits are serialized.** One lock around the whole call, so the periodic
  debit, the zero-hold debit and the teardown debit can never interleave and
  send their totals out of order.
- **Bounded, always.** A hung Convex must not hold the hold, the resume, or
  the worker's shutdown.
- **No learner id, no HTTP.** A session dispatched without a `user_id` (which
  the token route should make impossible, and which the worker now refuses
  outright unless `TUTOR_ALLOW_UNMETERED=1`) reports nothing.

**Auth is Clerk M2M** (decision 2026-08-25, phase 7 step 1), replacing the
shared `TUTOR_DEBIT_SECRET`. At job start the worker POSTs its machine secret
key (`CLERK_WORKER_MACHINE_SECRET_KEY`, kept in the worker's environment and
never logged) to `POST $CLERK_API_URL/v1/m2m_tokens` with
`{token_format: "jwt", seconds_until_expiration: 10800}`, and sends the JWT it
gets back as the bearer on every `/tutor/*` call. Convex verifies it offline
against the instance's JWKS and checks both ends — subject is the worker
machine, scopes include the ledger machine — so a leaked bearer is a three-hour
window on one machine's identity rather than a forever-secret. A **401 re-mints
once and retries that call**; a token minted at 00:00 on a four-hour session
expires under it, and the re-mint is what carries it through.

**The failure ceiling.** A debit that does not land is revenue on the floor,
but a worker that retries forever is worse: that is how a job runs for hours
unbilled with nothing paging. So consecutive debit failures are counted (any
non-200, any timeout, any exception; one success resets the count), and at
`MAX_CONSECUTIVE_DEBIT_FAILURES` the client stops debiting and calls the
ceiling handler, which holds the clock and ends the session. The consequence is
accepted and deliberate (Yash, 2026-08-25): the teardown debit of that session
does not go out either, so its last ~5 minutes never bill and Convex's
reconciliation cron closes the row. Bounded, learner-favouring, and **not** a
retry loop that keeps the job alive.

The balance read is outside the count on purpose: the only balance read that
can fail into a running session is the one at job start, and that already
refuses the job (`agent._open_ledger`).
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
from collections.abc import Awaitable, Callable
from dataclasses import dataclass

import aiohttp

logger = logging.getLogger("tutor.billing")

# Bounded twice: a per-request total, and a shorter connect timeout so an
# unreachable host fails fast rather than sitting on the whole budget.
REQUEST_TIMEOUT_S = 5.0
CONNECT_TIMEOUT_S = 2.0

DEBIT_PATH = "/tutor/debit"
BALANCE_PATH = "/tutor/balance"
SUMMARY_PATH = "/tutor/summary"

# Clerk's machine-to-machine token endpoint, and the shape of the one request
# the worker makes against it. Overridable only for tests and for a Clerk
# instance on another host; there is no second API in practice.
CLERK_API_URL_DEFAULT = "https://api.clerk.com"
MINT_PATH = "/v1/m2m_tokens"
# Three hours. Long enough that the overwhelming majority of sessions never
# re-mint; short enough that a leaked JWT — which cannot be revoked
# individually, only by rotating the machine key — expires on its own.
TOKEN_TTL_S = 10800
# The mint sits in front of the job's first ledger call, so it is bounded like
# every other call on this seam.
MINT_TIMEOUT_S = 5.0

# How many consecutive failed debits end the session. Five at the 60s cadence
# is about five minutes of a ledger that cannot be reached — long enough to
# ride out a deploy or a blip, short enough that nothing runs unbilled for an
# hour. See the module docstring for what is knowingly given up here.
MAX_CONSECUTIVE_DEBIT_FAILURES = 5

# How much of a rejected response body is logged. Enough to read Convex's
# reason (the 400 for a >3600s delta says so in words); short enough that a
# hostile or broken endpoint cannot flood the logs.
MAX_ERROR_BODY_CHARS = 300


class _Unauthorized:
    """Sentinel: the ledger answered 401, so the token may simply be stale."""


UNAUTHORIZED = _Unauthorized()

# The summary's bounds, all of them the wire contract's (phase 7 step 2), and
# all re-applied here because the ledger answers 400 and the whole record is
# lost. The transcript keeps the MOST RECENT turns: a two-hour session's last
# 200 turns are what "what were we just doing" means, and the `about` line
# already carries the shape of the whole thing.
MAX_ABOUT_CHARS = 200
MAX_TRANSCRIPT_TURNS = 200
MAX_TURN_CHARS = 500
MAX_BODY_BYTES = 256 * 1024

# The review snapshot's bounds. The worker generates far fewer than the first
# three allow (16 vocab, 12 phrases) but up to TWELVE tables, and the ledger
# takes eight — so this is not a formality: an unbounded review would 400 the
# whole record, transcript and all.
MAX_REVIEW_VOCAB = 40
MAX_REVIEW_PHRASES = 40
MAX_REVIEW_TABLES = 8
MAX_TABLE_ROWS = 12
MAX_REVIEW_ITEM_CHARS = 200

# The corrections the analyzer published this session, as Convex's backstop for
# a tab that closed before its `finish` ran. Same element shape the analyzer
# sends the client (`analyzer.py:_validate`).
MAX_CORRECTIONS = 200
MAX_CORRECTION_CHARS = 500
CORRECTION_FIELDS = ("id", "original", "replacement", "category", "severity", "explanation")

# What the conversation was FOR, and the evidence of what it became (phase 7
# step 3). Same rule as everything above: the ledger's bounds, re-applied here,
# because a field that is too long costs the whole record.
MAX_GOAL_CHARS = 200
MAX_GOAL_FORMS = 8
MAX_GOAL_FORM_CHARS = 60
GOAL_SOURCES = ("plan", "tool", "extracted")
MAX_ASKS = 25
MAX_ASK_CHARS = 400
MAX_LOOKUPS = 100
MAX_LOOKUP_CHARS = 200

# Why the session ended, sent with the final debit and only with it. Every
# ending path in `agent.py` maps to exactly one of these; `ended` is the
# teardown default (the learner left the page, or the job simply finished), and
# History renders the difference between that and a crash.
END_REASONS = (
    "ended",
    "out_of_minutes_idle",
    "hold_idle",
    "learner_left",
    "model_error",
    "ledger_failure",
    "tutor_silent",
)
DEFAULT_END_REASON = "ended"

# The ledger's own ceiling on a single report (24h). Clamped here so a clock
# that somehow ran away is a 200 with a wrong number rather than a 400 and no
# debit at all.
MAX_SECONDS = 24 * 60 * 60


@dataclass(frozen=True)
class BalanceRead:
    """What `/tutor/balance` answers.

    `balance_seconds` is the learner's spendable balance; `seconds_billed` is
    this room's already-billed high-water mark (0 when the room is new).
    """

    balance_seconds: int
    seconds_billed: int


class BillingClient:
    """The Convex ledger's client for one job.

    Owns three things: the debit sequence number, the room's already-billed
    total (`billed_before`), and whether the zero-hold debit was ever
    acknowledged.
    """

    def __init__(
        self,
        *,
        room: str,
        user_id: str | None,
        job_id: str = "",
        site_url: str | None = None,
        machine_key: str | None = None,
        clerk_api_url: str | None = None,
    ) -> None:
        self._room = room
        self._user_id = user_id
        # The ledger bounds it at 128 characters; a LiveKit job id is far
        # shorter, but a 400 here would cost a whole session's revenue.
        self._job_id = (job_id or "")[:128]
        if site_url is None:
            site_url = os.environ.get("CONVEX_SITE_URL", "")
        self._site_url = site_url.strip().rstrip("/")
        # The worker's Clerk machine secret key (`ak_...`). It never goes
        # anywhere but Clerk's mint endpoint, and it is never logged.
        self._machine_key = (
            machine_key
            if machine_key is not None
            else os.environ.get("CLERK_WORKER_MACHINE_SECRET_KEY", "")
        ).strip()
        if clerk_api_url is None:
            clerk_api_url = os.environ.get("CLERK_API_URL", "") or CLERK_API_URL_DEFAULT
        self._clerk_api_url = clerk_api_url.strip().rstrip("/") or CLERK_API_URL_DEFAULT
        # The minted JWT for this job. One per job, re-minted only on a 401.
        self._token: str | None = None
        self._mint_lock = asyncio.Lock()
        # The failure ceiling. `_consecutive_failures` counts debits only;
        # `_ceiling_reached` is one-way and stops the seam dead.
        self._consecutive_failures = 0
        self._ceiling_reached = False
        self._on_ceiling: Callable[[], Awaitable[None]] | None = None
        self._seq = 0
        # Why this session ended, reported on the final debit. Set by the
        # ending paths as they run; the default is the ordinary end.
        self._end_reason = DEFAULT_END_REASON
        # The room's high-water mark before this job started. Set once, at job
        # start, from the balance read — never refreshed, because every later
        # read already contains this job's own debits.
        self._billed_before = 0
        # Seconds the zero hold tried and failed to debit. While this is set,
        # the session must not be resumed on a balance that still contains them
        # (audit §3.1.6: the same seconds would be spent twice).
        self._unacked_zero_s: int | None = None
        self._lock = asyncio.Lock()
        self._session: aiohttp.ClientSession | None = None

    @property
    def enabled(self) -> bool:
        """Whether this session can talk to the ledger at all."""
        return bool(self._user_id and self._site_url and self._machine_key)

    @property
    def ceiling_reached(self) -> bool:
        """True once consecutive debit failures ended the session's billing."""
        return self._ceiling_reached

    @property
    def consecutive_failures(self) -> int:
        return self._consecutive_failures

    def set_ceiling_handler(self, handler: Callable[[], Awaitable[None]] | None) -> None:
        """What to do when the debits stop landing: hold the clock, end it.

        Set after construction because the client is built before the session
        it will have to end. Called at most once, and outside the debit lock —
        the handler ends the session, whose teardown debits, and an asyncio
        lock is not reentrant.
        """
        self._on_ceiling = handler

    def set_end_reason(self, reason: str, *, weak: bool = False) -> None:
        """Record why the session is ending, for the final debit.

        `weak=True` is for a path that only SUSPECTS an ending — the
        first-audio watchdog, which fires on a silent stage that may still
        recover — and never overwrites a reason an actual ending already set.
        An unknown code is ignored rather than sent: the ledger validates the
        enum and a 400 would cost the closing debit.
        """
        if reason not in END_REASONS:
            logger.warning("ignoring an unknown end reason %r", reason)
            return
        if weak and self._end_reason != DEFAULT_END_REASON:
            return
        self._end_reason = reason

    @property
    def end_reason(self) -> str:
        return self._end_reason

    @property
    def billed_before(self) -> int:
        return self._billed_before

    @property
    def zero_debit_unacked(self) -> bool:
        """True when the zero-hold debit failed and has not been made good."""
        return self._unacked_zero_s is not None

    def set_billed_before(self, seconds: int) -> None:
        """Seed the room's already-billed total, once, at job start."""
        self._billed_before = int(max(0, seconds))

    async def aclose(self) -> None:
        session = self._session
        self._session = None
        if session is not None:
            try:
                await session.close()
            except Exception:
                logger.debug("billing client close failed (harmless)", exc_info=True)

    # --- the two calls ---------------------------------------------------

    async def debit(
        self, active_seconds: int, *, zero_hold: bool = False, final: bool = False
    ) -> int | None:
        """Report this job's active seconds. Returns the learner's balance.

        The number that goes on the wire is ROOM-cumulative:
        `billed_before + active_seconds`, clamped to the ledger's ceiling.

        `final=True` is the teardown report and nothing else: it closes the
        session row, which is what lets a learner whose worker crashed start a
        new conversation instead of waiting out the one-open-session window.

        `None` means the call did not happen or did not succeed — never an
        exception, and never a reason to change what the session is doing.

        Except once. Five consecutive failures trip the ceiling: this call
        stops debiting for good and hands the session to the ceiling handler,
        because the alternative — retrying every minute for the rest of a
        two-hour conversation — is a worker running unbilled with nobody
        looking. After that every call here returns `None` without a request,
        including the teardown's, which is the accepted under-bill.
        """
        if not self.enabled:
            return None
        if self._ceiling_reached:
            # Deliberately silent-ish: the ERROR was logged when the ceiling
            # tripped, and the teardown path calls this twice on the way out.
            logger.debug("debit skipped: the ledger failure ceiling was reached")
            return None
        active = int(max(0, active_seconds))
        tripped = False
        async with self._lock:
            self._seq += 1
            seq = self._seq
            seconds = min(self._billed_before + active, MAX_SECONDS)
            payload: dict = {
                "room": self._room,
                "userId": self._user_id,
                "jobId": self._job_id,
                "seconds": seconds,
                "seq": seq,
            }
            if final:
                payload["final"] = True
                # Only with `final` (the wire contract): a periodic debit has
                # no reason to carry, because nothing has ended.
                payload["reason"] = self._end_reason
            balance = await self._post(DEBIT_PATH, payload)
            if balance is None:
                self._consecutive_failures += 1
                # ERROR, not warning: a debit that does not land is revenue on
                # the floor, and nothing downstream notices (audit B10).
                logger.error(
                    "debit failed",
                    extra={
                        "seq": seq,
                        "seconds": seconds,
                        "jobId": self._job_id,
                        "consecutive_failures": self._consecutive_failures,
                    },
                )
                if zero_hold:
                    self._unacked_zero_s = active
                if self._consecutive_failures >= MAX_CONSECUTIVE_DEBIT_FAILURES:
                    self._ceiling_reached = True
                    tripped = True
            else:
                # One landed call means the seam is alive; the count starts over.
                self._consecutive_failures = 0
                if self._unacked_zero_s is not None:
                    # Any successful debit reports a total that covers the
                    # seconds the zero hold failed to report: debt settled.
                    self._unacked_zero_s = None
                logger.info(
                    "debit reported",
                    extra={"seq": seq, "seconds": seconds, "balance_s": balance},
                )
        if tripped:
            # Outside the lock: the handler ends the session, whose teardown
            # calls back into `debit`.
            await self._fire_ceiling()
        return balance

    async def _fire_ceiling(self) -> None:
        logger.error(
            "the ledger failure ceiling was reached: holding the clock and ending "
            "the session. This session's remaining seconds will not be billed; "
            "the Convex reconciliation cron closes the row.",
            extra={
                "room": self._room,
                "jobId": self._job_id,
                "consecutive_failures": self._consecutive_failures,
            },
        )
        handler = self._on_ceiling
        if handler is None:
            return
        try:
            await handler()
        except Exception:
            logger.exception("the ledger ceiling handler failed")

    async def summary(
        self,
        *,
        about: str | None = None,
        transcript: list[dict[str, str]] | None = None,
        review: dict[str, object] | None = None,
        corrections: list[dict[str, str]] | None = None,
        goal: dict[str, object] | None = None,
        turns: int | None = None,
        anchor_ratio: float | None = None,
        asks: list[str] | None = None,
        lookups: list[dict[str, str]] | None = None,
    ) -> bool:
        """Post this session's record. Returns whether the ledger took it.

        Serialized on the same lock as the debits — the teardown posts both,
        and a summary must never sit between a debit and its own sequence
        number. Everything is optional: a session whose `about` call failed and
        whose Review never became ready still posts its transcript, and a
        session with nothing at all posts nothing and says so.

        Never raises. A lost summary costs a History entry, not a session.
        """
        if not self.enabled:
            return False
        payload: dict = {"room": self._room, "userId": self._user_id, "jobId": self._job_id}
        if about:
            payload["about"] = " ".join(about.split())[:MAX_ABOUT_CHARS]
        # NOT `turns`: that is the parameter above, and shadowing it here cost
        # the learner-turn count its place in the record until it was caught.
        conversation = _clean_transcript(transcript)
        if conversation:
            payload["transcript"] = conversation
        material = _clean_review(review)
        if material is not None:
            payload["review"] = material
        findings = _clean_corrections(corrections)
        if findings:
            payload["corrections"] = findings
        wanted = _clean_goal(goal)
        if wanted is not None:
            payload["goal"] = wanted
        if isinstance(turns, int) and turns > 0:
            payload["turns"] = turns
        if isinstance(anchor_ratio, (int, float)) and not isinstance(anchor_ratio, bool):
            payload["anchorRatio"] = round(min(1.0, max(0.0, float(anchor_ratio))), 3)
        questions = _clean_asks(asks)
        if questions:
            payload["asks"] = questions
        looked_up = _clean_lookups(lookups)
        if looked_up:
            payload["lookups"] = looked_up
        if len(payload) <= 3:
            # Nothing but the identifiers: a session that produced no record.
            return False
        payload = _fit_body(payload)
        async with self._lock:
            body = await self._post_json(SUMMARY_PATH, payload)
        if not isinstance(body, dict) or body.get("ok") is not True:
            logger.warning(
                "summary post failed",
                extra={
                    "room": self._room,
                    "jobId": self._job_id,
                    "turns": len(payload.get("transcript", [])),
                },
            )
            return False
        logger.info(
            "summary posted",
            extra={
                "room": self._room,
                "about_chars": len(payload.get("about", "")),
                "turns": len(payload.get("transcript", [])),
                "corrections": len(payload.get("corrections", [])),
                "review": "review" in payload,
                "goal": "goal" in payload,
                "learner_turns": payload.get("turns"),
                "anchor_ratio": payload.get("anchorRatio"),
                "asks": len(payload.get("asks", [])),
                "lookups": len(payload.get("lookups", [])),
            },
        )
        return True

    async def balance(self) -> BalanceRead | None:
        """Re-read the learner's balance and this room's billed total.

        `None` on any failure — the caller decides what that means.
        """
        if not self.enabled:
            return None
        body = await self._post_json(BALANCE_PATH, {"userId": self._user_id, "room": self._room})
        balance_seconds = _int_field(body, "balanceSeconds")
        if balance_seconds is None:
            return None
        seconds_billed = _int_field(body, "secondsBilled") or 0
        return BalanceRead(balance_seconds=balance_seconds, seconds_billed=seconds_billed)

    # --- transport -------------------------------------------------------

    def _client(self) -> aiohttp.ClientSession:
        if self._session is None or self._session.closed:
            # No default Authorization header: the bearer is a minted JWT that
            # can change under a 401, and the mint call carries a different
            # credential entirely. Every request sets its own.
            self._session = aiohttp.ClientSession(
                timeout=aiohttp.ClientTimeout(total=REQUEST_TIMEOUT_S, connect=CONNECT_TIMEOUT_S),
            )
        return self._session

    async def _mint(self) -> str | None:
        """Mint one JWT-format M2M token from the worker's machine key.

        Never logs the key or the token. `None` on any failure, which the
        callers turn into a failed ledger call — the ceiling counts it like any
        other.
        """
        if not self._machine_key:
            return None
        url = f"{self._clerk_api_url}{MINT_PATH}"
        body = {"token_format": "jwt", "seconds_until_expiration": TOKEN_TTL_S}
        try:
            async with self._client().post(
                url,
                json=body,
                headers={"Authorization": f"Bearer {self._machine_key}"},
                timeout=aiohttp.ClientTimeout(total=MINT_TIMEOUT_S, connect=CONNECT_TIMEOUT_S),
            ) as response:
                # Clerk answers 201 Created; accept 200 too rather than depend
                # on which one this endpoint happens to use.
                if response.status not in (200, 201):
                    detail = (await response.text())[:MAX_ERROR_BODY_CHARS]
                    logger.error(
                        "minting the worker's M2M token returned %d: %s",
                        response.status,
                        detail,
                    )
                    return None
                minted = await response.json()
        except Exception:
            logger.error("minting the worker's M2M token failed", exc_info=True)
            return None
        token = minted.get("token") if isinstance(minted, dict) else None
        if not isinstance(token, str) or not token:
            logger.error("the mint response carried no token")
            return None
        logger.info(
            "minted the worker's M2M token",
            extra={"ttl_s": TOKEN_TTL_S, "room": self._room, "jobId": self._job_id},
        )
        return token

    async def _bearer(self) -> str | None:
        """The current token, minting one the first time it is asked for."""
        async with self._mint_lock:
            if self._token is None:
                self._token = await self._mint()
            return self._token

    async def _remint(self, stale: str) -> str | None:
        """Replace a token the ledger just refused. Mints at most once per 401.

        If another call already re-minted while this one waited for the lock,
        its token is the fresh one and this call simply uses it.
        """
        async with self._mint_lock:
            if self._token is not None and self._token != stale:
                return self._token
            self._token = await self._mint()
            return self._token

    async def _send(self, path: str, payload: dict, token: str) -> object | None:
        url = f"{self._site_url}{path}"
        try:
            async with self._client().post(
                url, json=payload, headers={"Authorization": f"Bearer {token}"}
            ) as response:
                if response.status == 401:
                    return UNAUTHORIZED
                if response.status != 200:
                    detail = (await response.text())[:MAX_ERROR_BODY_CHARS]
                    # ERROR, always (audit B10). A 400 is the ledger refusing
                    # the body itself — most likely the >3600s per-call delta
                    # cap — and re-sending the same body would only be refused
                    # again, so nothing here retries it.
                    logger.error(
                        "ledger call returned %d: %s",
                        response.status,
                        detail,
                        extra={"path": path, "retried": False},
                    )
                    return None
                return await response.json()
        except Exception:
            logger.error("ledger call failed", exc_info=True, extra={"path": path})
            return None

    async def _post_json(self, path: str, payload: dict) -> object | None:
        """One authenticated call, with the single re-mint a 401 is allowed.

        A 401 is the one status worth retrying: it means the JWT expired under
        a long session (or the instance rotated), not that the request was
        wrong. Exactly one re-mint and exactly one retry — a failed re-mint or
        a second 401 is a failed call, and the caller counts it.
        """
        token = await self._bearer()
        if token is None:
            return None
        body = await self._send(path, payload, token)
        if not isinstance(body, _Unauthorized):
            return body
        logger.warning("ledger call returned 401: re-minting once", extra={"path": path})
        fresh = await self._remint(token)
        if fresh is None:
            logger.error("re-minting after a 401 failed", extra={"path": path})
            return None
        body = await self._send(path, payload, fresh)
        if isinstance(body, _Unauthorized):
            # A freshly minted token the ledger still refuses is a
            # configuration fault: the wrong machine, or the wrong scope.
            logger.error(
                "the ledger refused a freshly minted token: check the worker "
                "machine id and its scope on the ledger machine",
                extra={"path": path},
            )
            return None
        return body

    async def _post(self, path: str, payload: dict) -> int | None:
        body = await self._post_json(path, payload)
        return _int_field(body, "balanceSeconds")


def _clean_transcript(turns: list[dict[str, str]] | None) -> list[dict[str, str]]:
    """Coerce and bound the transcript: role, text, per-turn and total caps."""
    if not turns:
        return []
    cleaned: list[dict[str, str]] = []
    for turn in turns:
        if not isinstance(turn, dict):
            continue
        role = turn.get("role")
        text = turn.get("text")
        if role not in ("learner", "tutor") or not isinstance(text, str):
            continue
        text = " ".join(text.split())[:MAX_TURN_CHARS]
        if not text:
            continue
        cleaned.append({"role": role, "text": text})
    # The most recent turns, oldest dropped first.
    return cleaned[-MAX_TRANSCRIPT_TURNS:]


def _clean_corrections(corrections: list[dict[str, str]] | None) -> list[dict[str, str]]:
    """The analyzer's findings, exactly the six fields Convex stores.

    Anything without a span and a replacement is dropped: the UI could not
    render it and the history should not carry it.
    """
    if not corrections:
        return []
    cleaned: list[dict[str, str]] = []
    for finding in corrections:
        if not isinstance(finding, dict):
            continue
        item = {
            name: " ".join(str(finding.get(name) or "").split())[:MAX_CORRECTION_CHARS]
            for name in CORRECTION_FIELDS
        }
        if not item["original"] or not item["replacement"]:
            continue
        cleaned.append(item)
    return cleaned[-MAX_CORRECTIONS:]


def _clean_goal(goal: dict[str, object] | None) -> dict[str, object] | None:
    """The session's goal, bounded. `None` when there is no goal to send."""
    if not isinstance(goal, dict):
        return None
    text = " ".join(str(goal.get("text") or "").split())[:MAX_GOAL_CHARS]
    if not text:
        return None
    forms: list[str] = []
    raw_forms = goal.get("forms")
    if isinstance(raw_forms, (list, tuple)):
        for entry in raw_forms:
            form = " ".join(str(entry or "").split())[:MAX_GOAL_FORM_CHARS]
            if form and form not in forms:
                forms.append(form)
            if len(forms) >= MAX_GOAL_FORMS:
                break
    source = goal.get("source")
    return {
        "text": text,
        "forms": forms,
        "source": source if source in GOAL_SOURCES else "plan",
    }


def _clean_asks(asks: list[str] | None) -> list[str]:
    """The questions the learner typed in Ask, oldest first."""
    if not asks:
        return []
    cleaned: list[str] = []
    for ask in asks:
        if not isinstance(ask, str):
            continue
        text = " ".join(ask.split())[:MAX_ASK_CHARS]
        if text:
            cleaned.append(text)
    return cleaned[-MAX_ASKS:]


def _clean_lookups(lookups: list[dict[str, str]] | None) -> list[dict[str, str]]:
    """Every select-to-translate lookup, as `{source, translation}`."""
    if not lookups:
        return []
    cleaned: list[dict[str, str]] = []
    for lookup in lookups:
        if not isinstance(lookup, dict):
            continue
        source = " ".join(str(lookup.get("source") or "").split())[:MAX_LOOKUP_CHARS]
        translation = " ".join(str(lookup.get("translation") or "").split())[:MAX_LOOKUP_CHARS]
        if source and translation:
            cleaned.append({"source": source, "translation": translation})
    return cleaned[-MAX_LOOKUPS:]


def _pairs(raw: object, limit: int, first: str, second: str) -> list[dict[str, str]]:
    """A list of two-string objects — `{target, anchor}` or `{person, form}`."""
    if not isinstance(raw, (list, tuple)):
        return []
    items: list[dict[str, str]] = []
    for entry in raw:
        if not isinstance(entry, dict):
            continue
        a, b = entry.get(first), entry.get(second)
        if not isinstance(a, str) or not isinstance(b, str):
            continue
        items.append({first: a[:MAX_REVIEW_ITEM_CHARS], second: b[:MAX_REVIEW_ITEM_CHARS]})
        if len(items) >= limit:
            break
    return items


def _clean_review(review: dict[str, object] | None) -> dict[str, object] | None:
    """The Review snapshot, bounded to what the ledger will accept.

    All three lists are always present — Convex requires the keys when `review`
    is sent at all — and `None` means "there is nothing worth sending".
    """
    if not isinstance(review, dict):
        return None
    material = {
        "vocab": _pairs(review.get("vocab"), MAX_REVIEW_VOCAB, "target", "anchor"),
        "phrases": _pairs(review.get("phrases"), MAX_REVIEW_PHRASES, "target", "anchor"),
        "tables": _tables(review.get("tables")),
    }
    if not any(material.values()):
        return None
    return material


def _tables(raw: object) -> list[dict[str, object]]:
    """Conjugation tables. The engine can build twelve; the ledger takes eight."""
    if not isinstance(raw, (list, tuple)):
        return []
    tables: list[dict[str, object]] = []
    for entry in raw:
        if not isinstance(entry, dict):
            continue
        verb, tense = entry.get("verb"), entry.get("tense")
        if not isinstance(verb, str) or not isinstance(tense, str):
            continue
        tables.append(
            {
                "verb": verb[:MAX_REVIEW_ITEM_CHARS],
                "tense": tense[:MAX_REVIEW_ITEM_CHARS],
                "rows": _pairs(entry.get("rows"), MAX_TABLE_ROWS, "person", "form"),
            }
        )
        if len(tables) >= MAX_REVIEW_TABLES:
            break
    return tables


def _body_bytes(payload: dict) -> int:
    try:
        return len(json.dumps(payload, ensure_ascii=False).encode("utf-8"))
    except Exception:
        return MAX_BODY_BYTES + 1


def _fit_body(payload: dict) -> dict:
    """Bring the body under the ledger's 256 KB ceiling, least-valuable first.

    Review goes first (it is regenerable from the plan), then the transcript is
    trimmed from the oldest end, then the corrections. `about` is never
    dropped: it is the one line the summary screen cannot be written without.
    """
    if _body_bytes(payload) <= MAX_BODY_BYTES:
        return payload
    if "review" in payload:
        payload = {k: v for k, v in payload.items() if k != "review"}
        logger.warning("summary body too large: dropping the review snapshot")
    turns = payload.get("transcript")
    while isinstance(turns, list) and turns and _body_bytes(payload) > MAX_BODY_BYTES:
        # Halve rather than pop: a 256 KB overrun is not one turn's worth.
        turns = turns[max(1, len(turns) // 2) :]
        payload["transcript"] = turns
    if _body_bytes(payload) > MAX_BODY_BYTES:
        payload.pop("transcript", None)
        logger.warning("summary body too large: dropping the transcript")
    findings = payload.get("corrections")
    while isinstance(findings, list) and findings and _body_bytes(payload) > MAX_BODY_BYTES:
        findings = findings[max(1, len(findings) // 2) :]
        payload["corrections"] = findings
    if _body_bytes(payload) > MAX_BODY_BYTES:
        payload.pop("corrections", None)
        logger.warning("summary body still too large: posting the about line alone")
    return payload


def _int_field(body: object, name: str) -> int | None:
    """A non-negative integer field off a JSON object, or None."""
    if not isinstance(body, dict):
        return None
    value = body.get(name)
    # bool is an int subclass; a JSON `true` is not a number of seconds.
    if not isinstance(value, (int, float)) or isinstance(value, bool):
        return None
    if value != value:  # NaN
        return None
    return max(0, int(value))
