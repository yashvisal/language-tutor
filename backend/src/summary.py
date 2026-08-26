"""The after-session record: what this conversation was, sent once at teardown.

Until now the only thing a session left behind was corrections, seconds and
`endedByClock` — so the post-session summary showed time and fixes, the History
modal showed the *plan's* topic and the same fixes, and everything the
conversation actually was disappeared when the tab closed (phase 7 step 2;
`out-of-minutes.tsx` even promises the transcript and review are "saved").

Four things go up, all optional, all best-effort:

- **`about`** — one line, in the ANCHOR language, saying what the conversation
  was actually about. One cheap text call at teardown, on the transcript, with
  a hard 6 s budget: it is worth one Luna call because it is the line the
  learner reads months later, and it is not worth delaying a shutdown for.
- **`transcript`** — the conversation itself, from `session.history`, bounded to
  the MOST RECENT 200 turns of 500 characters. Most recent, not first: a long
  session's opening pleasantries are the part nobody returns for, and `about`
  already carries the shape of the whole thing.
- **`review`** — the session's Review material (vocab / phrases / tables),
  exactly as the `tutor.review` RPC serves it, if it ever became ready.
- **`corrections`** — every finding the analyzer actually published this
  session, from `SessionFacts`. The client writes the same list through
  `sessions.finish`, but only if its tab is still open when the session ends;
  this is the copy that survives a closed laptop.

Everything here is guarded twice: each piece fails to nothing, and the whole
thing runs under one budget in the shutdown callback (`SUMMARY_BUDGET_S`), so a
hung model or an unreachable ledger costs a record, never a clean teardown.
"""

from __future__ import annotations

import asyncio
import logging

import openai

from billing import MAX_TRANSCRIPT_TURNS, MAX_TURN_CHARS, BillingClient
from config import TutorConfig
from prompts import about_instructions
from review import ReviewMaterial
from state import SessionFacts
from usage import UsageTracker

logger = logging.getLogger("tutor.summary")

# The whole teardown seam's budget: the `about` call plus the POST. The
# shutdown callback wraps the lot in this, because LiveKit's shutdown is not a
# place to wait on a model.
SUMMARY_BUDGET_S = 8.0

# The `about` call's own budget. Shorter than the wrapper on purpose: a model
# that has not answered in six seconds should still leave room for the POST.
ABOUT_TIMEOUT_S = 6.0

# How much transcript the `about` call sees. The line is about the whole
# conversation, so it sees the whole (already bounded) transcript.
ABOUT_MAX_CHARS = 24_000

# The model's way of saying "there was nothing here".
_NOTHING = "none"


def transcript_turns(
    history: object,
    *,
    limit: int = MAX_TRANSCRIPT_TURNS,
    max_chars: int = MAX_TURN_CHARS,
) -> list[dict[str, str]]:
    """`session.history` as `{"role", "text"}` turns, oldest first.

    Walks backwards and stops at `limit`, so a two-hour session's history is
    never flattened just to throw most of it away — the same shape
    `analyzer.recent_context` uses, with the wire's role names.
    """
    items = getattr(history, "items", None) or []
    turns: list[dict[str, str]] = []
    for item in reversed(list(items)):
        if len(turns) >= limit:
            break
        if getattr(item, "type", None) != "message":
            continue
        role = getattr(item, "role", None)
        if role not in ("user", "assistant"):
            # System prompts and tool calls are not conversation.
            continue
        try:
            text = " ".join((item.text_content or "").split())[:max_chars]
        except Exception:
            continue
        if not text:
            continue
        turns.append({"role": "learner" if role == "user" else "tutor", "text": text})
    turns.reverse()
    return turns


def transcript_text(turns: list[dict[str, str]], *, max_chars: int = ABOUT_MAX_CHARS) -> str:
    """The transcript as the `about` call's input. Truncated from the FRONT.

    If something has to go it is the beginning: the model is asked what the
    conversation was about, and the end of a conversation is the part that
    knows.
    """
    lines = "\n".join(f"{turn['role']}: {turn['text']}" for turn in turns)
    return lines[-max_chars:]


async def about_line(
    cfg: TutorConfig,
    turns: list[dict[str, str]],
    *,
    usage: UsageTracker | None = None,
    client: openai.AsyncOpenAI | None = None,
) -> str | None:
    """One line about what the conversation was about, or None.

    `reasoning: none`, like every other out-of-band call in this worker: this is
    a summarisation of settled text on a shutdown path, not a hard problem.
    """
    if len(turns) < 2:
        # One turn is a greeting. There is nothing to be about.
        return None
    owned = client is None
    client = client or openai.AsyncOpenAI(api_key=cfg.openai_api_key or None, max_retries=0)
    try:
        response = await asyncio.wait_for(
            client.responses.create(
                model=cfg.analyzer_model,
                instructions=about_instructions(cfg),
                input=transcript_text(turns),
                reasoning={"effort": "none"},
            ),
            timeout=ABOUT_TIMEOUT_S,
        )
        if usage is not None:
            usage.record_text_usage(response, label="about")
        line = " ".join((response.output_text or "").split())
        if not line or line.strip().strip(".").casefold() == _NOTHING:
            return None
        return line
    except asyncio.CancelledError:
        raise
    except Exception:
        logger.warning("the about line failed; posting the summary without it", exc_info=True)
        return None
    finally:
        if owned:
            try:
                await client.close()
            except Exception:
                logger.debug("about client close failed (harmless)", exc_info=True)


async def report_session_summary(
    cfg: TutorConfig,
    *,
    history: object,
    billing: BillingClient,
    review: ReviewMaterial | None = None,
    facts: SessionFacts | None = None,
    usage: UsageTracker | None = None,
) -> bool:
    """Build and post this session's record. Returns whether the ledger took it.

    Called from the shutdown callback, beside the final debit and independent of
    it (the Convex side upserts either way, so the two may land in any order).
    Never raises: the caller is teardown.
    """
    if not billing.enabled:
        # No learner id, no ledger, nothing to attach a record to — and no
        # reason to spend a model call on it either.
        return False
    turns = transcript_turns(history)
    about = await about_line(cfg, turns, usage=usage)
    snapshot = review.snapshot() if review is not None else None
    return await billing.summary(
        about=about,
        transcript=turns,
        review=snapshot,
        corrections=list(facts.corrections) if facts is not None else None,
    )
