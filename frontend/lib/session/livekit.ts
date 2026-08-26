import { MediaDeviceFailure, TokenSource } from "livekit-client"

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

/**
 * What a 409 from the token route says out loud.
 *
 * Unlike the 402 above this is not a state with a screen — there is nothing to
 * buy and nothing to hold — so it travels as the sentence the learner should
 * read. `live-producer` puts it straight into `error`, and the pre-flight
 * prints it above Start. Written here rather than at the fetch so the wording
 * is one string, and so it is obvious it is prose and not an error code.
 *
 * The route returns it while `sessions.start` sees a row with no `endedAt`
 * younger than fifteen minutes: almost always a second tab, occasionally a
 * conversation whose tab died (which the reconciliation cron closes, and which
 * "wait a moment" is the honest advice for).
 */
export const OPEN_SESSION_MESSAGE =
  "You already have a conversation open in another tab. End it there, or wait a moment."

/**
 * The Clerk session behind the tab expired between loading the page and
 * pressing Start. Not a fault and not something a retry fixes — the learner
 * has to sign in again — so it travels as prose with an action beside it
 * (`describeStartError` attaches the link).
 */
export const SIGNED_OUT_MESSAGE = "Your sign-in expired."

/** Where the sign-in action goes, and what it says. */
export const SIGN_IN_ACTION = { label: "Sign in again.", href: "/sign-in" }

/** A 5xx from our own token route. Ours to fix, theirs to wait out. */
export const SERVER_ERROR_MESSAGE =
  "Something went wrong on our side. Try again in a moment."

/** Anything else that stopped the connection before it began. */
export const START_FAILED_MESSAGE =
  "Could not start the session. Try again."

/** The two microphone failures a first-run learner actually hits, each said
 * with the fix rather than as a DOMException name (audit §4.3). */
export const MIC_BLOCKED_MESSAGE =
  "Your browser blocked the microphone. Allow it in the address bar, then try again."
export const MIC_MISSING_MESSAGE =
  "No microphone found. Connect one and try again."
/** The one device failure with a third answer: something else has the mic. */
export const MIC_BUSY_MESSAGE =
  "Another app is using your microphone. Close it, then try again."

/** What the pre-flight prints when a start fails: one sentence, and — where
 * there is one — the action that fixes it, rendered inline beside it. */
export interface StartFailure {
  message: string
  action: { label: string; href: string } | null
}

/**
 * Every way `connect()` can fail, turned into something a stranger can act on.
 *
 * Two families arrive here. The microphone's, which the browser raises as a
 * `DOMException` the LiveKit SDK may have wrapped — so `MediaDeviceFailure`
 * classifies it rather than a `name` check that a wrapper would defeat. And
 * the token route's, which this module already converted to prose above; those
 * pass through untouched and only pick up an action.
 *
 * Deliberately NOT here: the 402, which is a screen (`isOutOfMinutes`), and
 * the 409, which is already a whole sentence (`OPEN_SESSION_MESSAGE`).
 */
export function describeStartError(error: unknown): StartFailure {
  switch (deviceFailure(error)) {
    case MediaDeviceFailure.PermissionDenied:
      return { message: MIC_BLOCKED_MESSAGE, action: null }
    case MediaDeviceFailure.NotFound:
      return { message: MIC_MISSING_MESSAGE, action: null }
    case MediaDeviceFailure.DeviceInUse:
      return { message: MIC_BUSY_MESSAGE, action: null }
  }

  const message = error instanceof Error ? error.message : String(error)
  if (message === SIGNED_OUT_MESSAGE) {
    return { message, action: SIGN_IN_ACTION }
  }
  // Our own prose — the 409 sentence, the 5xx line — reaches the learner as
  // written. Anything else is an SDK string, and an SDK string is not English.
  if (message === OPEN_SESSION_MESSAGE || message === SERVER_ERROR_MESSAGE) {
    return { message, action: null }
  }
  return { message: START_FAILED_MESSAGE, action: null }
}

/**
 * `MediaDeviceFailure`, through one layer of wrapping. `getFailure` reads
 * `error.name`, and the SDK sometimes hands the original `DOMException` back as
 * a `cause` on an error of its own — in which case the outer name classifies as
 * `Other` and the real answer is one level down.
 */
function deviceFailure(error: unknown): MediaDeviceFailure | undefined {
  const direct = MediaDeviceFailure.getFailure(error)
  if (direct !== undefined && direct !== MediaDeviceFailure.Other) return direct
  const cause = error instanceof Error ? error.cause : undefined
  const nested = cause === undefined ? undefined : MediaDeviceFailure.getFailure(cause)
  return nested === MediaDeviceFailure.Other ? direct : (nested ?? direct)
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
  // Also not a fault: the learner has a conversation running somewhere else,
  // and both would spend the same balance (see `sessions.start`). Nothing to
  // retry until they end it, so this is prose rather than a status code.
  if (response.status === 409) throw new Error(OPEN_SESSION_MESSAGE)
  // The Clerk session died under the tab. `route.ts` answers 401 for exactly
  // that, and "Try again" was the wrong advice: retrying signs nobody in.
  if (response.status === 401) throw new Error(SIGNED_OUT_MESSAGE)
  if (response.status >= 500) throw new Error(SERVER_ERROR_MESSAGE)
  if (!response.ok) throw new Error(START_FAILED_MESSAGE)
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
