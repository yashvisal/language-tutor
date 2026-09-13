import Link from "next/link"

const VARIANTS = [
  {
    slug: "plain",
    title: "Plain stage",
    blurb: "CTA above the demo; the Aura and caption sit on the page itself.",
  },
  {
    slug: "panel",
    title: "Panel stage",
    blurb:
      "CTA above the demo; the demo lives in a framed panel with session chrome.",
  },
]

export default function LandingLabIndex() {
  return (
    <div className="mx-auto max-w-2xl px-6 py-16">
      <h1 className="text-2xl font-semibold tracking-tight">Landing lab</h1>
      <p className="mt-2 text-sm text-muted-foreground">
        Two candidate landing pages. Toggle the theme from each page&apos;s
        header.
      </p>
      <ul className="mt-8 divide-y rounded-lg border">
        {VARIANTS.map((v) => (
          <li key={v.slug}>
            <Link
              href={`/landing-lab/${v.slug}`}
              className="block px-4 py-3 hover:bg-muted/50"
            >
              <div className="text-sm font-medium">{v.title}</div>
              <div className="mt-0.5 text-sm text-muted-foreground">
                {v.blurb}
              </div>
            </Link>
          </li>
        ))}
      </ul>
    </div>
  )
}
