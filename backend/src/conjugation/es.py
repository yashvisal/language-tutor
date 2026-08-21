"""The Spanish conjugation engine.

Everything Spanish in the Review tab lives here: the regular paradigms, the
irregular overrides, the tense names the learner sees, and which verbs a
scenario is actually made of. The layer above (`conjugation/__init__.py`, and
the RPC in `review.py`) knows only "a language code" and "a table".

Coverage:

- **Tenses**: present, preterite, imperfect, future, conditional, present
  subjunctive, present perfect. That is the frontend's focus-form catalog minus
  `commands` — the imperative has a different person set (no `yo`), so it is a
  different table shape and deliberately out of scope.
- **Regulars**: -ar / -er / -ir, plus the orthographic fixes an -ar verb needs
  in front of a front vowel (`buscar` -> `busque`, `llegar` -> `llegue`,
  `cruzar` -> `cruce`).
- **Irregulars**: hand-written overrides for the 25 highest-frequency irregular
  verbs. An override supplies only the cells that are actually irregular — a
  tense it does not mention is built by the regular engine, so `salir` gets its
  irregular present and future stem while its preterite stays regular.

Known limits, all deliberate: -er/-ir orthographic families outside the override
list (`coger`, `leer`) come out regular, and so do stem-changing verbs outside
it. The scenario verb lists only ever name verbs the engine gets right — a
hand-picked list is the whole point of a shipped table.
"""

from __future__ import annotations

from dataclasses import dataclass, field

# The rows of every table, in reading order. `vosotros` is included because the
# learner meets it in written material even if they never say it.
PERSONS: tuple[str, ...] = ("yo", "tú", "él/ella", "nosotros", "vosotros", "ellos")

PRESENT = "present"
PRETERITE = "preterite"
IMPERFECT = "imperfect"
FUTURE = "future"
CONDITIONAL = "conditional"
SUBJUNCTIVE = "present subjunctive"
PERFECT = "present perfect"

# What the learner sees as the table's heading. Bilingual, matching the labels
# they already picked from on the pre-flight screen (`TENSES_BY_LANGUAGE` in
# `frontend/lib/session/plan.ts`).
TENSE_LABELS: dict[str, str] = {
    PRESENT: "Present · presente",
    PRETERITE: "Preterite · pretérito",
    IMPERFECT: "Imperfect · imperfecto",
    FUTURE: "Future · futuro",
    CONDITIONAL: "Conditional · condicional",
    SUBJUNCTIVE: "Subjunctive · subjuntivo",
    PERFECT: "Present perfect · pretérito perfecto",
}

# The plan's focus-form strings as the frontend sends them, plus the obvious
# synonyms a free-text plan might carry. Anything unmapped is dropped rather
# than guessed.
_TENSE_ALIASES: dict[str, str] = {
    "present": PRESENT,
    "present tense": PRESENT,
    "presente": PRESENT,
    "preterite": PRETERITE,
    "preterit": PRETERITE,
    "pretérito": PRETERITE,
    "simple past": PRETERITE,
    "past tense": PRETERITE,
    "imperfect": IMPERFECT,
    "imperfecto": IMPERFECT,
    "future": FUTURE,
    "future tense": FUTURE,
    "futuro": FUTURE,
    "conditional": CONDITIONAL,
    "condicional": CONDITIONAL,
    "subjunctive": SUBJUNCTIVE,
    "present subjunctive": SUBJUNCTIVE,
    "subjuntivo": SUBJUNCTIVE,
    "present perfect": PERFECT,
    "perfect": PERFECT,
    "pretérito perfecto": PERFECT,
}

# When the plan names no forms at all: the two tenses a conversation at this
# level is actually made of.
DEFAULT_TENSES: tuple[str, ...] = (PRESENT, PRETERITE)

# --- regular paradigms ---------------------------------------------------

