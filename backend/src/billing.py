"""The money seam: the worker reports seconds, Convex owns the ledger.

Two signed HTTP calls, both against `CONVEX_SITE_URL` with a bearer secret:

- `POST /tutor/debit` — "this ROOM has used N cumulative active seconds so
  far". The action is idempotent per `ref = <room>:<jobId>:<seq>` and debits
  only the delta above the room's high-water mark, so the worker never has to
  remember what it already reported: it always sends the running total and lets
  the ledger difference it. Returns the learner's balance after the debit.
  The teardown debit — and only that one — carries `final: true`, which is what
  closes the session row (`endedAt`) on the Convex side; a periodic or
  zero-hold debit must leave it open, or a purchase could not resume the same
  conversation.
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
"""

from __future__ import annotations

import asyncio
import logging
import os
from dataclasses import dataclass

import aiohttp

logger = logging.getLogger("tutor.billing")

# Bounded twice: a per-request total, and a shorter connect timeout so an
# unreachable host fails fast rather than sitting on the whole budget.
REQUEST_TIMEOUT_S = 5.0
CONNECT_TIMEOUT_S = 2.0

DEBIT_PATH = "/tutor/debit"
BALANCE_PATH = "/tutor/balance"

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
        secret: str | None = None,
    ) -> None:
        self._room = room
        self._user_id = user_id
        # The ledger bounds it at 128 characters; a LiveKit job id is far
        # shorter, but a 400 here would cost a whole session's revenue.
        self._job_id = (job_id or "")[:128]
        if site_url is None:
            site_url = os.environ.get("CONVEX_SITE_URL", "")
        self._site_url = site_url.strip().rstrip("/")
        self._secret = (
            secret if secret is not None else os.environ.get("TUTOR_DEBIT_SECRET", "")
        ).strip()
        self._seq = 0
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
        return bool(self._user_id and self._site_url and self._secret)

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
        """
        if not self.enabled:
            return None
        active = int(max(0, active_seconds))
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
            balance = await self._post(DEBIT_PATH, payload)
            if balance is None:
                # ERROR, not warning: a debit that does not land is revenue on
                # the floor, and nothing downstream notices (audit B10).
                logger.error(
                    "debit failed",
                    extra={"seq": seq, "seconds": seconds, "jobId": self._job_id},
                )
                if zero_hold:
                    self._unacked_zero_s = active
                return None
            if self._unacked_zero_s is not None:
                # Any successful debit reports a total that covers the seconds
                # the zero hold failed to report, so the debt is settled.
                self._unacked_zero_s = None
            logger.info(
                "debit reported",
                extra={"seq": seq, "seconds": seconds, "balance_s": balance},
            )
            return balance

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
            self._session = aiohttp.ClientSession(
                timeout=aiohttp.ClientTimeout(total=REQUEST_TIMEOUT_S, connect=CONNECT_TIMEOUT_S),
                headers={"Authorization": f"Bearer {self._secret}"},
            )
        return self._session

    async def _post_json(self, path: str, payload: dict) -> object | None:
        url = f"{self._site_url}{path}"
        try:
            async with self._client().post(url, json=payload) as response:
                if response.status != 200:
                    # A 401 here means the worker's secret is wrong and every
                    # session is running free: error level, always (audit B10).
                    logger.error("ledger call returned %d", response.status, extra={"path": path})
                    return None
                return await response.json()
        except Exception:
            logger.error("ledger call failed", exc_info=True, extra={"path": path})
            return None

    async def _post(self, path: str, payload: dict) -> int | None:
        body = await self._post_json(path, payload)
        return _int_field(body, "balanceSeconds")


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
