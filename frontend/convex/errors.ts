import { ConvexError } from "convex/values"

/**
 * The refusals the client is allowed to branch on.
 *
 * A bare `throw new Error("No account yet")` reaches the browser as "Server
 * Error" with the message stripped: Convex only ships the payload of a
 * `ConvexError` to an untrusted client, and everything else is redacted on
 * purpose. So every refusal a surface might want to *handle* rather than merely
 * display carries a `code` here, and the surfaces switch on the code instead of
 * matching on prose (launch checklist C11).
 */
export const ERROR_CODES = {
  /** No Clerk identity on a call that requires one. */
  notSignedIn: "not_signed_in",
  /** A Clerk id with no `users` row — the account was never ensured, or was
   * deleted while a tab was open. */
  noAccount: "no_account",
  /** The room named belongs to a different learner. */
  notYourRoom: "not_your_room",
  /** An operator ref that has already been spent. */
  refUsed: "ref_used",
  /** A row that was inserted and then could not be read back. */
  rowVanished: "row_vanished",
} as const

export type ErrorCode = (typeof ERROR_CODES)[keyof typeof ERROR_CODES]

/**
 * A `ConvexError` whose `data` carries a machine-readable `code` **and** whose
 * `message` is exactly the string it was given.
 *
 * Both halves matter. `data.code` is what a surface branches on. `message` is
 * restored because `ConvexError`'s own constructor replaces it with a
 * stringified dump of `data` — which would quietly change what every existing
 * server-side log line, test assertion (`rejects.toThrow(/No such user/)`) and
 * `String(error).includes(...)` check sees. Nothing that read the message
 * before reads anything different now; there is simply more on the error than
 * there was.
 */
export class CodedError extends ConvexError<{
  code: ErrorCode
  message: string
}> {
  constructor(code: ErrorCode, message: string) {
    super({ code, message })
    // Deliberate, and the whole point of the subclass: see the note above.
    this.message = message
  }
}
