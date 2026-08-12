import { TokenSource } from "livekit-client"

import { TOKEN_ENDPOINT, TUTOR_AGENT_NAME } from "./protocol"

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
 * The TokenSource every session surface should use. It POSTs to
 * `/api/token` in the standardized endpoint format and receives
 * `{ server_url, participant_token }` back.
 */
export const tutorTokenSource = TokenSource.endpoint(TOKEN_ENDPOINT)

/**
 * Fetch options for the token source. The room name is left unset so the
 * server mints a fresh `lesson-<slug>-<timestamp>-<nonce>` room per session;
 * `agentName` is included so explicit dispatch is requested client-side too
 * (the server enforces it regardless).
 */
export const TUTOR_SESSION_OPTIONS = { agentName: TUTOR_AGENT_NAME } as const
