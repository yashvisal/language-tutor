"use client"

/**
 * The last error surface: a throw in the root layout itself, where `error.tsx`
 * cannot help because the layout that would have wrapped it is the thing that
 * failed. It renders outside every layout, so it ships its own `<html>` and
 * `<body>` and cannot rely on a stylesheet — hence the inline styles.
 *
 * Deliberately plain: no product chrome, no navigation into an app that just
 * proved it can't render, one way out (reload).
 */
import * as Sentry from "@sentry/nextjs"
import { useEffect } from "react"

export default function GlobalError({
  error,
}: {
  error: Error & { digest?: string }
}) {
  useEffect(() => {
    Sentry.captureException(error)
  }, [error])

  return (
    <html lang="en">
      <body
        style={{
          margin: 0,
          minHeight: "100vh",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          fontFamily:
            "ui-sans-serif, system-ui, -apple-system, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif",
          background: "#fbfaf9",
          color: "#1c1a18",
        }}
      >
        <main
          style={{ maxWidth: "26rem", padding: "2rem", textAlign: "center" }}
        >
          <h1
            style={{
              fontSize: "1.25rem",
              fontWeight: 500,
              margin: "0 0 0.5rem",
            }}
          >
            Something went wrong
          </h1>
          <p style={{ margin: "0 0 1.5rem", lineHeight: 1.6, opacity: 0.7 }}>
            The page failed to load. Reloading usually fixes it.
          </p>
          <button
            type="button"
            onClick={() => window.location.reload()}
            style={{
              font: "inherit",
              cursor: "pointer",
              border: "1px solid rgba(0,0,0,0.15)",
              borderRadius: "0.5rem",
              padding: "0.5rem 1.25rem",
              background: "#1c1a18",
              color: "#fbfaf9",
            }}
          >
            Reload
          </button>
        </main>
      </body>
    </html>
  )
}
