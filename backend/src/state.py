"""Shared per-session state.

Pause is a first-class interaction state in this product. The *set of holds*
semantics live client-side (see the product vision): the frontend collapses
overlapping holds and sends a single pause / resume. The worker only tracks the
resulting boolean, and mirrors it onto a participant attribute so it survives a
frontend reconnect.
"""

from __future__ import annotations

from dataclasses import dataclass


@dataclass
class SessionState:
    paused: bool = False
