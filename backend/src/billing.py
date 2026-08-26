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
"""

from __future__ import annotations

import asyncio
import json
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
SUMMARY_PATH = "/tutor/summary"

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

    async def summary(
        self,
        *,
        about: str | None = None,
        transcript: list[dict[str, str]] | None = None,
        review: dict[str, object] | None = None,
        corrections: list[dict[str, str]] | None = None,
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
        turns = _clean_transcript(transcript)
        if turns:
            payload["transcript"] = turns
        material = _clean_review(review)
        if material is not None:
            payload["review"] = material
        findings = _clean_corrections(corrections)
        if findings:
            payload["corrections"] = findings
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
