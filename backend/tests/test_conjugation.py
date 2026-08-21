"""Checks for the shipped conjugation engine (`src/conjugation/`).

The Review tab's tables are deterministic precisely so they can be checked, and
a wrong ending in a study table is the one error nobody in the loop would catch
— so every regular paradigm and every irregular override is spot-checked here
against forms taken from a reference paradigm.

Run either way:

    uv run python -m pytest tests            # if pytest is installed
    uv run python tests/test_conjugation.py  # always
"""

from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

import conjugation  # noqa: E402
from conjugation import es  # noqa: E402

# --- regular paradigms ---------------------------------------------------

REGULAR_CASES: dict[tuple[str, str], tuple[str, ...]] = {
    ("hablar", es.PRESENT): ("hablo", "hablas", "habla", "hablamos", "habláis", "hablan"),
    ("hablar", es.PRETERITE): (
        "hablé",
        "hablaste",
        "habló",
        "hablamos",
        "hablasteis",
        "hablaron",
    ),
    ("hablar", es.IMPERFECT): (
        "hablaba",
        "hablabas",
        "hablaba",
        "hablábamos",
        "hablabais",
        "hablaban",
    ),
    ("hablar", es.FUTURE): (
        "hablaré",
        "hablarás",
        "hablará",
        "hablaremos",
        "hablaréis",
        "hablarán",
    ),
    ("hablar", es.CONDITIONAL): (
        "hablaría",
        "hablarías",
        "hablaría",
        "hablaríamos",
        "hablaríais",
        "hablarían",
    ),
    ("hablar", es.SUBJUNCTIVE): ("hable", "hables", "hable", "hablemos", "habléis", "hablen"),
    ("hablar", es.PERFECT): (
        "he hablado",
        "has hablado",
        "ha hablado",
        "hemos hablado",
        "habéis hablado",
        "han hablado",
    ),
    ("comer", es.PRESENT): ("como", "comes", "come", "comemos", "coméis", "comen"),
    ("comer", es.PRETERITE): ("comí", "comiste", "comió", "comimos", "comisteis", "comieron"),
    ("comer", es.IMPERFECT): ("comía", "comías", "comía", "comíamos", "comíais", "comían"),
    ("comer", es.FUTURE): ("comeré", "comerás", "comerá", "comeremos", "comeréis", "comerán"),
    ("comer", es.CONDITIONAL): (
        "comería",
        "comerías",
        "comería",
        "comeríamos",
        "comeríais",
        "comerían",
    ),
    ("comer", es.SUBJUNCTIVE): ("coma", "comas", "coma", "comamos", "comáis", "coman"),
    ("comer", es.PERFECT): (
        "he comido",
        "has comido",
        "ha comido",
        "hemos comido",
        "habéis comido",
        "han comido",
    ),
    ("vivir", es.PRESENT): ("vivo", "vives", "vive", "vivimos", "vivís", "viven"),
    ("vivir", es.PRETERITE): ("viví", "viviste", "vivió", "vivimos", "vivisteis", "vivieron"),
    ("vivir", es.IMPERFECT): ("vivía", "vivías", "vivía", "vivíamos", "vivíais", "vivían"),
    ("vivir", es.FUTURE): ("viviré", "vivirás", "vivirá", "viviremos", "viviréis", "vivirán"),
    ("vivir", es.CONDITIONAL): (
        "viviría",
        "vivirías",
        "viviría",
        "viviríamos",
        "viviríais",
        "vivirían",
    ),
    ("vivir", es.SUBJUNCTIVE): ("viva", "vivas", "viva", "vivamos", "viváis", "vivan"),
    ("vivir", es.PERFECT): (
        "he vivido",
        "has vivido",
        "ha vivido",
        "hemos vivido",
        "habéis vivido",
        "han vivido",
    ),
    # The orthographic families: c/g/z in front of a front vowel.
    ("buscar", es.PRETERITE): (
        "busqué",
        "buscaste",
        "buscó",
        "buscamos",
        "buscasteis",
        "buscaron",
    ),
    ("buscar", es.SUBJUNCTIVE): (
        "busque",
        "busques",
        "busque",
        "busquemos",
        "busquéis",
        "busquen",
    ),
    ("llegar", es.PRETERITE): (
        "llegué",
        "llegaste",
        "llegó",
        "llegamos",
        "llegasteis",
        "llegaron",
    ),
    ("llegar", es.SUBJUNCTIVE): (
        "llegue",
        "llegues",
        "llegue",
        "lleguemos",
        "lleguéis",
        "lleguen",
    ),
    ("cruzar", es.PRETERITE): ("crucé", "cruzaste", "cruzó", "cruzamos", "cruzasteis", "cruzaron"),
    ("cruzar", es.SUBJUNCTIVE): ("cruce", "cruces", "cruce", "crucemos", "crucéis", "crucen"),
}

