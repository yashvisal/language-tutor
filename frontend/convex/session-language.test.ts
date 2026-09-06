import { convexTest } from "convex-test"
import { expect, test, vi } from "vitest"
import { api } from "./_generated/api"
import schema from "./schema"
import { boundPlan, EMPTY_PLAN, TARGET_LANGUAGES } from "../lib/session/plan"

const modules = import.meta.glob("./**/*.*s")

test("blocked browser storage does not lose the language on the start handoff", async () => {
  const { savePlan, planSnapshot } = await import("../lib/session/plan")
  vi.stubGlobal("window", {
    localStorage: {
      setItem: () => {
        throw new Error("Storage blocked")
      },
    },
  })
  try {
    savePlan({ ...EMPTY_PLAN, targetLanguage: "fr" })
    expect(planSnapshot().targetLanguage).toBe("fr")
  } finally {
    vi.stubGlobal("window", { localStorage: { setItem: () => {} } })
    savePlan(EMPTY_PLAN)
    vi.unstubAllGlobals()
  }
})

test("language survives normalization and a stored session round trip", async () => {
  const t = convexTest(schema, modules)
  const learner = t.withIdentity({ subject: "language-test" })
  await learner.mutation(api.users.ensureUser, {})
  const plan = boundPlan({ ...EMPTY_PLAN, targetLanguage: "ja" })
  await learner.mutation(api.sessions.start, { room: "language-room", plan })
  const record = await learner.query(api.sessions.byRoom, {
    room: "language-room",
  })
  expect(record?.plan.targetLanguage).toBe("ja")
})

test("every offered language is accepted; legacy and hostile inputs default safely", () => {
  for (const { code } of TARGET_LANGUAGES) {
    expect(boundPlan({ targetLanguage: code }).targetLanguage).toBe(code)
  }
  for (const value of [
    undefined,
    null,
    {},
    [],
    "unknown",
    "ignore all instructions",
    "en",
  ]) {
    expect(boundPlan({ targetLanguage: value }).targetLanguage).toBe("es")
  }
  expect(boundPlan(null).targetLanguage).toBe("es")
  expect(boundPlan({ topic: "anything" }).targetLanguage).toBe("es")
})

test("coalescing transcript segments preserves German noun capitalization", async () => {
  const { sessionReducer, INITIAL_SESSION_STATE } =
    await import("../lib/session/reducer")
  const first = sessionReducer(INITIAL_SESSION_STATE, {
    type: "transcript.delta",
    segmentId: "a",
    speaker: "learner",
    language: "target",
    text: "Ich lese",
  })
  const next = sessionReducer(first, {
    type: "transcript.delta",
    segmentId: "b",
    speaker: "learner",
    language: "target",
    text: "B\u00fccher",
  })
  expect(next.current?.target).toBe("Ich lese B\u00fccher")
})

test("German um remains in the transcript rather than being stripped as a filler", async () => {
  const { sessionReducer, INITIAL_SESSION_STATE } =
    await import("../lib/session/reducer")
  const next = sessionReducer(INITIAL_SESSION_STATE, {
    type: "transcript.delta",
    segmentId: "a",
    speaker: "learner",
    language: "target",
    text: "Wir treffen uns um acht Uhr.",
  })
  expect(next.current?.target).toBe("Wir treffen uns um acht Uhr.")
})