_REGULAR: dict[str, dict[str, tuple[str, ...]]] = {
    PRESENT: {
        "ar": ("o", "as", "a", "amos", "áis", "an"),
        "er": ("o", "es", "e", "emos", "éis", "en"),
        "ir": ("o", "es", "e", "imos", "ís", "en"),
    },
    PRETERITE: {
        "ar": ("é", "aste", "ó", "amos", "asteis", "aron"),
        "er": ("í", "iste", "ió", "imos", "isteis", "ieron"),
        "ir": ("í", "iste", "ió", "imos", "isteis", "ieron"),
    },
    IMPERFECT: {
        "ar": ("aba", "abas", "aba", "ábamos", "abais", "aban"),
        "er": ("ía", "ías", "ía", "íamos", "íais", "ían"),
        "ir": ("ía", "ías", "ía", "íamos", "íais", "ían"),
    },
    SUBJUNCTIVE: {
        "ar": ("e", "es", "e", "emos", "éis", "en"),
        "er": ("a", "as", "a", "amos", "áis", "an"),
        "ir": ("a", "as", "a", "amos", "áis", "an"),
    },
}

# Future and conditional hang off the whole infinitive (or an irregular stem),
# not off the -ar/-er/-ir class.
_FUTURE_ENDINGS = ("é", "ás", "á", "emos", "éis", "án")
_CONDITIONAL_ENDINGS = ("ía", "ías", "ía", "íamos", "íais", "ían")

# The auxiliary of the compound tense, in the present.
_HABER_PRESENT = ("he", "has", "ha", "hemos", "habéis", "han")


@dataclass(frozen=True)
class Irregular:
    """The cells one verb overrides. Everything unlisted stays regular.

    `forms` is keyed by tense and holds all six persons in `PERSONS` order;
    `stem` replaces the infinitive in the future and conditional; `participle`
    replaces the regular one in the present perfect.
    """

    forms: dict[str, tuple[str, ...]] = field(default_factory=dict)
    stem: str | None = None
    participle: str | None = None