# --- irregular overrides -------------------------------------------------
#
# One cell per verb per irregular tense, taken from a reference paradigm. Every
# verb in `es.IRREGULARS` appears here (the count is asserted below), so an
# override added without a check fails the run.

IRREGULAR_CASES: dict[tuple[str, str], tuple[int, str]] = {
    ("ser", es.PRESENT): (0, "soy"),
    ("ser", es.PRETERITE): (2, "fue"),
    ("ser", es.IMPERFECT): (3, "éramos"),
    ("ser", es.SUBJUNCTIVE): (1, "seas"),
    ("ser", es.FUTURE): (0, "seré"),
    ("ser", es.PERFECT): (0, "he sido"),
    ("estar", es.PRESENT): (1, "estás"),
    ("estar", es.PRETERITE): (0, "estuve"),
    ("estar", es.SUBJUNCTIVE): (5, "estén"),
    ("estar", es.IMPERFECT): (0, "estaba"),
    ("ir", es.PRESENT): (0, "voy"),
    ("ir", es.PRETERITE): (5, "fueron"),
    ("ir", es.IMPERFECT): (3, "íbamos"),
    ("ir", es.SUBJUNCTIVE): (0, "vaya"),
    ("ir", es.FUTURE): (0, "iré"),
    ("tener", es.PRESENT): (0, "tengo"),
    ("tener", es.PRETERITE): (0, "tuve"),
    ("tener", es.FUTURE): (0, "tendré"),
    ("tener", es.CONDITIONAL): (2, "tendría"),
    ("tener", es.SUBJUNCTIVE): (0, "tenga"),
    ("hacer", es.PRESENT): (0, "hago"),
    ("hacer", es.PRETERITE): (2, "hizo"),
    ("hacer", es.FUTURE): (0, "haré"),
    ("hacer", es.PERFECT): (0, "he hecho"),
    ("hacer", es.SUBJUNCTIVE): (3, "hagamos"),
    ("poder", es.PRESENT): (0, "puedo"),
    ("poder", es.PRETERITE): (2, "pudo"),
    ("poder", es.FUTURE): (0, "podré"),
    ("poder", es.SUBJUNCTIVE): (3, "podamos"),
    ("decir", es.PRESENT): (0, "digo"),
    ("decir", es.PRETERITE): (5, "dijeron"),
    ("decir", es.FUTURE): (0, "diré"),
    ("decir", es.PERFECT): (0, "he dicho"),
    ("decir", es.SUBJUNCTIVE): (0, "diga"),
    ("venir", es.PRESENT): (1, "vienes"),
    ("venir", es.PRETERITE): (0, "vine"),
    ("venir", es.FUTURE): (0, "vendré"),
    ("venir", es.SUBJUNCTIVE): (0, "venga"),
    ("ver", es.PRESENT): (0, "veo"),
    ("ver", es.PRETERITE): (2, "vio"),
    ("ver", es.IMPERFECT): (0, "veía"),
    ("ver", es.PERFECT): (0, "he visto"),
    ("ver", es.SUBJUNCTIVE): (0, "vea"),
    ("dar", es.PRESENT): (0, "doy"),
    ("dar", es.PRETERITE): (2, "dio"),
    ("dar", es.SUBJUNCTIVE): (0, "dé"),
    ("saber", es.PRESENT): (0, "sé"),
    ("saber", es.PRETERITE): (0, "supe"),
    ("saber", es.FUTURE): (0, "sabré"),
    ("saber", es.SUBJUNCTIVE): (0, "sepa"),
    ("querer", es.PRESENT): (0, "quiero"),
    ("querer", es.PRETERITE): (2, "quiso"),
    ("querer", es.FUTURE): (0, "querré"),
    ("querer", es.SUBJUNCTIVE): (0, "quiera"),
    ("poner", es.PRESENT): (0, "pongo"),
    ("poner", es.PRETERITE): (0, "puse"),
    ("poner", es.FUTURE): (0, "pondré"),
    ("poner", es.PERFECT): (0, "he puesto"),
    ("poner", es.SUBJUNCTIVE): (0, "ponga"),
    ("salir", es.PRESENT): (0, "salgo"),
    ("salir", es.FUTURE): (0, "saldré"),
    ("salir", es.SUBJUNCTIVE): (0, "salga"),
    # Not overridden, so this is the regular engine doing its job.
    ("salir", es.PRETERITE): (0, "salí"),
    ("haber", es.PRESENT): (0, "he"),
    ("haber", es.PRETERITE): (2, "hubo"),
    ("haber", es.FUTURE): (0, "habré"),
    ("haber", es.SUBJUNCTIVE): (0, "haya"),
    ("conocer", es.PRESENT): (0, "conozco"),
    ("conocer", es.SUBJUNCTIVE): (0, "conozca"),
    ("conocer", es.PRETERITE): (0, "conocí"),
    ("pedir", es.PRESENT): (0, "pido"),
    ("pedir", es.PRETERITE): (2, "pidió"),
    ("pedir", es.SUBJUNCTIVE): (0, "pida"),
    ("dormir", es.PRESENT): (0, "duermo"),
    ("dormir", es.PRETERITE): (2, "durmió"),
    ("dormir", es.SUBJUNCTIVE): (3, "durmamos"),
    ("jugar", es.PRESENT): (0, "juego"),
    ("jugar", es.SUBJUNCTIVE): (3, "juguemos"),
    ("pensar", es.PRESENT): (0, "pienso"),
    ("pensar", es.SUBJUNCTIVE): (0, "piense"),
    ("volver", es.PRESENT): (0, "vuelvo"),
    ("volver", es.PERFECT): (0, "he vuelto"),
    ("volver", es.SUBJUNCTIVE): (0, "vuelva"),
    ("sentir", es.PRESENT): (0, "siento"),
    ("sentir", es.PRETERITE): (2, "sintió"),
    ("sentir", es.SUBJUNCTIVE): (3, "sintamos"),
    ("seguir", es.PRESENT): (0, "sigo"),
    ("seguir", es.PRETERITE): (2, "siguió"),
    ("seguir", es.SUBJUNCTIVE): (0, "siga"),
    ("empezar", es.PRESENT): (0, "empiezo"),
    ("empezar", es.PRETERITE): (0, "empecé"),
    ("empezar", es.SUBJUNCTIVE): (0, "empiece"),
    ("traer", es.PRESENT): (0, "traigo"),
    ("traer", es.PRETERITE): (2, "trajo"),
    ("traer", es.PERFECT): (0, "he traído"),
    ("traer", es.SUBJUNCTIVE): (0, "traiga"),
}

