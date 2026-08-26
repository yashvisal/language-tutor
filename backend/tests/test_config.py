"""Checks for the worker's boot-time environment guards (`src/config.py`).

Only the guards that can cost money or silence are checked here — the rest of
`TutorConfig` is defaults and clamps, exercised by the worker every time it
starts.

The one at stake: a production worker must never boot unmetered. Dev and prod
share LiveKit Cloud and a `*.convex.site` host, and a Clerk machine key carries
no test/live marker, so nothing can infer which deployment this is. `TUTOR_ENV`
is the declaration, and it is checked rather than guessed.

Run either way:

    uv run pytest tests
    uv run python tests/test_config.py
"""

from __future__ import annotations

import logging
import os
import sys
from collections.abc import Iterator
from contextlib import contextmanager
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from config import TutorConfig, UnmeteredProductionError  # noqa: E402

# Everything these checks touch. Cleared before each one so a developer's own
# `.env.local`, already exported into the shell, cannot decide the result.
MANAGED = (
    "OPENAI_API_KEY",
    "TUTOR_ENV",
    "TUTOR_ALLOW_UNMETERED",
    "CLERK_WORKER_MACHINE_SECRET_KEY",
)


@contextmanager
def env(**values: str) -> Iterator[None]:
    saved = {name: os.environ.get(name) for name in MANAGED}
    try:
        for name in MANAGED:
            os.environ.pop(name, None)
        os.environ["OPENAI_API_KEY"] = "sk-test"
        os.environ.update(values)
        yield
    finally:
        for name, value in saved.items():
            if value is None:
                os.environ.pop(name, None)
            else:
                os.environ[name] = value


class Captured(logging.Handler):
    """The records `config` emitted while the block ran."""

    def __init__(self) -> None:
        super().__init__()
        self.records: list[logging.LogRecord] = []

    def emit(self, record: logging.LogRecord) -> None:
        self.records.append(record)

    def warnings(self) -> list[str]:
        return [r.getMessage() for r in self.records if r.levelno >= logging.WARNING]


@contextmanager
def capture() -> Iterator[Captured]:
    handler = Captured()
    logger = logging.getLogger("tutor.config")
    logger.addHandler(handler)
    try:
        yield handler
    finally:
        logger.removeHandler(handler)


def test_production_plus_unmetered_refuses_to_boot() -> None:
    """The one combination that bills nothing and pages nobody."""
    with env(TUTOR_ENV="production", TUTOR_ALLOW_UNMETERED="1"):
        try:
            TutorConfig.from_env()
        except UnmeteredProductionError as exc:
            assert "TUTOR_ALLOW_UNMETERED" in str(exc)
        else:
            raise AssertionError("a production worker booted unmetered")


def test_the_refusal_does_not_care_about_case() -> None:
    with env(TUTOR_ENV="Production", TUTOR_ALLOW_UNMETERED="true"):
        try:
            TutorConfig.from_env()
        except UnmeteredProductionError:
            return
        raise AssertionError("a production worker booted unmetered")


def test_unmetered_off_production_is_allowed_and_says_so() -> None:
    with env(TUTOR_ENV="development", TUTOR_ALLOW_UNMETERED="1"):
        cfg = TutorConfig.from_env()
    assert cfg.allow_unmetered
    assert not cfg.is_production
    assert cfg.tutor_env == "development"


def test_production_alone_is_fine() -> None:
    with env(TUTOR_ENV="production"):
        cfg = TutorConfig.from_env()
    assert cfg.is_production
    assert not cfg.allow_unmetered


def test_a_machine_key_with_no_declared_environment_warns_once() -> None:
    """It can debit a real ledger and has not said which one it is."""
    with env(CLERK_WORKER_MACHINE_SECRET_KEY="ak_test_not_a_real_key"), capture() as log:
        TutorConfig.from_env()
    warnings = [m for m in log.warnings() if "TUTOR_ENV" in m]
    assert len(warnings) == 1


def test_a_declared_environment_is_quiet() -> None:
    with (
        env(CLERK_WORKER_MACHINE_SECRET_KEY="ak_test_not_a_real_key", TUTOR_ENV="development"),
        capture() as log,
    ):
        TutorConfig.from_env()
    assert [m for m in log.warnings() if "TUTOR_ENV" in m] == []


def test_a_worker_with_no_machine_key_is_quiet() -> None:
    """The CLI worker with no ledger at all is not a deployment; nothing to say."""
    with env(), capture() as log:
        TutorConfig.from_env()
    assert [m for m in log.warnings() if "TUTOR_ENV" in m] == []


def main() -> int:
    checks = [value for name, value in sorted(globals().items()) if name.startswith("test_")]
    failures = 0
    for check in checks:
        try:
            check()
        except AssertionError as exc:
            failures += 1
            print(f"FAIL {check.__name__}: {exc}")
        else:
            print(f"ok   {check.__name__}")
    print(f"\n{len(checks) - failures}/{len(checks)} checks passed")
    return 1 if failures else 0


if __name__ == "__main__":
    raise SystemExit(main())
