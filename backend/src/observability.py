"""The worker's error-reporting seam (A11, phase 8 piece 1).

One function — `report_error` — that every path which loses a session, a
learner or revenue calls on its way out. Today it writes one structured ERROR
record; tomorrow it is also the single place Sentry is initialised and fed.
Nothing else in the worker imports `sentry_sdk`, and nothing else has to change
when it does.

`sentry-sdk` is a dependency (`pyproject.toml`). `init_error_reporting` is a
no-op unless `SENTRY_DSN` is set, so development and tests never talk to
Sentry; production sets the DSN in the LiveKit agent secrets.

**The privacy rule is the same one the logs follow** (phase 8 decision (b),
A12): ids only, never transcript or free text. Sentry's `before_send` scrubs
any `text` / `transcript` / `plan_*` / `goal_text` key out of the event before
it leaves the process, so a future caller that passes prose by accident cannot
leak it either. `user_id`, `room` and `job_id` are correlation ids and travel.
"""

from __future__ import annotations

import logging
import os
from typing import Any

logger = logging.getLogger("tutor.observability")

# Env the seam reads. Absent (the default, and every laptop) means the seam is
# a logger and nothing else.
SENTRY_DSN_ENV = "SENTRY_DSN"

# Set once by `init_error_reporting`; `report_error` reads it. A list so the
# module-level value can be flipped without `global`.
_SENTRY_READY: list[bool] = [False]

# Keys that must never leave the process, whatever a caller puts in `extra`.
# Anything starting with one of these prefixes goes too (`plan_topic`,
# `plan_note`, …).
SCRUB_KEYS = ("text", "transcript", "prose", "answer", "question", "translation")
SCRUB_PREFIXES = ("plan_", "goal_text", "ask_", "lookup_")

# Every `kind` the worker reports, so the set is greppable and a typo in a
# failure path is visible here rather than in a dashboard three weeks later.
ERROR_KINDS = (
    "config_fault",
    "no_learner",
    "ledger_unreachable",
    "ledger_refused",
    "ledger_ceiling",
    "lease_lost",
    "tutor_silent",
    "model_error",
)


def scrub_fields(fields: dict[str, Any]) -> dict[str, Any]:
    """Drop every free-text key from a bag of log/report fields.

    Shared by the logger below and by Sentry's `before_send`, so the two can
    never disagree about what counts as prose.

    Recursive: a nested mapping (`context={"transcript": ...}`) or a list of
    them is scrubbed at every depth, so the contract does not depend on every
    caller passing scalars (CodeRabbit, PR #12).
    """
    return {
        key: _scrub_value(value)
        for key, value in fields.items()
        if key not in SCRUB_KEYS and not key.startswith(SCRUB_PREFIXES)
    }


def _scrub_value(value: Any) -> Any:
    if isinstance(value, dict):
        return scrub_fields(value)
    if isinstance(value, (list, tuple)):
        return type(value)(_scrub_value(item) for item in value)
    return value


def init_error_reporting() -> None:
    """Initialise Sentry, once per job process. Called from `_prewarm`.

    THIS IS THE ONE PLACE `sentry_sdk` GETS WIRED. It is deliberately a no-op
    until the dependency exists; see the module docstring for the two-line
    install. Nothing here may raise: `_prewarm` runs before any job is assigned
    and an exception in it takes the process with it.
    """
    dsn = os.environ.get(SENTRY_DSN_ENV, "").strip()
    if not dsn:
        return

    try:
        import sentry_sdk
    except ImportError:  # pragma: no cover - the dependency is in pyproject
        logger.warning(
            "%s is set but sentry_sdk is not installed; errors are logged only.",
            SENTRY_DSN_ENV,
        )
        return

    def before_send(event, hint):  # noqa: ANN001 - Sentry's own signature
        # The same rule as the logs: ids only, never transcript or free text.
        for bag in ("extra", "tags", "contexts"):
            values = event.get(bag)
            if isinstance(values, dict):
                event[bag] = scrub_fields(values)
        return event

    try:
        sentry_sdk.init(
            dsn=dsn,
            environment=os.environ.get("TUTOR_ENV", "development"),
            before_send=before_send,
            # Errors only; a realtime worker's spans are not worth the volume.
            traces_sample_rate=0.0,
            send_default_pii=False,
        )
        _SENTRY_READY[0] = True
        logger.info("error reporting initialised")
    except Exception:  # pragma: no cover - never take the process down for this
        logger.warning("sentry_sdk.init failed; errors are logged only", exc_info=True)
    return


def report_error(kind: str, detail: str, exc: BaseException | None = None, **fields: Any) -> None:
    """Report a failure that cost a session, a learner, or revenue.

    `kind` is one of `ERROR_KINDS` — a stable string to group and alert on.
    `detail` is one human sentence. `fields` are correlation ids (`user_id`,
    `room`, `job_id`, `code`); free text in them is scrubbed, not trusted.

    Never raises. Every caller is already on a failure path and a reporter that
    can fail the thing it is reporting on is worse than no reporter.
    """
    safe = scrub_fields(fields)
    try:
        logger.error(
            "%s: %s",
            kind,
            detail,
            exc_info=exc is not None,
            extra={"error_kind": kind, **safe},
        )
    except Exception:  # pragma: no cover - a logger that cannot log
        pass

    if not _SENTRY_READY[0]:
        return
    try:
        import sentry_sdk

        with sentry_sdk.push_scope() as scope:
            scope.set_tag("error_kind", kind)
            for key, value in safe.items():
                scope.set_extra(key, value)
            if exc is not None:
                sentry_sdk.capture_exception(exc)
            else:
                sentry_sdk.capture_message(f"{kind}: {detail}", level="error")
    except Exception:  # pragma: no cover - a reporter must never fail its caller
        pass
