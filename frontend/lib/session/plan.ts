/**
 * The session plan's catalogs, bounds, and persistence.
 *
 * Imported from both sides: the pre-flight screen renders the catalogs, and
 * `app/api/token/route.ts` normalizes an incoming plan with `boundPlan` before
 * signing it into dispatch metadata. So this module stays dependency-free and
 * free of browser-only APIs at module scope — `subscribeToPlan`/`savePlan`
 * guard on `window` themselves, and `planSnapshot` is only ever reached from
 * the browser half of `useSyncExternalStore`.
 *
 * Nothing here is Spanish-specific by construction: the tense catalog is keyed
 * by target language code, and a second language adds an entry rather than an
 * `if`.
 */

import type { SessionPlan } from "./contract"
import { TARGET_LANGUAGE } from "./protocol"

/* -------------------------------------------------------------------------- */
/*  Catalogs                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * A catalog entry. `value` is what travels on the wire and reaches the tutor
 * prompt, so it reads as a phrase rather than an id; `label` is what the
 * learner sees. They diverge only where the display form is shorter than the
 * prompt-ready one.
 */
export interface PlanOption {
  value: string
  label: string
}

/**
 * Situations the tutor can play out. Short and curated on purpose — a long list
 * is a decision the learner has to make before they have said anything. The
 * free-text topic below is the escape hatch.
 */
export const SCENARIOS: PlanOption[] = [
  { value: "ordering at a restaurant", label: "Ordering at a restaurant" },
  { value: "catching up with a friend", label: "Catching up with a friend" },
  {
    value: "telling a story about last weekend",
    label: "Telling a story about last weekend",
  },
  { value: "asking for directions", label: "Asking for directions" },
  { value: "a job interview", label: "A job interview" },
  { value: "free conversation", label: "Free conversation" },
]

/**
 * Focus forms per target language. Display strings are the names a learner of
 * that language would recognize (with the native term alongside), while the
 * value stays a plain English form name the tutor prompt can use directly.
 */
export const TENSES_BY_LANGUAGE: Record<string, PlanOption[]> = {
  es: [
    { value: "present tense", label: "Present · presente" },
    { value: "preterite", label: "Preterite · pretérito" },
    { value: "imperfect", label: "Imperfect · imperfecto" },
    { value: "present perfect", label: "Present perfect · pretérito perfecto" },
    { value: "future tense", label: "Future · futuro" },
    { value: "conditional", label: "Conditional · condicional" },
    { value: "present subjunctive", label: "Subjunctive · subjuntivo" },
    { value: "commands", label: "Commands · imperativo" },
  ],
}

/** The focus forms offered for a target language; empty if we have no catalog. */
export function tensesFor(language: string = TARGET_LANGUAGE): PlanOption[] {
  return TENSES_BY_LANGUAGE[language] ?? []
}

/**
 * Display names for the languages we can be configured for. The pre-flight
 * says the name out loud ("Where are you with Spanish right now?"), and a
 * hardcoded "Spanish" in that sentence is exactly the architectural
 * Spanish-ness the vision doc rules out (decision #3, 2026-08-06).
 */
export const LANGUAGE_NAMES: Record<string, string> = {
  es: "Spanish",
  en: "English",
}

export const TARGET_LANGUAGE_NAME =
  LANGUAGE_NAMES[TARGET_LANGUAGE] ?? TARGET_LANGUAGE

/**
 * The example that makes "anything you want the tutor to push you on?" a real
 * question rather than an empty box — necessarily language-specific, so it
 * lives in a per-language catalog like the forms above rather than inline in
 * the component.
 */
export const FOCUS_NOTE_PLACEHOLDER_BY_LANGUAGE: Record<string, string> = {
  es: "e.g. when to use he comido vs comí",
}

