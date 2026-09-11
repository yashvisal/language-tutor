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
| 2026-09-09 | Spanish, "summer vacation, past narration", same level | 2:27 (147 s) | $0.2182 | $0.089 | First tutor audio 2.2 s after request. Two pauses (Ask ×2, Review, 2 lookups, one translate timeout); 57% of learner turns mostly English. |
| 2026-09-10 | Spanish, "daily routines", same level; framework 1.8.1 | 3:12 (192 s) | $0.278 | $0.087 | First audio 2.2 s. Ten learner turns, none split (65–115 chars each, one commit apiece). Four pauses, 2 Asks, 6 corrections shown. 40% of learner turns mostly English. |
| 2026-09-10 | Spanish, "daily routines" again; target-only transcriber + goal keywords + narrow English rule | 3:34 (214 s) | $0.249 | $0.070 | First audio 1.1 s. 11 learner turns, none split. English tutor lines 2 of 14, both after whole-English learner turns (was 5 of 12). Learner turns now in the stored transcript. One non-Latin glyph slipped into a transcript. |

Read: at $0.11/min of model spend against $0.28–0.40/min of pack price, the
model leaves margin; the rest of the stack is not yet measured. Study holds
are free to the learner but not to us (Ask, Review and translate all bill
model tokens) — a learner who pauses a lot is the case to watch.
