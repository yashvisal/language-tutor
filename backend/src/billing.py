"""The money seam: the worker reports seconds, Convex owns the ledger.

Two signed HTTP calls, both against `CONVEX_SITE_URL` with a bearer secret:

- `POST /tutor/debit` — "this session has used N cumulative active seconds so
  far". The action is idempotent per `(room, seq)` and debits only the delta
  since the last report, so the worker never has to remember what it already
  reported: it always sends the running total and lets the ledger difference
  it. Returns the learner's balance after the debit.
- `POST /tutor/balance` — "what is this learner's balance now?". Used when a
  session held at zero is resumed, which is how a purchase mid-session
  continues the same conversation.

Three rules hold here:

- **Billing never raises into the session.** Every failure is caught and
  logged. A learner mid-sentence must not lose the conversation because a
  ledger write timed out; the teardown report is the backstop, and the debit
  is idempotent, so a lost call costs at most one un-debited delta.
- **Bounded, always.** A hung Convex must not hold the hold, the resume, or
  the worker's shutdown.
- **No learner id, no HTTP.** A session dispatched without a `user_id` (which
  should not happen once the token route gates, but the worker must stay safe)
  runs entirely on its dispatched `balance_s` and reports nothing.
"""

from __future__ import annotations

import logging
import os

import aiohttp

logger = logging.getLogger("tutor.billing")

# Bounded twice: a per-request total, and a shorter connect timeout so an
# unreachable host fails fast rather than sitting on the whole budget.
REQUEST_TIMEOUT_S = 5.0
CONNECT_TIMEOUT_S = 2.0

DEBIT_PATH = "/tutor/debit"
BALANCE_PATH = "/tutor/balance"


class BillingClient:
    """The Convex ledger's client for one session.

    Owns the debit sequence number: it increments per call, and the pair
    `(room, seq)` is what makes the action idempotent across the worker's
    retries.
    """

    def __init__(
        self,
        *,
        room: str,
        user_id: str | None,
        site_url: str | None = None,
        secret: str | None = None,
    ) -> None:
        self._room = room
        self._user_id = user_id
        if site_url is None:
            site_url = os.environ.get("CONVEX_SITE_URL", "")
        self._site_url = site_url.strip().rstrip("/")
        self._secret = (
            secret if secret is not None else os.environ.get("TUTOR_DEBIT_SECRET", "")
        ).strip()
        self._seq = 0
        self._session: aiohttp.ClientSession | None = None

    @property
    def enabled(self) -> bool:
        """Whether this session can talk to the ledger at all."""
        return bool(self._user_id and self._site_url and self._secret)

    async def aclose(self) -> None:
        session = self._session
        self._session = None
        if session is not None:
            try:
                await session.close()
            except Exception:
                logger.debug("billing client close failed (harmless)", exc_info=True)

    # --- the two calls ---------------------------------------------------

    async def debit(self, seconds: int) -> int | None:
        """Report the session's CUMULATIVE active seconds. Returns the balance.

        `None` means the call did not happen or did not succeed — never an
        exception, and never a reason to change what the session is doing.
        """
        if not self.enabled:
            return None
        self._seq += 1
        seq = self._seq
        balance = await self._post(
            DEBIT_PATH,
            {
                "room": self._room,
                "userId": self._user_id,
                "seconds": int(max(0, seconds)),
                "seq": seq,
            },
        )
        if balance is None:
            logger.warning("debit failed", extra={"seq": seq, "seconds": int(max(0, seconds))})
            return None
        logger.info(
            "debit reported",
            extra={"seq": seq, "seconds": int(max(0, seconds)), "balance_s": balance},
        )
        return balance

    async def balance(self) -> int | None:
        """Re-read the learner's balance in seconds. `None` on any failure."""
        if not self.enabled:
            return None
        return await self._post(BALANCE_PATH, {"userId": self._user_id})

    # --- transport -------------------------------------------------------

    def _client(self) -> aiohttp.ClientSession:
        if self._session is None or self._session.closed:
            self._session = aiohttp.ClientSession(
                timeout=aiohttp.ClientTimeout(total=REQUEST_TIMEOUT_S, connect=CONNECT_TIMEOUT_S),
                headers={"Authorization": f"Bearer {self._secret}"},
            )
        return self._session

    async def _post(self, path: str, payload: dict) -> int | None:
        url = f"{self._site_url}{path}"
        try:
            async with self._client().post(url, json=payload) as response:
                if response.status != 200:
                    logger.warning("ledger call returned %d", response.status, extra={"path": path})
                    return None
                body = await response.json()
        except Exception:
            logger.warning("ledger call failed", exc_info=True, extra={"path": path})
            return None
        return _balance_seconds(body)


def _balance_seconds(body: object) -> int | None:
    if not isinstance(body, dict):
        return None
    value = body.get("balanceSeconds")
    # bool is an int subclass; a JSON `true` is not a balance.
    if not isinstance(value, (int, float)) or isinstance(value, bool):
        return None
    if value != value:  # NaN
        return None
    return max(0, int(value))
