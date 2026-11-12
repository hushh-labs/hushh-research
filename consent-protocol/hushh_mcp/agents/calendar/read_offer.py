"""Private, short-lived Calendar positions for typed Chat follow-ups.

Only exact provider IDs and calculated openings from completed reads enter the
encrypted ADK session. The public state projection removes the offer keys.
"""

from __future__ import annotations

import time
from typing import Any, Literal, Self

from pydantic import BaseModel, ConfigDict, Field, ValidationError, model_validator

from hushh_mcp.services.calendar_opening_selection import (
    CalendarOpening,
    CalendarOpeningWindow,
    CalendarSharedOpeningWindow,
    instant,
)

STATE_EVENT_OFFER = "hussh:calendar_event_read_offer"
STATE_INVITATION_OFFER = "hussh:calendar_invitation_read_offer"
STATE_CALENDAR_OFFER = "hussh:calendar_list_read_offer"
STATE_OPENING_OFFER = "hussh:calendar_opening_read_offer"
STATE_EVENTS_PAGE = "hussh:calendar_events_page"
STATE_EVENT_ATTENDEES = "hussh:calendar_event_attendees"
_OFFER_TTL_MS = 5 * 60 * 1000


class CalendarOfferIdentity(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)

    owner_id: str = Field(min_length=1, max_length=256)
    conversation_id: str = Field(min_length=1, max_length=256)
    # Older offers were produced only by the default-account read port.
    account_id: str = Field(default="default", min_length=1, max_length=128)
    # Hub, additional-account and owner-cloud ports have different opaque
    # binding shapes. Preserve and compare every component, including scopes.
    grant_binding: list[str] = Field(min_length=6, max_length=64)
    created_at_ms: int = Field(ge=1)

    def current(
        self,
        *,
        owner_id: str,
        conversation_id: str,
        grant_binding: tuple[str, ...] | None,
        now_ms: int | None = None,
    ) -> bool:
        now = int(time.time() * 1000) if now_ms is None else now_ms
        return bool(
            self.owner_id == owner_id
            and self.conversation_id == conversation_id
            and grant_binding
            and tuple(self.grant_binding) == tuple(grant_binding)
            and 0 <= now - self.created_at_ms <= _OFFER_TTL_MS
        )


class CalendarReadOffer(CalendarOfferIdentity):
    kind: Literal["events", "calendars", "invitations"]
    ids: list[str] = Field(min_length=1, max_length=250)
    calendar_id: str = Field(default="primary", min_length=1, max_length=1024)

    def id_at(self, ordinal: int) -> str | None:
        if isinstance(ordinal, bool) or not isinstance(ordinal, int):
            return None
        if 1 <= ordinal <= len(self.ids):
            return self.ids[ordinal - 1] or None
        return None


class CalendarEventsPage(CalendarOfferIdentity):
    calendar_id: str = Field(min_length=1, max_length=1024)
    start_at: str = Field(min_length=1, max_length=64)
    end_at: str = Field(min_length=1, max_length=64)
    query: str | None = Field(max_length=256)
    limit: int = Field(ge=1, le=250)
    page_token: str = Field(min_length=1, max_length=2048)


class CalendarAttendeeOffer(CalendarOfferIdentity):
    emails: list[str] = Field(min_length=1, max_length=25)


def make_calendar_read_offer(
    *,
    kind: Literal["events", "calendars", "invitations"],
    owner_id: str,
    conversation_id: str,
    grant_binding: tuple[str, ...],
    ids: list[str],
    calendar_id: str = "primary",
    account_id: str = "default",
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
                "account_id": account_id,
                "created_at_ms": int(time.time() * 1000),
            }
        )
    except (ValidationError, TypeError, ValueError):
        return None
    return offer.model_dump(mode="json")


def current_calendar_read_offer(
    raw: Any,
    *,
    kind: Literal["events", "calendars", "invitations"],
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
    if offer.kind != kind or not offer.current(
        owner_id=owner_id,
        conversation_id=conversation_id,
        grant_binding=grant_binding,
        now_ms=now_ms,
    ):
        return None
    return offer


class CalendarOpeningOffer(CalendarOfferIdentity):
    window: CalendarOpeningWindow
    slots: list[CalendarOpening] = Field(min_length=1, max_length=20)

    @model_validator(mode="after")
    def exact_results(self) -> Self:
        previous_end = None
        for slot in self.slots:
            self.window.validate_slot(slot)
            if previous_end is not None and instant(slot.start_at) < previous_end:
                raise ValueError("Opening results are not ordered")
            previous_end = instant(slot.end_at)
        return self

    def slot_at(self, ordinal: int) -> CalendarOpening | None:
        if isinstance(ordinal, bool) or not isinstance(ordinal, int):
            return None
        return self.slots[ordinal - 1] if 1 <= ordinal <= len(self.slots) else None


class CalendarSharedOpeningOffer(BaseModel):
    """All-account coverage has no implied booking destination."""

    model_config = ConfigDict(extra="forbid", strict=True)
    owner_id: str = Field(min_length=1, max_length=256)
    conversation_id: str = Field(min_length=1, max_length=256)
    created_at_ms: int = Field(ge=1)
    window: CalendarSharedOpeningWindow
    slots: list[CalendarOpening] = Field(min_length=1, max_length=20)

    @model_validator(mode="after")
    def exact_results(self) -> Self:
        previous_end = None
        for slot in self.slots:
            self.window.validate_slot(slot)
            if previous_end is not None and instant(slot.start_at) < previous_end:
                raise ValueError("Opening results are not ordered")
            previous_end = instant(slot.end_at)
        return self

    def current(self, *, owner_id: str, conversation_id: str) -> bool:
        return bool(
            self.owner_id == owner_id
            and self.conversation_id == conversation_id
            and 0 <= int(time.time() * 1000) - self.created_at_ms <= _OFFER_TTL_MS
        )

    def slot_at(self, ordinal: int) -> CalendarOpening | None:
        if isinstance(ordinal, bool) or not isinstance(ordinal, int):
            return None
        return self.slots[ordinal - 1] if 1 <= ordinal <= len(self.slots) else None


def current_calendar_opening_offer(
    raw: Any,
    *,
    owner_id: str,
    conversation_id: str,
    grant_binding: tuple[str, ...] | None,
    now_ms: int | None = None,
) -> CalendarOpeningOffer | None:
    try:
        offer = CalendarOpeningOffer.model_validate(raw)
    except (ValidationError, TypeError, ValueError):
        return None
    return (
        offer
        if offer.current(
            owner_id=owner_id,
            conversation_id=conversation_id,
            grant_binding=grant_binding,
            now_ms=now_ms,
        )
        else None
    )
