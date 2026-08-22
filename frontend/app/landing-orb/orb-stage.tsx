"use client"

import { useRef, useState } from "react"
import type { AgentState } from "@livekit/components-react"
import { ChevronDown } from "lucide-react"
import {
  motion,
  useMotionValueEvent,
  useReducedMotion,
  useScroll,
  useTransform,
} from "motion/react"

import { AmbientAura } from "@/components/marketing/ambient-aura"
import { ACCENT_TEXT } from "@/components/marketing/brand"
import { cn } from "@/lib/utils"

/**
 * The orb-centered landing's one client island.
 *
 * On land you get the thesis with the top of the Aura rising behind it. Scroll
 * and the orb grows into the stage it occupies during a real session, while a
 * single exchange plays out beneath it: the tutor asks, the learner answers
 * with a wrong preterite, and — only once the turn has settled — the correction
 * surfaces in place. Motion here is doing the explaining: the scrollbar is the
 * turn clock, so the "nobody interrupts you" claim is felt rather than stated.
 *
 * With reduced motion requested, the same content renders resolved and static.
 */

/** The demo beats, in scroll order. */
const BEAT_BOUNDS = [0.4, 0.58, 0.76] as const

const AURA_STATE_BY_BEAT: AgentState[] = [
  "listening",
  "speaking",
  "listening",
  "listening",
]

const TUTOR_LINE = "¿Qué tal tu fin de semana? Cuéntame qué hiciste."

export function OrbStage() {
  const reducedMotion = useReducedMotion()
  const track = useRef<HTMLDivElement>(null)

  const { scrollYProgress } = useScroll({
    target: track,
    offset: ["start start", "end end"],
  })

  const auraScale = useTransform(scrollYProgress, [0, 0.34], [0.4, 1])
  const auraY = useTransform(scrollYProgress, [0, 0.34], ["44%", "0%"])
  const heroOpacity = useTransform(scrollYProgress, [0, 0.16], [1, 0])
  const heroY = useTransform(scrollYProgress, [0, 0.16], [0, -20])
  const transcriptOpacity = useTransform(scrollYProgress, [0.3, 0.4], [0, 1])

  const [beat, setBeat] = useState(0)
  useMotionValueEvent(scrollYProgress, "change", (progress) => {
    const next = BEAT_BOUNDS.filter((bound) => progress >= bound).length
    setBeat((current) => (current === next ? current : next))
  })

  if (reducedMotion) {
    return (
      <section className="mx-auto flex w-full max-w-3xl flex-col items-center gap-12 px-6 py-20 text-center">
        <Thesis />
        <div className="h-[min(42vh,320px)]">
          <AmbientAura state="listening" className="h-full" />
        </div>
        <DemoTranscript beat={3} />
      </section>
    )
  }

  return (
    <div ref={track} className="relative h-[340svh]">
      <div className="sticky top-0 h-svh overflow-hidden">
        {/* The Aura: peeking and small on land, the stage itself once scrolled. */}
        <div className="absolute inset-0 flex items-center justify-center">
          <motion.div
            style={{ scale: auraScale, y: auraY }}
            className="h-[min(58vh,460px)]"
          >
            <AmbientAura
              state={AURA_STATE_BY_BEAT[beat] ?? "listening"}
              className="h-full"
            />
          </motion.div>
        </div>

        {/* Thesis, above the orb, yielding to it as the demo starts. */}
        <motion.div
          style={{ opacity: heroOpacity, y: heroY }}
          className="pointer-events-none relative z-10 mx-auto flex h-full max-w-2xl flex-col items-center px-6 pt-[16vh] text-center"
        >
          <Thesis />
          <ChevronDown
            className="mt-10 size-4 animate-bounce text-muted-foreground/60"
            aria-hidden
          />
        </motion.div>

        {/* The exchange, bottom of the stage, where captions sit in a session. */}
        <motion.div
          style={{ opacity: transcriptOpacity }}
          className="absolute inset-x-0 bottom-[8vh] z-10 mx-auto max-w-2xl px-6"
        >
          <DemoTranscript beat={beat} />
        </motion.div>
      </div>
    </div>
  )
}

function Thesis() {
  return (
    <>
      <h1 className="text-4xl leading-[1.1] font-medium tracking-tight text-balance sm:text-5xl">
        Ten minutes of Spanish, out loud.
      </h1>
      <p className="mt-6 max-w-lg text-lg leading-relaxed text-balance text-muted-foreground">
        A tutor that answers naturally and never talks over you. The corrections
        wait until you have finished the thought.
      </p>
    </>
  )
}

/**
 * One exchange, revealed a beat at a time: the tutor's question, the learner's
 * answer, then the correction — the order it happens in during a session.
 */
function DemoTranscript({ beat }: { beat: number }) {
  return (
    <div className="min-h-40 text-center">
      <motion.p
        animate={{ opacity: beat >= 1 ? 1 : 0, y: beat >= 1 ? 0 : 8 }}
        transition={{ duration: 0.5, ease: "easeOut" }}
        className="text-sm text-muted-foreground"
      >
        {TUTOR_LINE}
      </motion.p>

      <motion.p
        animate={{ opacity: beat >= 2 ? 1 : 0, y: beat >= 2 ? 0 : 8 }}
        transition={{ duration: 0.5, ease: "easeOut" }}
        className="mt-5 text-2xl leading-snug text-balance sm:text-3xl"
      >
        Ayer yo <CorrectedWord revealed={beat >= 3} /> al supermercado.
      </motion.p>

      <motion.p
        animate={{ opacity: beat >= 3 ? 1 : 0 }}
        transition={{ duration: 0.6, ease: "easeOut", delay: beat >= 3 ? 0.15 : 0 }}
        className="mt-5 text-xs text-muted-foreground"
      >
        past tense, first person — and nobody stopped you to say so.
      </motion.p>
    </div>
  )
}

/** `fue → fui`, in place: the settled word steps aside for the better one. */
function CorrectedWord({ revealed }: { revealed: boolean }) {
  return (
    <span className="inline-flex items-baseline gap-2">
      <motion.span
        animate={{ opacity: revealed ? 0.55 : 1 }}
        transition={{ duration: 0.5, ease: "easeOut" }}
        className={cn(
          "underline decoration-[0.06em] underline-offset-[0.24em] transition-colors duration-700",
          revealed
            ? "text-muted-foreground line-through decoration-muted-foreground/30"
            : "decoration-blue-500/50"
        )}
        // Once struck through, the wrong word is a visual before-and-after.
        // Read aloud it would just be a second, contradictory sentence — so
        // exactly one of the two words is ever in the accessibility tree.
        aria-hidden={revealed}
      >
        fue
      </motion.span>
      <motion.span
        animate={{ opacity: revealed ? 1 : 0, y: revealed ? 0 : -6 }}
        transition={{ duration: 0.5, ease: "easeOut" }}
        className={ACCENT_TEXT}
        aria-hidden={!revealed}
      >
        fui
      </motion.span>
    </span>
  )
}