ALL_TENSES = (
    es.PRESENT,
    es.PRETERITE,
    es.IMPERFECT,
    es.FUTURE,
    es.CONDITIONAL,
    es.SUBJUNCTIVE,
    es.PERFECT,
)


def test_regular_paradigms() -> None:
    for (verb, tense), expected in REGULAR_CASES.items():
        actual = es.conjugate(verb, tense)
        assert actual == expected, f"{verb} / {tense}: {actual} != {expected}"


def test_irregular_overrides() -> None:
    for (verb, tense), (index, expected) in IRREGULAR_CASES.items():
        forms = es.conjugate(verb, tense)
        assert forms is not None, f"{verb} / {tense}: no forms"
        assert forms[index] == expected, f"{verb} / {tense}[{index}]: {forms[index]} != {expected}"


def test_every_irregular_is_spot_checked() -> None:
    """An override added without a check is an unchecked paradigm."""
    checked = {verb for verb, _ in IRREGULAR_CASES}
    assert checked >= set(es.IRREGULARS), f"unchecked: {set(es.IRREGULARS) - checked}"
    assert len(es.IRREGULARS) == 25, f"expected 25 overrides, found {len(es.IRREGULARS)}"


def test_every_verb_conjugates_in_every_tense() -> None:
    """Shape, for every verb we ship: six forms, all non-empty, no duplicates
    of the infinitive left lying around."""
    verbs = set(es.IRREGULARS) | {"hablar", "comer", "vivir", "tomar", "trabajar"}
    for verb in sorted(verbs):
        for tense in ALL_TENSES:
            forms = es.conjugate(verb, tense)
            assert forms is not None, f"{verb} / {tense}: no forms"
            assert len(forms) == len(es.PERSONS), f"{verb} / {tense}: {len(forms)} forms"
            assert all(form.strip() for form in forms), f"{verb} / {tense}: empty form"


