import * as Sentry from "@sentry/nextjs"

import { scrubLearnerText, SENTRY_TRACES_SAMPLE_RATE } from "./sentry.options"

const dsn = process.env.NEXT_PUBLIC_SENTRY_DSN

if (dsn) {
  Sentry.init({
    dsn,
    tracesSampleRate: SENTRY_TRACES_SAMPLE_RATE,
    // No session replay and no feedback widget: a replay of this product is a
    // recording of somebody's language lesson.
    sendDefaultPii: false,
    beforeSend: scrubLearnerText,
  })
}

// Navigation spans for client-side route changes.
export const onRouterTransitionStart = Sentry.captureRouterTransitionStart
