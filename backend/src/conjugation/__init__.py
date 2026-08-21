"""Deterministic conjugation tables for the Review tab.

Tables are **shipped, never generated**: a model that invents a paradigm is a
model that teaches a wrong ending, and a conjugation table is the one piece of
study material with exactly one right answer (phase-4 doc, 4c / the phase-5
outline). So this package is an engine, not a prompt.

Language lives behind a registry keyed by language code. This module knows the
shape of a table and which codes have an engine; every paradigm, irregular,
tense name, and scenario-to-verb choice lives inside the engine module. Adding a
second language is a new module and one registry entry — never a branch here,
and never a language-specific string in the RPC layer above.

Only `es` is implemented.
"""

from __future__ import annotations

from collections.abc import Callable, Sequence
from typing import TypedDict


class ConjugationRow(TypedDict):
    person: str
    form: str


class ConjugationTable(TypedDict):
    verb: str
    tense: str
    rows: list[ConjugationRow]


# The hard ceiling on one Review tab. An engine picks its own width per tense
# (three or four verbs for a narrow focus, two for a wide one); this is the
# backstop, because past a dozen tables it is a reference work, not a study
# surface.
MAX_TABLES = 12

# An engine renders the tables for one language. Keyword-only on purpose — the
# registry never positionally binds a signature it does not own.
Engine = Callable[..., list[ConjugationTable]]

_ENGINES: dict[str, Engine] = {}


def _engine(language: str) -> Engine | None:
    # A locale-shaped target language ("es-ES", "es_MX") is still Spanish: the
    # registry is keyed by the base subtag.
    code = language.strip().lower().replace("_", "-").split("-", 1)[0]
    if code not in _ENGINES:
        if code == "es":
            from conjugation import es

            _ENGINES[code] = es.tables
        else:
            return None
    return _ENGINES[code]


def supports(language: str) -> bool:
    """Whether we can build tables for this target language at all."""
    return _engine(language) is not None


def tables_for(
    language: str,
    *,
    tenses: Sequence[str] = (),
    scenario: str | None = None,
    topic: str | None = None,
    max_tables: int = MAX_TABLES,
) -> list[ConjugationTable]:
    """The tables for one session: the plan's focus tenses x a few verbs.

    `tenses` are the frontend's opaque focus-form strings (see
    `frontend/lib/session/plan.ts`); the engine decides which of them it can
    render and silently drops the rest. A language with no engine returns
    nothing, and the Review tab simply shows vocabulary and phrases.
    """
    engine = _engine(language)
    if engine is None:
        return []
    return engine(
        tenses=list(tenses),
        scenario=scenario,
        topic=topic,
        max_tables=max(0, max_tables),
    )