# The 25 highest-frequency irregular verbs. Written out rather than derived:
# every rule that would generate these has exceptions, and a wrong ending in a
# study table is worse than a long literal.
IRREGULARS: dict[str, Irregular] = {
    "ser": Irregular(
        forms={
            PRESENT: ("soy", "eres", "es", "somos", "sois", "son"),
            PRETERITE: ("fui", "fuiste", "fue", "fuimos", "fuisteis", "fueron"),
            IMPERFECT: ("era", "eras", "era", "éramos", "erais", "eran"),
            SUBJUNCTIVE: ("sea", "seas", "sea", "seamos", "seáis", "sean"),
        },
    ),
    "estar": Irregular(
        forms={
            PRESENT: ("estoy", "estás", "está", "estamos", "estáis", "están"),
            PRETERITE: (
                "estuve",
                "estuviste",
                "estuvo",
                "estuvimos",
                "estuvisteis",
                "estuvieron",
            ),
            SUBJUNCTIVE: ("esté", "estés", "esté", "estemos", "estéis", "estén"),
        },
    ),
    "ir": Irregular(
        forms={
            PRESENT: ("voy", "vas", "va", "vamos", "vais", "van"),
            PRETERITE: ("fui", "fuiste", "fue", "fuimos", "fuisteis", "fueron"),
            IMPERFECT: ("iba", "ibas", "iba", "íbamos", "ibais", "iban"),
            SUBJUNCTIVE: ("vaya", "vayas", "vaya", "vayamos", "vayáis", "vayan"),
        },
    ),
    "tener": Irregular(
        forms={
            PRESENT: ("tengo", "tienes", "tiene", "tenemos", "tenéis", "tienen"),
            PRETERITE: ("tuve", "tuviste", "tuvo", "tuvimos", "tuvisteis", "tuvieron"),
            SUBJUNCTIVE: ("tenga", "tengas", "tenga", "tengamos", "tengáis", "tengan"),
        },
        stem="tendr",
    ),
    "hacer": Irregular(
        forms={
            PRESENT: ("hago", "haces", "hace", "hacemos", "hacéis", "hacen"),
            PRETERITE: ("hice", "hiciste", "hizo", "hicimos", "hicisteis", "hicieron"),
            SUBJUNCTIVE: ("haga", "hagas", "haga", "hagamos", "hagáis", "hagan"),
        },
        stem="har",
        participle="hecho",
    ),
    "poder": Irregular(
        forms={
            PRESENT: ("puedo", "puedes", "puede", "podemos", "podéis", "pueden"),
            PRETERITE: ("pude", "pudiste", "pudo", "pudimos", "pudisteis", "pudieron"),
            SUBJUNCTIVE: ("pueda", "puedas", "pueda", "podamos", "podáis", "puedan"),
        },
        stem="podr",
    ),
    "decir": Irregular(
        forms={
            PRESENT: ("digo", "dices", "dice", "decimos", "decís", "dicen"),
            PRETERITE: ("dije", "dijiste", "dijo", "dijimos", "dijisteis", "dijeron"),
            SUBJUNCTIVE: ("diga", "digas", "diga", "digamos", "digáis", "digan"),
        },
        stem="dir",
        participle="dicho",
    ),
    "venir": Irregular(
        forms={
            PRESENT: ("vengo", "vienes", "viene", "venimos", "venís", "vienen"),
            PRETERITE: ("vine", "viniste", "vino", "vinimos", "vinisteis", "vinieron"),
            SUBJUNCTIVE: ("venga", "vengas", "venga", "vengamos", "vengáis", "vengan"),
        },
        stem="vendr",
    ),
    "ver": Irregular(
        forms={
            PRESENT: ("veo", "ves", "ve", "vemos", "veis", "ven"),
            PRETERITE: ("vi", "viste", "vio", "vimos", "visteis", "vieron"),
            IMPERFECT: ("veía", "veías", "veía", "veíamos", "veíais", "veían"),
            SUBJUNCTIVE: ("vea", "veas", "vea", "veamos", "veáis", "vean"),
        },
        participle="visto",
    ),
    "dar": Irregular(
        forms={
            PRESENT: ("doy", "das", "da", "damos", "dais", "dan"),
            PRETERITE: ("di", "diste", "dio", "dimos", "disteis", "dieron"),
            SUBJUNCTIVE: ("dé", "des", "dé", "demos", "deis", "den"),
        },
    ),
    "saber": Irregular(
        forms={
            PRESENT: ("sé", "sabes", "sabe", "sabemos", "sabéis", "saben"),
            PRETERITE: ("supe", "supiste", "supo", "supimos", "supisteis", "supieron"),
            SUBJUNCTIVE: ("sepa", "sepas", "sepa", "sepamos", "sepáis", "sepan"),
        },
        stem="sabr",
    ),
    "querer": Irregular(
        forms={
            PRESENT: ("quiero", "quieres", "quiere", "queremos", "queréis", "quieren"),
            PRETERITE: ("quise", "quisiste", "quiso", "quisimos", "quisisteis", "quisieron"),
            SUBJUNCTIVE: ("quiera", "quieras", "quiera", "queramos", "queráis", "quieran"),
        },
        stem="querr",
    ),
    "poner": Irregular(
        forms={
            PRESENT: ("pongo", "pones", "pone", "ponemos", "ponéis", "ponen"),
            PRETERITE: ("puse", "pusiste", "puso", "pusimos", "pusisteis", "pusieron"),
            SUBJUNCTIVE: ("ponga", "pongas", "ponga", "pongamos", "pongáis", "pongan"),
        },
        stem="pondr",
        participle="puesto",
    ),
    "salir": Irregular(
        forms={
            PRESENT: ("salgo", "sales", "sale", "salimos", "salís", "salen"),
            SUBJUNCTIVE: ("salga", "salgas", "salga", "salgamos", "salgáis", "salgan"),
        },
        stem="saldr",
    ),
    "haber": Irregular(
        forms={
            PRESENT: _HABER_PRESENT,
            PRETERITE: ("hube", "hubiste", "hubo", "hubimos", "hubisteis", "hubieron"),
            SUBJUNCTIVE: ("haya", "hayas", "haya", "hayamos", "hayáis", "hayan"),
        },
        stem="habr",
    ),
    "conocer": Irregular(
        forms={
            PRESENT: ("conozco", "conoces", "conoce", "conocemos", "conocéis", "conocen"),
            SUBJUNCTIVE: (
                "conozca",
                "conozcas",
                "conozca",
                "conozcamos",
                "conozcáis",
                "conozcan",
            ),
        },
    ),
    "pedir": Irregular(
        forms={
            PRESENT: ("pido", "pides", "pide", "pedimos", "pedís", "piden"),
            PRETERITE: ("pedí", "pediste", "pidió", "pedimos", "pedisteis", "pidieron"),
            SUBJUNCTIVE: ("pida", "pidas", "pida", "pidamos", "pidáis", "pidan"),
        },
    ),
    "dormir": Irregular(
        forms={
            PRESENT: ("duermo", "duermes", "duerme", "dormimos", "dormís", "duermen"),
            PRETERITE: ("dormí", "dormiste", "durmió", "dormimos", "dormisteis", "durmieron"),
            SUBJUNCTIVE: ("duerma", "duermas", "duerma", "durmamos", "durmáis", "duerman"),
        },
    ),
    "jugar": Irregular(
        forms={
            PRESENT: ("juego", "juegas", "juega", "jugamos", "jugáis", "juegan"),
            SUBJUNCTIVE: ("juegue", "juegues", "juegue", "juguemos", "juguéis", "jueguen"),
        },
    ),
    "pensar": Irregular(
        forms={
            PRESENT: ("pienso", "piensas", "piensa", "pensamos", "pensáis", "piensan"),
            SUBJUNCTIVE: ("piense", "pienses", "piense", "pensemos", "penséis", "piensen"),
        },
    ),
    "volver": Irregular(
        forms={
            PRESENT: ("vuelvo", "vuelves", "vuelve", "volvemos", "volvéis", "vuelven"),
            SUBJUNCTIVE: ("vuelva", "vuelvas", "vuelva", "volvamos", "volváis", "vuelvan"),
        },
        participle="vuelto",
    ),
    "sentir": Irregular(
        forms={
            PRESENT: ("siento", "sientes", "siente", "sentimos", "sentís", "sienten"),
            PRETERITE: ("sentí", "sentiste", "sintió", "sentimos", "sentisteis", "sintieron"),
            SUBJUNCTIVE: ("sienta", "sientas", "sienta", "sintamos", "sintáis", "sientan"),
        },
    ),
    "seguir": Irregular(
        forms={
            PRESENT: ("sigo", "sigues", "sigue", "seguimos", "seguís", "siguen"),
            PRETERITE: ("seguí", "seguiste", "siguió", "seguimos", "seguisteis", "siguieron"),
            SUBJUNCTIVE: ("siga", "sigas", "siga", "sigamos", "sigáis", "sigan"),
        },
    ),
    "empezar": Irregular(
        forms={
            PRESENT: ("empiezo", "empiezas", "empieza", "empezamos", "empezáis", "empiezan"),
            PRETERITE: (
                "empecé",
                "empezaste",
                "empezó",
                "empezamos",
                "empezasteis",
                "empezaron",
            ),
            SUBJUNCTIVE: (
                "empiece",
                "empieces",
                "empiece",
                "empecemos",
                "empecéis",
                "empiecen",
            ),
        },
    ),
    "traer": Irregular(
        forms={
            PRESENT: ("traigo", "traes", "trae", "traemos", "traéis", "traen"),
            PRETERITE: ("traje", "trajiste", "trajo", "trajimos", "trajisteis", "trajeron"),
            SUBJUNCTIVE: ("traiga", "traigas", "traiga", "traigamos", "traigáis", "traigan"),
        },
        participle="traído",
    ),
}

