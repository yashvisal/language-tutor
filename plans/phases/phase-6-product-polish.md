# Phase 6: Product Polish — the dashboard and the metered conversation

*Status: in build (2026-08-24), branch `phase-6-dashboard`, PR #6. Two parts:
the dashboard shell (below) and the metered conversation
(`phase-6-metered-conversation.md`), decided the same day — one combined
review at the end. Decided by Yash
after the phase-5 shell shipped and felt like scaffolding: no sidebar, one
dashboard, the plan picker as a modal, our own header, and a visual direction
closer to "crafted primitives" than to hairlines. The conversation
stage changes only where the metered conversation needs it (the stopwatch,
the out-of-minutes hold).*

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

### Revised 2026-08-24 (after the first build read as "slop")

- **Exact seconds everywhere.** Time left is `m:ss` (`formatClock`), never a
  rounded minute count — the meter counts seconds, so the balance does.
- **The plan picker is a conversation, not a form.** Three questions asked
  one at a time (beautifului.dev "Approval Card"): the question, one text
  field the learner types into, a muted `1 / 3`, Skip, Continue, Start on
  the last, and Back from the second question on (there is nothing to go
  back to from the first — the modal's close is the way out). **No option chips, no tabs** — the first cut kept the chip grid
  and only paginated it, which missed the point (2026-08-24, Yash). The
  answers are free text and are **context the tutor carries into the
  conversation**: what to be ready to talk about → `topic`; what to be
  pushed on (e.g. "when to use *he comido* vs *comí*") → `focusNote`;
  anything else → `note`. `scenario`/`tenses` stay in the contract for the
  catalogs and `suggestPlan`; the level comes from the profile.
- **Header is edge to edge, content is narrow**: the header has no max
  width (wordmark hard left, controls hard right); the page is `max-w-3xl`.
- **The dashboard keeps the panel** (2026-08-25, after five explorations in
  `/design-inspo/home` and two "no card" cuts, all rejected): the greeting;
  one ringed panel with the balance — `Time left`, `m:ss` large, one status
  line — and **Start a conversation** on its right; then **History**. The
  "how a session goes" line under the panel was cut too (2026-08-25). Not
  a "pick up where you left
  off" row, not a Prepare feature, not stats, not the clock stranded as bare
  type — those convolute a session-based product or read as disconnected.
- **History, not a calendar.** The activity grid was tried and cut ("good in
  theory"). A dated list of past conversations (date · what it was about ·
  m:ss · N fixes); clicking one opens a modal with what they talked about
  and the mistakes the analyzer caught. **When there is no history the
  section is absent** — the page is the greeting and the panel. Needs the
  session outcome written to Convex when a session ends.
- **The avatar menu is Settings · Billing · Sign out.** Settings is a modal
  (level; name/email read-only). Billing is a modal (exact time left, the
  three packs as "Coming soon", a recent ledger). No pages.
- **Language**: no picker (vision §3 stands), but no new copy hardcodes
  "Spanish" — it comes from the `TARGET_LANGUAGE` config.

## Out of scope

Payments (Stripe) and deployment — the next phase. Everything else the
metered conversation needs is in this one.

## Exit

Sign in → `/home` reads as a finished product screen in light mode; start a
session from the modal; return home from the summary; settings popover
changes level and signs out. PR reviewed and merged.