export function focusNotePlaceholder(
  language: string = TARGET_LANGUAGE
): string {
  return (
    FOCUS_NOTE_PLACEHOLDER_BY_LANGUAGE[language] ??
    "e.g. a form you always get wrong"
  )
}

/**
 * The level values, as literal types. This is the catalog's one home: the
 * Convex argument validator (`convex/validators.ts`) is built from these very
 * strings, so a level the UI can offer is a level the database will accept and
 * nothing has to be kept in sync by hand.
 */
export const LEVEL_VALUES = [
  "beginner",
  "understands more than they can say",
  "comfortable, wants polish",
] as const

export type LevelValue = (typeof LEVEL_VALUES)[number]

export interface LevelOption extends PlanOption {
  value: LevelValue
}

/**
 * Self-declared level. The middle option is the product's reference learner
 * (see the vision doc, decision #4) and is therefore the default — a learner
 * who taps nothing has still told the tutor something true.
 */
export const LEVELS: LevelOption[] = [
  { value: LEVEL_VALUES[0], label: "Just starting out" },
  { value: LEVEL_VALUES[1], label: "I understand more than I can say" },
  { value: LEVEL_VALUES[2], label: "Comfortable, want polish" },
]

export const DEFAULT_LEVEL: LevelValue = LEVEL_VALUES[1]

export const EMPTY_PLAN: SessionPlan = {
  scenario: null,
  topic: null,
  tenses: [],
  focusNote: null,
  note: null,
  vocab: [],
  level: DEFAULT_LEVEL,
}

/* -------------------------------------------------------------------------- */
/*  Bounds                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Caps on everything free-text. Nothing is allowlisted — a learner may want to
 * talk about anything, and a scenario the catalog doesn't have is still a valid
 * plan — but this is unauthenticated input that ends up in a signed token and
 * in a model prompt, so length and count are bounded. Mirrored nowhere else:
 * the route calls `boundPlan`, the UI enforces the same caps as input limits.
 */
export const PLAN_LIMITS = {
  topicChars: 140,
  scenarioChars: 80,
  // The two open notes are sentences, not essays — long enough for "when to
  // use he comido vs comí", short enough that nobody writes the tutor's
  // prompt for it.
  focusNoteChars: 140,
  noteChars: 140,
  levelChars: 60,
  tenseChars: 40,
  maxTenses: 6,
  vocabChars: 40,
  maxVocab: 8,
} as const

function boundString(value: unknown, max: number): string | null {
  if (typeof value !== "string") return null
  const trimmed = value.trim().replace(/\s+/g, " ").slice(0, max)
  return trimmed || null
}

function boundList(value: unknown, max: number, chars: number): string[] {
  if (!Array.isArray(value)) return []
  const out: string[] = []
  for (const item of value) {
    const bounded = boundString(item, chars)
    if (bounded && !out.includes(bounded)) out.push(bounded)
    if (out.length === max) break
  }
  return out
}

/**
 * Normalize anything plan-shaped into a `SessionPlan`. Total: an absent,
 * malformed or hostile input degrades to the empty plan rather than failing the
 * request, because a session with no declared intent is a perfectly good
 * session and refusing to mint a token would be the worse failure.
 */
export function boundPlan(input: unknown): SessionPlan {
  if (!input || typeof input !== "object") return EMPTY_PLAN
  const raw = input as Record<string, unknown>
  return {
    scenario: boundString(raw.scenario, PLAN_LIMITS.scenarioChars),
    topic: boundString(raw.topic, PLAN_LIMITS.topicChars),
    tenses: boundList(
      raw.tenses,
      PLAN_LIMITS.maxTenses,
      PLAN_LIMITS.tenseChars
    ),
    focusNote: boundString(raw.focusNote, PLAN_LIMITS.focusNoteChars),
    note: boundString(raw.note, PLAN_LIMITS.noteChars),
    vocab: boundList(raw.vocab, PLAN_LIMITS.maxVocab, PLAN_LIMITS.vocabChars),
    level: boundString(raw.level, PLAN_LIMITS.levelChars),
  }
}