# --- which verbs a session is made of ------------------------------------
#
# Keyed by the curated scenario strings in `frontend/lib/session/plan.ts` (and
# matched against a free-text topic too, which usually misses — that is what the
# fallback is for). Every verb named here is one the engine gets right.

GENERIC_VERBS: tuple[str, ...] = ("ser", "estar", "tener", "hacer")

VERBS_BY_SCENARIO: dict[str, tuple[str, ...]] = {
    "ordering at a restaurant": ("querer", "pedir", "traer", "tomar"),
    "catching up with a friend": ("estar", "hacer", "ver", "hablar"),
    "telling a story about last weekend": ("ir", "hacer", "ver", "salir"),
    "asking for directions": ("ir", "seguir", "estar", "saber"),
    "a job interview": ("ser", "tener", "trabajar", "saber"),
    "free conversation": GENERIC_VERBS,
}


def verbs_for(scenario: str | None = None, topic: str | None = None) -> tuple[str, ...]:
    """The verbs this session's tables are built from: scenario, topic, generic."""
    for key in (scenario, topic):
        if key:
            verbs = VERBS_BY_SCENARIO.get(key.strip().lower())
            if verbs:
                return verbs
    return GENERIC_VERBS


# --- the engine ----------------------------------------------------------


def normalize_tense(name: str) -> str | None:
    """A plan's focus-form string as an engine tense, or None if we cannot render it."""
    return _TENSE_ALIASES.get(" ".join(name.split()).lower())


