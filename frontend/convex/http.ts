import { httpRouter } from "convex/server"

import { httpAction } from "./_generated/server"
import { internal } from "./_generated/api"

/**
 * The worker's seam into the ledger.
 *
 * Two routes, both machine-to-machine: the Python worker meters the seconds a
 * learner actually talks and reports them here, and re-reads the balance when a
 * held session is continued. Neither call carries a Clerk identity — the worker
 * acts *for* a learner, it is not one — so the learner is named by their Clerk
 * id in the body and the caller is authenticated by a shared secret instead.
 *
 * `TUTOR_DEBIT_SECRET` lives on the Convex deployment (`npx convex env set`),
 * never in `.env.local`: the browser must never be able to spend or read
 * someone else's balance. Every route below refuses before it reads the body,
 * so an unauthenticated caller cannot even probe for a valid user id.
 *
 * The mutations and queries these call are `internal*` for the same reason.
 */

/** The shared secret, read per request so a rotated value takes effect without
 * a redeploy. Missing means the seam is closed, not open. */
function authorized(request: Request): boolean {
  const expected = process.env.TUTOR_DEBIT_SECRET
  if (!expected) return false
  const header = request.headers.get("Authorization") ?? ""
  return header === `Bearer ${expected}`
}

const unauthorized = () =>
  new Response(JSON.stringify({ error: "unauthorized" }), {
    status: 401,
    headers: { "Content-Type": "application/json" },
  })

const badRequest = (message: string) =>
  new Response(JSON.stringify({ error: message }), {
    status: 400,
    headers: { "Content-Type": "application/json" },
  })

const ok = (body: unknown) =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  })

/**
 * `POST /tutor/debit` — `{ room, userId, seconds, seq }` → `{ balanceSeconds }`.
 *
 * `seconds` is the session's CUMULATIVE active seconds, not an increment. See
 * `sessions.debit`: reporting a running total is what makes a retry harmless.
 */
const debit = httpAction(async (ctx, request) => {
  if (!authorized(request)) return unauthorized()

  let body: {
    room?: unknown
    userId?: unknown
    seconds?: unknown
    seq?: unknown
  }
  try {
    body = (await request.json()) as typeof body
  } catch {
    return badRequest("invalid json")
  }

  const { room, userId, seconds, seq } = body
  if (
    typeof room !== "string" ||
    typeof userId !== "string" ||
    typeof seconds !== "number" ||
    typeof seq !== "number" ||
    !Number.isFinite(seconds) ||
    !Number.isFinite(seq) ||
    seconds < 0
  ) {
    return badRequest("expected { room, userId, seconds, seq }")
  }

  const result = await ctx.runMutation(internal.sessions.debit, {
    room,
    clerkId: userId,
    seconds,
    seq,
  })
  return ok(result)
})

/**
 * `POST /tutor/balance` — `{ userId }` → `{ balanceSeconds }`. What the worker
 * reads on resume, so a session held at zero continues on the balance the
 * learner has now rather than the one it started with.
 */
const balance = httpAction(async (ctx, request) => {
  if (!authorized(request)) return unauthorized()

  let body: { userId?: unknown }
  try {
    body = (await request.json()) as typeof body
  } catch {
    return badRequest("invalid json")
  }

  if (typeof body.userId !== "string") return badRequest("expected { userId }")

  const result = await ctx.runQuery(internal.users.balanceByClerkId, {
    clerkId: body.userId,
  })
  return ok(result)
})

const http = httpRouter()
http.route({ path: "/tutor/debit", method: "POST", handler: debit })
http.route({ path: "/tutor/balance", method: "POST", handler: balance })

export default http
