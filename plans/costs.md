# Running costs

What sessions cost us to run, against what they billed. Model spend only
(`sessions.estCostUsd`, the worker's per-session estimate from `usage.py`);
LiveKit, hosting and card fees are not in these numbers. Pull the totals with
`npx convex run sessions:costReport '{"days": 30}'` from `frontend/`; write
down here the ones worth remembering.

Pack prices for reference (`frontend/lib/billing.ts`): 5 min $1.99 ($0.40/min),
20 min $5.99 ($0.30/min), 60 min $16.99 ($0.28/min). Free grant: 5 minutes.

| Date (PDT) | Session | Billed | Model cost | Per billed minute | Notes |
| --- | --- | --- | --- | --- | --- |
| 2026-09-08 | Spanish, "playing football with friends", level: understands more than can say | 3:41 (221 s) | $0.4176 | $0.113 | First live run of the lease. One pause with Ask + Review + 2 lookups; two socket reconnects; one analyzer timeout. gpt-realtime-2.1 + gpt-live-transcribe + gpt-5.6-luna. |

Read: at $0.11/min of model spend against $0.28–0.40/min of pack price, the
model leaves margin; the rest of the stack is not yet measured. Study holds
are free to the learner but not to us (Ask, Review and translate all bill
model tokens) — a learner who pauses a lot is the case to watch.
