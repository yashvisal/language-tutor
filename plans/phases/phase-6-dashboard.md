# Phase 6: the dashboard — a clean, shippable signed-in app

*Status: in build (2026-08-24), branch `phase-6-dashboard`. Decided by Yash
after the phase-5 shell shipped and felt like scaffolding: no sidebar, one
dashboard, the plan picker as a modal, our own header, and a visual direction
closer to "crafted primitives" than to hairlines. The conversation stage and
the arc are out of scope here — the arc is the next phase.*

## Decisions (2026-08-23/24, Yash)

- **No sidebar.** The signed-in app is a **header + one dashboard**. A sidebar
  was chrome for a future that isn't here.
- **Header**: lowercase `tutor` wordmark (the landing's constant), minutes
  left, a light/dark toggle, and the learner's avatar (Clerk's image, our
  button — not Clerk's `<UserButton/>`). The avatar opens a **settings
  popover**: email, level, sign out. No `/settings` page.
- **Dashboard (`/home`)**: welcomes the learner, shows minutes left with the
  three balance states (fine / low / empty), and one primary action, **Start a
  conversation**, which opens the plan picker (scenario / topic / tenses /
  vocab / level) as a **modal**; Start inside hands off to `/session`. A quiet
  "how a session goes" card. Recent sessions arrive with the `sessions`
  writer (phase-5 step 2, still open — see `audit-2026-08-23.md` §4).
- **A way home** from the session summary and pre-flight.
- **Visual direction** (reference: beautifului.dev — "crafted primitives for
  AI-native interfaces"): white space; cards with soft shadow and a faint ring
  rather than hairlines; medium radii (~16px cards); tinted rounded-square
  icon badges; **one accent** — `--primary` becomes the Aura blue so buttons,
  badges and the landing agree; full-opacity text; gliding hover states;
  reduced-motion respected. Light mode is the primary target.
- Sequencing: PR #5 merged first (2026-08-24); this lands as its own PR.

## Out of scope

The live conversation stage, the arc (next phase), the money seam and
payments (phase-5 steps 2–4, tracked in the audit), the landing page.

## Exit

Sign in → `/home` reads as a finished product screen in light mode; start a
session from the modal; return home from the summary; settings popover
changes level and signs out. PR reviewed and merged.
