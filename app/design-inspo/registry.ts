/**
 * Registry of design exploration tasks and their variants.
 * Single source of truth for the design-inspo sidebar and index page.
 */

export interface DesignVariant {
  slug: string
  title: string
  /** One line on what this variant is testing. */
  blurb: string
}

export interface DesignTask {
  slug: string
  title: string
  description: string
  variants: DesignVariant[]
}

export const DESIGN_TASKS: DesignTask[] = [
  {
    slug: "chat-layout",
    title: "Chat layout",
    description:
      "Where the Aura lives, where transcription goes, and how it all fits on the page.",
    variants: [
      {
        slug: "aura-stage",
        title: "Aura stage",
        blurb:
          "Hero Aura center-top; current utterance as a large subtitle; history recedes upward.",
      },
      {
        slug: "split-columns",
        title: "Split columns",
        blurb:
          "Spanish and English in parallel columns, aligned per turn; modest Aura above.",
      },
      {
        slug: "stage-split",
        title: "Stage split",
        blurb:
          "Hybrid: left-aligned stage, one pinned context turn, collapsible English column, pause as a first-class state.",
      },
      {
        slug: "focus-flow",
        title: "Focus flow",
        blurb:
          "Single reading column, document-like; small Aura docked at top; current turn is largest.",
      },
      {
        slug: "ambient",
        title: "Ambient immersion",
        blurb:
          "Oversized Aura as ambient backdrop; film-caption text at the bottom; transcript hidden by default.",
      },
      {
        slug: "text-first",
        title: "Text first",
        blurb:
          "No orb at all — typographic state indicator; the transcript is the entire interface.",
      },
      {
        slug: "side-stage",
        title: "Side stage",
        blurb:
          "Aura and controls docked in a right rail; transcript owns the main column.",
      },
    ],
  },
]
