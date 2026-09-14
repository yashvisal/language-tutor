import * as Sentry from "@sentry/nextjs"

import { scrubLearnerText, SENTRY_TRACES_SAMPLE_RATE } from "./sentry.options"

const dsn = process.env.SENTRY_DSN ?? process.env.NEXT_PUBLIC_SENTRY_DSN

if (dsn) {
  Sentry.init({
    dsn,
    tracesSampleRate: SENTRY_TRACES_SAMPLE_RATE,
    sendDefaultPii: false,
    beforeSend: scrubLearnerText,
  })
}