/* -------------------------------------------------------------------------- */
/*  Suggestion                                                                */
/* -------------------------------------------------------------------------- */

const SUGGESTED_VOCAB = [
  "food and ordering",
  "travel",
  "work and study",
  "family",
  "weekend plans",
  "feelings",
  "the neighborhood",
]

function pick<T>(items: readonly T[]): T {
  return items[Math.floor(Math.random() * items.length)]!
}

/**
 * A complete, sensible plan in one tap — the fastest path from "I have fifteen
 * minutes" to speaking. Deliberately random rather than adaptive: there is no
 * learner model yet, and pretending otherwise would be a lie. Keeps whatever
 * level the learner already declared.
 */
export function suggestPlan(
  level: string | null = DEFAULT_LEVEL,
  language: string = TARGET_LANGUAGE
): SessionPlan {
  const tenses = tensesFor(language)
  const focus = tenses.length > 0 ? [pick(tenses).value] : []
  return {
    scenario: pick(SCENARIOS).value,
    topic: null,
    tenses: focus,
    // A suggestion fills the choices, never the open notes: inventing a
    // sentence the learner did not say and handing it to the tutor as
    // "what they asked about" would be a lie.
    focusNote: null,
    note: null,
    vocab: [pick(SUGGESTED_VOCAB)],
    level: level ?? DEFAULT_LEVEL,
  }
}

/* -------------------------------------------------------------------------- */
/*  Persistence                                                               */
/* -------------------------------------------------------------------------- */

/**
 * Where the last plan lives until sessions are rows in a database. Versioned in
 * the key so a shape change is a miss, not a parse error.
 */
const STORAGE_KEY = "tutor.session-plan.v1"

/**
 * The stored plan is read as an external store rather than seeded into state
 * from an effect: it does not exist during prerender, and any read at render
 * time would make the server and client markup disagree. `useSyncExternalStore`
 * is the one API that lets the surface render the server's answer (an empty
 * plan) and then the browser's, with no hydration mismatch and no cascading
 * render.
 *
 * That contract requires a STABLE snapshot — returning a fresh object on every
 * call would loop — so the parsed plan is memoized against the raw string it
 * came from.
 */
const listeners = new Set<() => void>()
let cachedRaw: string | null = null
let cachedPlan: SessionPlan = EMPTY_PLAN

function notify() {
  for (const listener of listeners) listener()
}

export function subscribeToPlan(listener: () => void): () => void {
  if (typeof window === "undefined") return () => {}
  listeners.add(listener)
  // Another tab writing the same key is the same event as this one writing it.
  window.addEventListener("storage", notify)
  return () => {
    listeners.delete(listener)
    if (listeners.size === 0) window.removeEventListener("storage", notify)
  }
}

/** The learner's last plan, so a second session starts pre-filled. */
export function planSnapshot(): SessionPlan {
  let raw: string | null = null
  try {
    raw = window.localStorage.getItem(STORAGE_KEY)
  } catch {
    raw = null
  }
  if (raw === cachedRaw) return cachedPlan
  cachedRaw = raw
  try {
    const plan = raw ? boundPlan(JSON.parse(raw)) : EMPTY_PLAN
    cachedPlan = { ...plan, level: plan.level ?? DEFAULT_LEVEL }
  } catch {
    cachedPlan = EMPTY_PLAN
  }
  return cachedPlan
}

/** Nothing is stored on the server, and pretending otherwise breaks hydration. */
export function serverPlanSnapshot(): SessionPlan {
  return EMPTY_PLAN
}

export function savePlan(plan: SessionPlan): void {
  if (typeof window === "undefined") return
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(plan))
  } catch {
    // Private mode, quota, a disabled store: the plan is a convenience, and
    // losing it costs the learner three taps next time.
  }
  notify()
}
