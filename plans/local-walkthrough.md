# Local product walkthrough

Branch: `phase-8-audit`. Open **http://localhost:3000**.

The frontend and tutor run locally. Sign-in, the development database, realtime transport, and models still use the existing development cloud services. Payment, pricing, billing changes, hosted deployment, and a separate E2E harness are outside this pass.

## Walk through the product

1. Sign in, or complete signup and choose your level. Open Home.
2. Select **Start a conversation**, then open the language popover. Choose a language; optionally fill or skip the topic/focus questions. Start and allow the microphone.
3. Confirm the tutor speaks your selected language. Have a normal conversation and interrupt it once. Check both transcripts, then inspect a correction after your turn settles.
4. Select settled text to translate it. In Chinese/Japanese, try a single character as well as a phrase. Close the overlay and continue speaking.
5. Pause. Open Transcript, Review, and Ask. Ask about something from the conversation, then resume. Check that study time does not advance the existing meter.
6. End the conversation. Check the summary, corrections, and transcript. Give the worker a moment to finish saving the summary, then return home and open the same conversation in History.
7. Start again with a different language. Confirm the tutor and the new history record use that language, while the earlier record keeps its original language. Reload the preflight and check that the last language is remembered.
8. Try a direct visit to `/session`, denied microphone permission, keyboard-only navigation, and dark mode. Note unclear recovery states or layout issues.

Spanish has deterministic conjugation tables. Other languages currently offer the model-generated vocabulary and phrases without those tables. English remains the explanation language; level is shared across languages for now.

The existing minute balance still applies. If your account has no minutes, testing needs a development balance refill; there is intentionally no purchase path. Do not use multiple concurrent sessions or test paid behavior yet: the existing session/billing issues are documented in the audit and explicitly deferred.

When reporting a bug, include the selected language, what you clicked or said, what you expected, what happened, and roughly when it happened. The local worker log can then be matched to the session.

## Restart if needed

In one terminal:

```powershell
cd C:\Users\yashv\language-tutor\frontend
pnpm dev
```

In another:

```powershell
cd C:\Users\yashv\language-tutor\backend
lk agent dev
```

The development Convex schema/functions were synced during this change. After future Convex edits, run `pnpm exec convex dev --once` from `frontend/` against the development deployment. Avoid running a second copy of the tutor worker while the first one is still registered.

## After the walkthrough

Fix observed product bugs first. Use [the audit](audit-2026-09-06.md) to plan the later operational/deployment work and the separately deferred payment/billing work. Current dependency findings, draft legal/support copy, and production configuration still need disposition before a public launch.
