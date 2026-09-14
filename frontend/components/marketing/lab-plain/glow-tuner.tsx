"use client"

import { useEffect, useState } from "react"

/**
 * A dev-only dial for the hero's stage light, so the halo can be judged by
 * eye at several strengths instead of by editing a class and reloading.
 *
 * Four numbers, all CSS variables on the root: the halo's opacity, spread
 * and blur (read by the demo's glow), and the opacity of the wide wash the
 * shipped landing puts behind the whole hero. Presets bracket the range:
 * "Chosen" is what Yash settled on (2026-09-13) and the page's default,
 * "Paper" is the tight halo from the wireframes, "Live" is what ships today. Values persist in localStorage so a reload keeps
 * the dial where it was; read them off the panel and tell me the numbers.
 */

type Glow = { opacity: number; scale: number; blur: number; wash: number }

const PRESETS: Record<string, Glow> = {
  Chosen: { opacity: 0.5, scale: 2.3, blur: 108, wash: 0.2 },
  Paper: { opacity: 0.22, scale: 1.25, blur: 40, wash: 0 },
  Live: { opacity: 0.25, scale: 1.5, blur: 64, wash: 0.25 },
}

const STORAGE_KEY = "lab-glow"

function apply(glow: Glow) {
  const root = document.documentElement.style
  root.setProperty("--lab-glow-opacity", String(glow.opacity))
  root.setProperty("--lab-glow-scale", String(glow.scale))
  root.setProperty("--lab-glow-blur", `${glow.blur}px`)
  root.setProperty("--lab-wash-opacity", String(glow.wash))
}

export function GlowTuner() {
  // Lazy so the saved dial is the first render's value: a setState in an
  // effect would paint the preset, then repaint the saved numbers.
  const [glow, setGlow] = useState<Glow>(() => {
    if (typeof window === "undefined") return PRESETS.Chosen!
    const saved = localStorage.getItem(STORAGE_KEY)
    return saved ? (JSON.parse(saved) as Glow) : PRESETS.Chosen!
  })
  const [open, setOpen] = useState(true)

  useEffect(() => {
    apply(glow)
    localStorage.setItem(STORAGE_KEY, JSON.stringify(glow))
  }, [glow])

  const set = (key: keyof Glow) => (e: React.ChangeEvent<HTMLInputElement>) =>
    setGlow((g) => ({ ...g, [key]: Number(e.target.value) }))

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="fixed right-4 bottom-4 z-50 rounded-full border border-border bg-background/90 px-3 py-1.5 font-mono text-xs shadow-sm backdrop-blur"
      >
        glow
      </button>
    )
  }

  return (
    <div className="fixed right-4 bottom-4 z-50 w-64 rounded-xl border border-border bg-background/95 p-4 font-mono text-xs shadow-lg backdrop-blur">
      <div className="mb-3 flex items-center justify-between">
        <span className="font-medium">Stage light</span>
        <button
          type="button"
          onClick={() => setOpen(false)}
          className="text-muted-foreground hover:text-foreground"
        >
          hide
        </button>
      </div>

      <Dial
        label="halo opacity"
        value={glow.opacity}
        min={0}
        max={0.6}
        step={0.01}
        onChange={set("opacity")}
      />
      <Dial
        label="halo spread"
        value={glow.scale}
        min={1}
        max={3}
        step={0.05}
        onChange={set("scale")}
      />
      <Dial
        label="halo blur"
        value={glow.blur}
        min={16}
        max={160}
        step={4}
        onChange={set("blur")}
        unit="px"
      />
      <Dial
        label="page wash"
        value={glow.wash}
        min={0}
        max={0.4}
        step={0.01}
        onChange={set("wash")}
      />

      <div className="mt-3 flex gap-1.5">
        {Object.entries(PRESETS).map(([name, preset]) => (
          <button
            key={name}
            type="button"
            onClick={() => setGlow(preset)}
            className="flex-1 rounded-md border border-border px-2 py-1 hover:bg-muted"
          >
            {name}
          </button>
        ))}
      </div>
    </div>
  )
}

function Dial({
  label,
  value,
  min,
  max,
  step,
  unit = "",
  onChange,
}: {
  label: string
  value: number
  min: number
  max: number
  step: number
  unit?: string
  onChange: (e: React.ChangeEvent<HTMLInputElement>) => void
}) {
  return (
    <label className="mb-2 block">
      <span className="flex justify-between text-muted-foreground">
        <span>{label}</span>
        <span className="text-foreground tabular-nums">
          {value}
          {unit}
        </span>
      </span>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={onChange}
        className="mt-1 w-full accent-primary"
      />
    </label>
  )
}