def _spell_fix(stem: str) -> str:
    """Keep an -ar verb's stem sounding the same in front of a front vowel.

    `buscar` -> `busqué`, `llegar` -> `llegué`, `cruzar` -> `crucé`. Only -ar
    verbs need it: theirs are the endings that start with `e`.
    """
    if stem.endswith("c"):
        return stem[:-1] + "qu"
    if stem.endswith("g"):
        return stem[:-1] + "gu"
    if stem.endswith("z"):
        return stem[:-1] + "c"
    return stem


def participle(verb: str) -> str | None:
    """The past participle, irregular overrides first."""
    infinitive = verb.strip().lower()
    override = IRREGULARS.get(infinitive)
    if override is not None and override.participle:
        return override.participle
    if len(infinitive) < 2:
        return None
    stem, ending = infinitive[:-2], infinitive[-2:]
    if ending == "ar":
        return stem + "ado"
    if ending in ("er", "ir"):
        return stem + "ido"
    return None


def conjugate(verb: str, tense: str) -> tuple[str, ...] | None:
    """The six forms of one verb in one tense, in `PERSONS` order.

    Returns None for anything that is not an -ar/-er/-ir infinitive, or a tense
    this engine does not know.
    """
    infinitive = verb.strip().lower()
    # Two characters, not three: `ir` is a whole infinitive with an empty stem.
    if len(infinitive) < 2:
        return None
    stem, ending = infinitive[:-2], infinitive[-2:]
    if ending not in ("ar", "er", "ir"):
        return None

    override = IRREGULARS.get(infinitive)

    if tense == PERFECT:
        past = participle(infinitive)
        if past is None:
            return None
        return tuple(f"{aux} {past}" for aux in _HABER_PRESENT)

    if override is not None and tense in override.forms:
        return override.forms[tense]

    if tense in (FUTURE, CONDITIONAL):
        base = override.stem if override is not None and override.stem else infinitive
        endings = _FUTURE_ENDINGS if tense == FUTURE else _CONDITIONAL_ENDINGS
        return tuple(base + suffix for suffix in endings)

    endings = _REGULAR.get(tense, {}).get(ending)
    if endings is None:
        return None

    if ending == "ar" and tense == SUBJUNCTIVE:
        fixed = _spell_fix(stem)
        return tuple(fixed + suffix for suffix in endings)
    if ending == "ar" and tense == PRETERITE:
        # Only the `yo` form takes a front vowel; the rest keep the plain stem.
        return tuple(
            (_spell_fix(stem) if index == 0 else stem) + suffix
            for index, suffix in enumerate(endings)
        )
    return tuple(stem + suffix for suffix in endings)


def table(verb: str, tense: str) -> dict | None:
    """One rendered table, or None if the engine cannot build it."""
    forms = conjugate(verb, tense)
    if forms is None or len(forms) != len(PERSONS):
        return None
    return {
        "verb": verb.strip().lower(),
        "tense": TENSE_LABELS.get(tense, tense),
        "rows": [
            {"person": person, "form": form} for person, form in zip(PERSONS, forms, strict=True)
        ],
    }


def tables(
    *,
    tenses: list[str],
    scenario: str | None = None,
    topic: str | None = None,
    max_tables: int = 12,
) -> list[dict]:
    """The session's tables: the plan's focus tenses across the scenario's verbs.

    Ordered tense-major (all of the present, then all of the preterite), which is
    how a learner reads them: one form at a time across the verbs they are about
    to use, not one verb at a time across forms they did not ask for.
    """
    wanted: list[str] = []
    for name in tenses:
        normalized = normalize_tense(name)
        if normalized and normalized not in wanted:
            wanted.append(normalized)
    if not wanted:
        wanted = list(DEFAULT_TENSES)

    verbs = verbs_for(scenario, topic)
    # Every focus form the learner picked gets a table — dropping one they asked
    # for is worse than showing it with fewer verbs — so the width shrinks as
    # the focus widens rather than the list being truncated. The frontend caps a
    # plan at six focus forms, so this tops out at twelve tables.
    if len(wanted) == 1:
        per_tense = 4
    elif len(wanted) == 2:
        per_tense = 3
    else:
        per_tense = 2
    per_tense = max(1, min(len(verbs), per_tense))

    built: list[dict] = []
    for tense in wanted:
        for verb in verbs[:per_tense]:
            if len(built) >= max_tables:
                return built
            rendered = table(verb, tense)
            if rendered is not None:
                built.append(rendered)
    return built
