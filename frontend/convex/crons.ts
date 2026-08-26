import { cronJobs } from "convex/server"

import { internal } from "./_generated/api"

/**
 * Scheduled work. One job today.
 *
 * A `sessions` row is opened by `/api/token` and closed by `sessions.finish`,
 * which runs on the client. Anything that stops the client from getting there
 * — a killed worker, a closed laptop, a crashed tab, a lost network — leaves
 * the row open forever. Two consequences, and the second is the one that
 * matters: the conversation never shows up in History (which filters on
 * `endedAt`), and the one-open-session guard in `sessions.start` treats the
 * ghost as a live conversation.
 *
 * Hourly rather than more often because the row only becomes stale after two
 * hours, and hourly rather than less often because an hour is roughly how long
 * a learner will wait before deciding the product is broken.
 */
const crons = cronJobs()

crons.hourly(
  "close abandoned sessions",
  { minuteUTC: 7 },
  internal.sessions.reconcileStale
)

export default crons
