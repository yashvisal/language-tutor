import { TokenSource } from "livekit-client"

import type { SessionPlan } from "./contract"
import { TOKEN_ENDPOINT } from "./protocol"

// Re-exported so the live adapter has one import for everything on the wire.
// Deliberately narrow: anything not consumed by a session surface should be
// imported from `./protocol` directly.
export {
  ANALYZER_OFF,
  ATTRIBUTE_TRUE,
  PARTICIPANT_ATTRIBUTES,
  RPC_METHODS,
  STREAM_ATTRIBUTES,
  TEXT_STREAM_TOPICS,
} from "./protocol"

/**
 * The message a 402 from the token route travels on. The LiveKit SDK gives the
 * surface an `Error` from `start()`, not the response, so the one fact the
 * surface has to act on — this is a balance, not a fault — rides in the text
 * and is recognised by `isOutOfMinutes` rather than by string-matching at the
 * call site.
 */
const OUT_OF_MINUTES_MESSAGE = "tutor:out_of_minutes"

/** Whether a failed connect failed because the learner has no minutes left. */
export function isOutOfMinutes(error: unknown): boolean {
  return String(error).includes(OUT_OF_MINUTES_MESSAGE)
}

let pendingPlan: SessionPlan | null = null

/**
 * Hand the next token request its plan. Called immediately before `start()`,
 * because the token is minted inside that call: a module-level handoff rather
 * than a constructor argument, since the source is a singleton (one live
 * session per page) and the plan is chosen long after it is created.
 */
export function setPendingSessionPlan(plan: SessionPlan | null) {
  pendingPlan = plan
}

/**
 * The TokenSource every session surface should use.
 *
 * Not `TokenSource.endpoint`: that helper serializes a fixed `TokenSourceRequest`
 * protobuf and throws on any option it doesn't know, so there is no seam for the
 * session plan — the one thing this product's token request has to carry.
 * `TokenSource.literal` takes a function instead, and (unlike `.custom`) is a
 * *fixed* source, so it is called afresh on every connect rather than serving a
 * cached token minted for a previous session's plan.
 *
 * The body is otherwise the standardized endpoint format the route already
 * speaks, so the route stays a conforming token endpoint with one extra field.
 */
export const tutorTokenSource = TokenSource.literal(async () => {
  const response = await fetch(TOKEN_ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    // Only the plan: the room name is left unset so the server mints a fresh
    // `lesson-<slug>-<timestamp>-<nonce>` room per session, and agent
    // dispatch is the server's business (a client-side `agent_name` would be
    // ignored there anyway).
    body: JSON.stringify({ session_plan: pendingPlan }),
  })
  // Not a failure: the learner is out of minutes, and the surface has a screen
  // for that. Everything else is a fault worth showing as one.
  if (response.status === 402) throw new Error(OUT_OF_MINUTES_MESSAGE)
  if (!response.ok) {
    throw new Error(
      `Could not start the session (${response.status}). Try again.`
    )
  }
  const body: unknown = await response.json()
  const { server_url, participant_token } = (body ?? {}) as {
    server_url?: string
    participant_token?: string
  }
  if (!server_url || !participant_token) {
    throw new Error("Token endpoint returned an unusable response")
  }
  return { serverUrl: server_url, participantToken: participant_token }
})
