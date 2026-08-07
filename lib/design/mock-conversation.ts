/**
 * Shared mock conversation data for design exploration.
 *
 * Every design-inspo variant renders this same conversation so layouts are
 * directly comparable. The shapes here are a sketch of the eventual frontend
 * event contract (see plans/product-vision.md → Technical Direction).
 *
 * Scenario: a regressed-intermediate learner (understands more than they can
 * produce, fumbles tenses and word order) chatting with the tutor about their
 * weekend. Spanish = target language, English = anchor language.
 */

export type CorrectionCategory =
  | "tense"
  | "agreement"
  | "word-order"
  | "vocabulary"
  | "naturalness"

export type CorrectionSeverity = "error" | "unnatural" | "suggestion"

export interface Correction {
  id: string
  /** Exact substring of the turn's `es` text that the correction applies to. */
  original: string
  replacement: string
  category: CorrectionCategory
  severity: CorrectionSeverity
  /** One-line explanation in English, precomputed for instant reveal. */
  explanation: string
}

export interface Turn {
  id: string
  speaker: "learner" | "tutor"
  /** Target-language text (what was actually said). */
  es: string
  /** Anchor-language translation. */
  en: string
  corrections?: Correction[]
}

/** Category → human label, for legends/tooltips. */
export const CATEGORY_LABELS: Record<CorrectionCategory, string> = {
  tense: "Tense",
  agreement: "Agreement",
  "word-order": "Word order",
  vocabulary: "Vocabulary",
  naturalness: "More natural",
}

export const CONVERSATION: Turn[] = [
  {
    id: "t1",
    speaker: "tutor",
    es: "¡Hola! ¿Qué tal tu fin de semana? Cuéntame qué hiciste.",
    en: "Hi! How was your weekend? Tell me what you did.",
  },
  {
    id: "t2",
    speaker: "learner",
    es: "Ayer yo fue al supermercado y compro muchas frutas.",
    en: "Yesterday I went to the supermarket and bought a lot of fruit.",
    corrections: [
      {
        id: "c1",
        original: "fue",
        replacement: "fui",
        category: "tense",
        severity: "error",
        explanation:
          "“Ir” in the first-person preterite is “fui” — “fue” is he/she/it.",
      },
      {
        id: "c2",
        original: "compro",
        replacement: "compré",
        category: "tense",
        severity: "error",
        explanation:
          "Past action, so preterite: “compré”. “Compro” is present tense.",
      },
    ],
  },
  {
    id: "t3",
    speaker: "tutor",
    es: "¡Qué bien! ¿Y qué frutas compraste?",
    en: "Nice! And what fruit did you buy?",
  },
  {
    id: "t4",
    speaker: "learner",
    es: "Compré manzanas, fresas y una roja sandía enorme.",
    en: "I bought apples, strawberries, and a huge red watermelon.",
    corrections: [
      {
        id: "c3",
        original: "una roja sandía enorme",
        replacement: "una sandía roja enorme",
        category: "word-order",
        severity: "error",
        explanation:
          "Color adjectives usually follow the noun in Spanish: “sandía roja”.",
      },
    ],
  },
  {
    id: "t5",
    speaker: "tutor",
    es: "Suena delicioso. ¿Te gusta cocinar con frutas, o las comes solas?",
    en: "Sounds delicious. Do you like cooking with fruit, or do you eat it on its own?",
  },
  {
    // A clean learner turn — no corrections. Variants should show what
    // "silence" (no feedback) looks like.
    id: "t6",
    speaker: "learner",
    es: "Me gusta hacer batidos con mi hermana los domingos.",
    en: "I like making smoothies with my sister on Sundays.",
  },
  {
    id: "t7",
    speaker: "tutor",
    es: "¡Qué rico! ¿Y quién cocina mejor, tú o tu hermana?",
    en: "Yum! And who's the better cook, you or your sister?",
  },
  {
    id: "t8",
    speaker: "learner",
    es: "Ella es más buena que yo en la cocina, sin duda.",
    en: "She's better than me in the kitchen, no doubt.",
    corrections: [
      {
        id: "c4",
        original: "más buena",
        replacement: "mejor",
        category: "vocabulary",
        severity: "unnatural",
        explanation:
          "“Bueno” has an irregular comparative — “mejor”, not “más buena”.",
      },
    ],
  },
  {
    id: "t9",
    speaker: "tutor",
    es: "¡Ja! Muy honesto. ¿Y qué planes tienen para este fin de semana?",
    en: "Ha! Very honest. And what plans do you two have for this weekend?",
  },
]

/**
 * The learner's in-progress utterance, for rendering the "live transcription"
 * state. `esWords` arrives word-by-word; `enPartial` is the live translation
 * so far. No corrections exist yet — corrections only appear after a turn
 * settles.
 */
export const INTERIM = {
  speaker: "learner" as const,
  esWords: ["Nosotros", "vamos", "a", "visitar", "a", "nuestros", "abuelos", "y…"],
  enPartial: "We're going to visit our grandparents and…",
}
