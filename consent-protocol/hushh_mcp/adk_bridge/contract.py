"""Transport-agnostic A2A delegation contract.

These types are the ONLY thing One and a specialist agree on. For slice 1 the
transport is an in-process function call; a later network A2A swap reuses these
exact shapes over HTTP without touching callers.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Literal


@dataclass(frozen=True)
class A2ATask:
    """One → specialist. Coordinate-free by construction."""

    user_id: str
    consent_token: str
    conversation_id: str | None
    message: str | None = None
    delegate_result: dict | None = None


@dataclass(frozen=True)
class A2ADirective:
    """A specialist's client-side instruction. ``payload`` is the specialist's
    existing coordinate-free descriptor (e.g. Location's clientAction/clientPrompt)."""

    kind: Literal["action", "prompt"]
    payload: dict


@dataclass(frozen=True)
class SpecialistTurnResult:
    """specialist → One. Coordinate-free by construction."""

    conversation_id: str
    text: str
    directive: A2ADirective | None
    is_complete: bool
    state_changed: bool
    model: str
