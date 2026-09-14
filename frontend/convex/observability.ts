/**
 * The one place the backend reports something it wants a human to see.
 *
 * Today it is a structured `console.error` — Convex's dashboard logs, which is
 * where an operator already looks. Tomorrow it is where a Sentry client is
 * wired, and the point of the seam is that "tomorrow" is a change to THIS file
 * and nothing else. Before it existed the interesting failures (a webhook
 * signature that did not verify, a rejected worker token, a balance that went
 * below zero) were bare `console.error` calls scattered across three modules,
 * each with its own wording, none of them findable.
 *
 * **The Convex limitation, stated once so nobody rediscovers it.** Convex runs
 * queries and mutations in a deterministic V8 isolate with no network and no
 * Node builtins: `@sentry/node` cannot be imported there, and even a `fetch` to
 * Sentry's ingest endpoint is not allowed from a transaction. So the eventual
 * wiring is:
 *
 * - **Actions** (including `httpAction`) may talk to Sentry directly. A
 *   `"use node"` module exporting an `internalAction` that calls
 *   `Sentry.captureException` is the shape, and `http.ts`'s handlers can call
 *   it inline because they are actions already.
 * - **Queries and mutations** cannot. They report here, and the line lands in
 *   the Convex logs; to get one of those into Sentry a mutation must
 *   `ctx.scheduler.runAfter(0, internal.<module>.captureToSentry, {...})`,
 *   which is committed with the transaction or not at all. That indirection is
 *   deliberately NOT built yet — a scheduled function per log line is real cost
 *   and the log stream is enough until the DSN exists.
 *
 * So: call `reportError` from anywhere. When Sentry lands, the action path
 * captures immediately and the mutation path grows a scheduler hop, and no
 * call site changes either way.
 */

/**
 * Report something that went wrong, with enough structure to find it again.
 *
 * `kind` is a stable, greppable slug — `balance_floor`, `m2m_rejected`,
 * `webhook_signature` — and it is the first thing on the line, so a log search
 * for one failure mode does not also match the prose. `detail` is the fields
 * that make the line actionable (ids, the numbers involved); it must never
 * carry learner text, for the same reason the worker no longer logs turns.
 * `error` is the caught exception where there was one.
 *
 * Never throws. A reporter that can fail is a reporter that turns a logged
 * problem into an unlogged outage.
 */
export function reportError(
  kind: string,
  detail: Record<string, unknown>,
  error?: unknown
): void {
  try {
    // One line, `kind` first, the detail as JSON so a log search can read it
    // back out. `error` is appended rather than merged: a thrown value is not
    // reliably serializable and `console.error` renders it better than
    // `JSON.stringify` does.
    const line = `[${kind}] ${JSON.stringify(detail)}`
    if (error === undefined) console.error(line)
    else console.error(line, error)
  } catch {
    // A detail object that will not stringify (a cycle, a BigInt) must not
    // take the call site down with it.
    console.error(`[${kind}] <unserializable detail>`, error)
  }
}
