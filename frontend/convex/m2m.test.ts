import { describe, expect, test, vi } from "vitest"

import { verifyWorkerToken } from "./m2m"

/**
 * The door, tested as the ways through it rather than as the function.
 *
 * The signature check itself belongs to `@clerk/backend` and is exercised by
 * Clerk's own tests; what is ours — and what a leaked token or a second machine
 * would walk through — is everything around it: fail-closed on a half-set
 * deployment, both ends of the token checked rather than one, and a throw out
 * of the SDK landing as a closed door rather than a 500. So the SDK call is a
 * stub here (that is what the `verify` parameter is for) and every test below
 * is one of those.
 */

const JWT = "aaaa.bbbb.cccc"
const BEARER = `Bearer ${JWT}`

const ENV = {
  jwtKey: "-----BEGIN PUBLIC KEY-----\nMIIB\n-----END PUBLIC KEY-----",
  workerMachineId: "mch_worker",
  ledgerMachineId: "mch_ledger",
}

/** A stub standing in for `verifyMachineAuthToken`: hands back one M2M token
 * resource, shaped like the SDK's (`subject`, `scopes`). */
const verifying = (data: { subject: string; scopes: string[] }) =>
  vi.fn().mockResolvedValue({ data })

describe("verifyWorkerToken", () => {
  test("a token from the worker, scoped to this ledger, is let through", async () => {
    const verify = verifying({
      subject: "mch_worker",
      scopes: ["mch_ledger"],
    })
    const result = await verifyWorkerToken(BEARER, ENV, verify)

    expect(result).toEqual({ ok: true, subject: "mch_worker" })
    // The PEM is what makes this offline: no secret key, no network.
    expect(verify).toHaveBeenCalledWith(JWT, { jwtKey: ENV.jwtKey })
  })

  test.each([
    ["CLERK_JWT_KEY", { ...ENV, jwtKey: undefined }],
    ["TUTOR_WORKER_MACHINE_ID", { ...ENV, workerMachineId: undefined }],
    ["TUTOR_LEDGER_MACHINE_ID", { ...ENV, ledgerMachineId: undefined }],
  ])(
    "a deployment missing %s refuses everyone, and never calls the SDK",
    async (name, env) => {
      const verify = verifying({
        subject: "mch_worker",
        scopes: ["mch_ledger"],
      })
      const result = await verifyWorkerToken(BEARER, env, verify)

      expect(result.ok).toBe(false)
      expect(result.ok === false && result.reason).toContain(name)
      // Fail closed *before* the SDK: a half-configured ledger must not be
      // able to accept a token by accident.
      expect(verify).not.toHaveBeenCalled()
    }
  )

  test("another machine's token is refused even with the right scope", async () => {
    const verify = verifying({
      subject: "mch_someone_else",
      scopes: ["mch_ledger"],
    })
    const result = await verifyWorkerToken(BEARER, ENV, verify)

    expect(result.ok).toBe(false)
    expect(result.ok === false && result.reason).toContain("subject")
  })

  test("the worker's own token is refused if it is not scoped to the ledger", async () => {
    const verify = verifying({
      subject: "mch_worker",
      scopes: ["mch_some_other_service"],
    })
    const result = await verifyWorkerToken(BEARER, ENV, verify)

    expect(result.ok).toBe(false)
    expect(result.ok === false && result.reason).toContain("scoped")
  })

  test("a token with no scopes at all is refused", async () => {
    const verify = verifying({ subject: "mch_worker", scopes: [] })
    const result = await verifyWorkerToken(BEARER, ENV, verify)

    expect(result.ok).toBe(false)
  })

  test("an opaque mt_ token is refused without a network round-trip", async () => {
    const verify = verifying({ subject: "mch_worker", scopes: ["mch_ledger"] })
    const result = await verifyWorkerToken("Bearer mt_abc123", ENV, verify)

    expect(result.ok).toBe(false)
    expect(result.ok === false && result.reason).toContain("opaque")
    // This is the point: verifying an opaque token needs a machine secret key
    // and a call to Clerk, and this deployment holds neither.
    expect(verify).not.toHaveBeenCalled()
  })

  test("the SDK's own rejection (expired, bad signature) is a closed door", async () => {
    const verify = vi
      .fn()
      .mockResolvedValue({ errors: [{ message: "Token has expired" }] })
    const result = await verifyWorkerToken(BEARER, ENV, verify)

    expect(result.ok).toBe(false)
    expect(result.ok === false && result.reason).toContain("expired")
  })

  test("a throw out of the SDK is a 401, not a 500", async () => {
    const verify = vi.fn().mockRejectedValue(new Error("jwk is malformed"))
    const result = await verifyWorkerToken(BEARER, ENV, verify)

    expect(result.ok).toBe(false)
    expect(result.ok === false && result.reason).toContain("malformed")
  })

  test.each([
    ["no header at all", null],
    ["a bare token with no scheme", JWT],
    ["the wrong scheme", `Basic ${JWT}`],
    ["an empty bearer", "Bearer "],
    ["something that is not a JWT", "Bearer not-a-jwt"],
  ])("%s is refused", async (_name, header) => {
    const verify = verifying({ subject: "mch_worker", scopes: ["mch_ledger"] })
    const result = await verifyWorkerToken(header, ENV, verify)

    expect(result.ok).toBe(false)
    expect(verify).not.toHaveBeenCalled()
  })
})
