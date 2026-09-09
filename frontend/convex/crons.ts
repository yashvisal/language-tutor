import { cronJobs } from "convex/server"

import { internal } from "./_generated/api"

/**
 * Scheduled work. One job today.
 *
 * A `sessions` row is opened by the worker when it joins the room and closed
 * by its final debit. Anything that stops the worker from getting there — a
 * killed process, a lost network — leaves the row open with a lease that
 * runs out (`LEASE_TTL_MS`, three minutes). An expired lease no longer blocks
 * the learner (`sessions.open` checks the lease, not the row), but the
 * conversation would never show up in History, which filters on `endedAt`.
 * This closes it.
 *
 * Every five minutes: the lease is three, so a crashed session reaches
 * History within about eight, and the read is one index range that is empty
 * almost every time.
 */
const crons = cronJobs()

crons.interval(
  "close sessions whose lease expired",
  { minutes: 5 },
  internal.sessions.reconcileStale
)

export default crons
