/* Headless repro of the live corrections path: replay a realistic event
 * sequence through the reducer and check corrections attach. */
import {
  INITIAL_SESSION_STATE,
  sessionReducer,
  type SessionState,
} from "../lib/session/reducer"
import type { SessionEvent, Correction } from "../lib/session/contract"

let state: SessionState = INITIAL_SESSION_STATE
const step = (e: SessionEvent) => {
  state = sessionReducer(state, e)
}

// Tutor greeting segment.
step({ type: "transcript.delta", segmentId: "SG_t1", speaker: "tutor", language: "target", text: "Hola, ¿cómo va tu día?" })
step({ type: "transcript.final", segmentId: "SG_t1", speaker: "tutor", language: "target", text: "Hola, ¿cómo va tu día?" })

// Learner turn, two STT fragments.
step({ type: "transcript.delta", segmentId: "SG_u1", speaker: "learner", language: "target", text: "Hola, ahora yo quiero hablar" })
step({ type: "transcript.delta", segmentId: "SG_u1", speaker: "learner", language: "target", text: "Hola, ahora yo quiero hablar sobre und proyecto" })
step({ type: "transcript.final", segmentId: "SG_u1", speaker: "learner", language: "target", text: "Hola, ahora yo quiero hablar sobre und proyecto", analysisPending: true })
step({ type: "transcript.delta", segmentId: "SG_u2", speaker: "learner", language: "target", text: "es una tutor de IA." })
step({ type: "transcript.final", segmentId: "SG_u2", speaker: "learner", language: "target", text: "es una tutor de IA.", analysisPending: true })

console.log("current turn:", JSON.stringify({ id: state.current?.id, target: state.current?.target, segs: state.current?.segments?.map(s => s.id), phase: state.phase }))

// Corrections arrive attributed to SG_u1 and SG_u2.
const c1: Correction = { id: "c1", original: "und proyecto", replacement: "un proyecto", category: "vocabulary", severity: "error", explanation: "x" }
const c2: Correction = { id: "c2", original: "una tutor", replacement: "un tutor", category: "agreement", severity: "error", explanation: "y" }
step({ type: "analysis.complete", segmentId: "SG_u1", corrections: [c1] })
step({ type: "analysis.complete", segmentId: "SG_u2", corrections: [c2] })

console.log("after analysis:", JSON.stringify({ phase: state.phase, corrections: state.current?.corrections?.map(c => c.id), status: state.current?.analysisStatus }))

// Tutor reply retires the learner turn; check history keeps corrections.
step({ type: "transcript.delta", segmentId: "SG_t2", speaker: "tutor", language: "target", text: "Qué interesante." })
const hist = state.turns[state.turns.length - 1]
console.log("retired learner turn:", JSON.stringify({ id: hist?.id, corrections: hist?.corrections?.map(c => c.id), target: hist?.target }))
