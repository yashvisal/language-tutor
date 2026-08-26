import Link from "next/link"

import { DESIGN_TASKS } from "./registry"

export default function DesignInspoIndex() {
  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-2xl px-6 py-16">
        <h1 className="text-2xl font-semibold tracking-tight">
          Design exploration
        </h1>
        <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
          Working layouts for the live conversation surface. Every variant
          renders the same mock conversation so differences you feel are
          differences in the design.
        </p>

        {DESIGN_TASKS.map((task) => (
          <section key={task.slug} className="mt-12">
            <h2 className="text-sm font-medium">{task.title}</h2>
            <p className="mt-1 text-sm text-muted-foreground">
              {task.description}
            </p>
            <ul className="mt-4 divide-y rounded-lg border">
              {task.variants.map((variant) => (
                <li key={variant.slug}>
                  <Link
                    href={`/design-inspo/${task.slug}/${variant.slug}`}
                    className="block px-4 py-3 transition-colors hover:bg-muted/50"
                  >
                    <div className="text-sm font-medium">{variant.title}</div>
                    <div className="mt-0.5 text-sm text-muted-foreground">
                      {variant.blurb}
                    </div>
                  </Link>
                </li>
              ))}
            </ul>
          </section>
        ))}
      </div>
    </div>
  )
}
