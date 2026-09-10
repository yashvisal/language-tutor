import { defineConfig } from "vitest/config"

/**
 * Tests for the Convex half of the money seam, and nothing else yet.
 *
 * `edge-runtime` because that is what `convex-test` needs: Convex functions run
 * on a V8 isolate with WebCrypto and no Node built-ins, and a test that passes
 * under jsdom or node can still throw in production over exactly that
 * difference (`convex/http.ts` avoids Node `crypto` for this reason).
 *
 * `convex-test` is inlined rather than pre-bundled because it resolves the
 * function modules through `import.meta.glob`, which only works when Vite
 * transforms it in place.
 *
 * `include` is narrow on purpose: this project's other code is React and Next
 * server code that would need a different environment, and a config that tries
 * to serve both serves neither.
 */
export default defineConfig({
  test: {
    environment: "edge-runtime",
    include: ["convex/**/*.test.ts"],
    server: { deps: { inline: ["convex-test"] } },
  },
})
