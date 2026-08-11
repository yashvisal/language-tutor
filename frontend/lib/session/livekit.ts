import { TokenSource } from "livekit-client"

import {
  ANCHOR_LANGUAGE,
  PARTICIPANT_ATTRIBUTES,
  RPC_METHODS,
  STREAM_ATTRIBUTES,
  TARGET_LANGUAGE,
  TEXT_STREAM_TOPICS,
  TOKEN_ENDPOINT,
  TUTOR_AGENT_NAME,
} from "./protocol"

export {
  ANCHOR_LANGUAGE,
  ATTRIBUTE_FALSE,
  ATTRIBUTE_TRUE,
  PARTICIPANT_ATTRIBUTES,
  ROOM_NAME_PREFIX,
  RPC_METHODS,
  STREAM_ATTRIBUTES,
  TARGET_LANGUAGE,
  TEXT_STREAM_TOPICS,
  TOKEN_ENDPOINT,
  TUTOR_AGENT_NAME,
  type TextStreamTopic,
} from "./protocol"

/**
 * The TokenSource every session surface should use. It POSTs to
 * `/api/token` in the standardized endpoint format and receives
 * `{ server_url, participant_token }` back.
 *
 * Usage (workstream 4):
 *   const session = useSession(tutorTokenSource, tutorSessionOptions())
 */
export const tutorTokenSource = TokenSource.endpoint(TOKEN_ENDPOINT)

/**
 * Fetch options for the token source. The room name is left unset so the
 * server mints a fresh `lesson-<slug>-<timestamp>-<nonce>` room per session;
 * `agentName` is included so explicit dispatch is requested client-side too
 * (the server enforces it regardless).
 */
export function tutorSessionOptions(options?: {
  participantIdentity?: string
  participantName?: string
}) {
  return {
    agentName: TUTOR_AGENT_NAME,
    ...(options?.participantIdentity
      ? { participantIdentity: options.participantIdentity }
      : {}),
    ...(options?.participantName
      ? { participantName: options.participantName }
      : {}),
  }
}

/** Everything the live adapter needs to identify our streams, in one object. */
export const SESSION_CONFIG = {
  agentName: TUTOR_AGENT_NAME,
  tokenEndpoint: TOKEN_ENDPOINT,
  topics: TEXT_STREAM_TOPICS,
  streamAttributes: STREAM_ATTRIBUTES,
  rpc: RPC_METHODS,
  participantAttributes: PARTICIPANT_ATTRIBUTES,
  targetLanguage: TARGET_LANGUAGE,
  anchorLanguage: ANCHOR_LANGUAGE,
} as const
