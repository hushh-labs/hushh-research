"""Private, short-lived Calendar positions for typed Chat follow-ups.

Only exact provider IDs from a completed read enter the encrypted ADK session.
The public state projection removes both offer keys before streaming to a client.
"""

from __future__ import annotations

import time
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field, ValidationError

STATE_EVENT_OFFER = "hussh:calendar_event_read_offer"
STATE_CALENDAR_OFFER = "hussh:calendar_list_read_offer"
_OFFER_TTL_MS = 5 * 60 * 1000


class CalendarReadOffer(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)

    kind: Literal["events", "calendars"]
    owner_id: str = Field(min_length=1, max_length=256)
    conversation_id: str = Field(min_length=1, max_length=256)
    grant_binding: list[str] = Field(min_length=6, max_length=6)
    ids: list[str] = Field(min_length=1, max_length=250)
    calendar_id: str = Field(default="primary", min_length=1, max_length=1024)
    created_at_ms: int = Field(ge=1)

    def id_at(self, ordinal: int) -> str | None:
        if isinstance(ordinal, bool) or not isinstance(ordinal, int):
            return None
        if 1 <= ordinal <= len(self.ids):
            return self.ids[ordinal - 1] or None
        return None


def make_calendar_read_offer(
    *,
    kind: Literal["events", "calendars"],
    owner_id: str,
    conversation_id: str,
    grant_binding: tuple[str, ...],
    ids: list[str],
    calendar_id: str = "primary",
) -> dict[str, Any] | None:
    """Store only positions from a successful provider read, in result order."""

    if not ids or len(ids) > 250 or any(not isinstance(value, str) for value in ids):
        return None
    try:
        offer = CalendarReadOffer.model_validate(
            {
                "kind": kind,
                "owner_id": owner_id,
                "conversation_id": conversation_id,
                "grant_binding": list(grant_binding),
                "ids": ids,
                "calendar_id": calendar_id,
                "created_at_ms": int(time.time() * 1000),
            }
        )
    except (ValidationError, TypeError, ValueError):
        return None
    return offer.model_dump(mode="json")


def current_calendar_read_offer(
    raw: Any,
    *,
    kind: Literal["events", "calendars"],
    owner_id: str,
    conversation_id: str,
    grant_binding: tuple[str, ...] | None,
    now_ms: int | None = None,
) -> CalendarReadOffer | None:
    """Reject stale positions, another chat, or a reconnected Google account."""

    try:
        offer = CalendarReadOffer.model_validate(raw)
    except (ValidationError, TypeError, ValueError):
        return None
    now = int(time.time() * 1000) if now_ms is None else now_ms
    if (
        offer.kind != kind
        or offer.owner_id != owner_id
        or offer.conversation_id != conversation_id
        or not grant_binding
        or tuple(offer.grant_binding) != tuple(grant_binding)
        or not 0 <= now - offer.created_at_ms <= _OFFER_TTL_MS
    ):
        return None
    return offer