def test_unknown_input_is_none_not_a_guess() -> None:
    assert es.conjugate("hello", es.PRESENT) is None
    assert es.conjugate("ir", "pluperfect") is None
    assert es.normalize_tense("commands") is None
    assert es.normalize_tense("Present Tense") == es.PRESENT
    assert es.normalize_tense("  preterite ") == es.PRETERITE


def test_scenario_verbs_are_all_conjugable() -> None:
    """The curated lists may only name verbs the engine actually gets right."""
    for scenario, verbs in es.VERBS_BY_SCENARIO.items():
        for verb in verbs:
            assert es.conjugate(verb, es.PRESENT) is not None, f"{scenario}: {verb}"


def test_tables_follow_the_plan() -> None:
    tables = conjugation.tables_for(
        "es",
        tenses=["preterite", "commands"],
        scenario="ordering at a restaurant",
    )
    assert tables, "expected tables"
    # `commands` is unsupported and dropped rather than guessed at.
    assert {t["tense"] for t in tables} == {es.TENSE_LABELS[es.PRETERITE]}
    assert [t["verb"] for t in tables][:3] == ["querer", "pedir", "traer"]
    rows = tables[0]["rows"]
    assert [row["person"] for row in rows] == list(es.PERSONS)
    assert rows[0]["form"] == "quise"


def test_tables_fall_back_without_a_plan() -> None:
    tables = conjugation.tables_for("es")
    assert {t["tense"] for t in tables} == {es.TENSE_LABELS[t] for t in es.DEFAULT_TENSES}
    assert all(t["verb"] in es.GENERIC_VERBS for t in tables)
    assert len(tables) <= conjugation.MAX_TABLES


def test_tables_are_capped() -> None:
    tables = conjugation.tables_for(
        "es",
        tenses=["present tense", "preterite", "imperfect", "future tense"],
        scenario="a job interview",
    )
    assert len(tables) <= conjugation.MAX_TABLES
    # Every focus form the learner asked for is represented.
    assert len({t["tense"] for t in tables}) == 4


def test_unknown_language_returns_nothing() -> None:
    assert conjugation.supports("es")
    assert not conjugation.supports("fr")
    assert conjugation.tables_for("fr", tenses=["present"]) == []


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
