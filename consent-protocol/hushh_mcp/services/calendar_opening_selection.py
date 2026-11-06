"""Exact Calendar opening facts shared by private offers and confirmed plans."""

from __future__ import annotations

from collections.abc import Iterable
from datetime import UTC, datetime, timedelta
from typing import Literal, Self, TypedDict

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

from hushh_mcp.services.calendar_time_zone import normalize_time_zone
from hushh_mcp.services.google_connection_contract import GoogleConnectionError


def instant(value: str) -> datetime:
    parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    if parsed.tzinfo is None:
        raise ValueError("Opening times require an offset")
    return parsed.astimezone(UTC)


class OpeningOptions(TypedDict):
    openings: list[dict[str, str]]
    available_slot_count: int
    suggestion_limit: int
    suggestions_limited: bool


def opening_options(
    gaps: Iterable[tuple[datetime, datetime]], duration_minutes: int, limit: int
) -> OpeningOptions:
    """Expand verified free intervals into bounded, non-overlapping UTC options.

    This computes suggestion counts only. The caller owns provider coverage.
    """
    if type(duration_minutes) is not int or not 1 <= duration_minutes <= 1440:
        raise ValueError("Invalid slot duration")
    if type(limit) is not int or not 1 <= limit <= 20:
        raise ValueError("Invalid suggestion limit")
    duration = timedelta(minutes=duration_minutes)
    slots: list[dict[str, str]] = []
    count = 0
    previous_end: datetime | None = None
    for left, right in gaps:
        if left.tzinfo is None or right.tzinfo is None:
            raise ValueError("Free intervals require qualified instants")
        left, right = left.astimezone(UTC), right.astimezone(UTC)
        if right < left or (previous_end is not None and left < previous_end):
            raise ValueError("Free intervals must be ordered and non-overlapping")
        previous_end = right
        count += (right - left) // duration
        while left + duration <= right and len(slots) < limit:
            slots.append(
                {
                    "start_at": left.isoformat().replace("+00:00", "Z"),
                    "end_at": (left + duration).isoformat().replace("+00:00", "Z"),
                    "available_until": right.isoformat().replace("+00:00", "Z"),
                }
            )
            left += duration
    return {
        "openings": slots,
        "available_slot_count": count,
        "suggestion_limit": limit,
        "suggestions_limited": count > limit,
    }


class CalendarOpening(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)

    start_at: str
    end_at: str
    available_until: str

    @field_validator("start_at", "end_at", "available_until")
    @classmethod
    def utc_instant(cls, value: str) -> str:
        return instant(value).isoformat().replace("+00:00", "Z")

    @model_validator(mode="after")
    def ordered(self) -> Self:
        if not instant(self.start_at) < instant(self.end_at) <= instant(self.available_until):
            raise ValueError("Opening boundaries are invalid")
        return self


class CalendarOpeningRange(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)

    query_start: str
    query_end: str
    duration_minutes: int = Field(ge=5, le=720)
    time_zone: str = Field(min_length=1, max_length=128)

    @field_validator("query_start", "query_end")
    @classmethod
    def utc_instant(cls, value: str) -> str:
        return instant(value).isoformat().replace("+00:00", "Z")

    @field_validator("time_zone")
    @classmethod
    def iana_zone(cls, value: str) -> str:
        try:
            return normalize_time_zone(value, default="")
        except GoogleConnectionError as exc:
            raise ValueError("Opening timezone is invalid") from exc

    @model_validator(mode="after")
    def valid_window(self) -> Self:
        if instant(self.query_start) >= instant(self.query_end):
            raise ValueError("Opening window is invalid")
        return self

    def validate_slot(self, slot: CalendarOpening) -> None:
        if (
            not instant(self.query_start) <= instant(slot.start_at)
            or instant(slot.available_until) > instant(self.query_end)
            or instant(slot.end_at) - instant(slot.start_at)
            != timedelta(minutes=self.duration_minutes)
        ):
            raise ValueError("Opening does not fit its original window and duration")


class CalendarOpeningWindow(CalendarOpeningRange):
    calendar_id: str = Field(min_length=1, max_length=1024)
    calendar_ids: list[str] = Field(min_length=1, max_length=100)
    coverage_policy: Literal["legacy_primary", "board_default"] = "legacy_primary"

    @model_validator(mode="after")
    def valid_coverage(self) -> Self:
        if (
            len(set(self.calendar_ids)) != len(self.calendar_ids)
            or any(not value.strip() for value in self.calendar_ids)
            or self.calendar_id not in self.calendar_ids
        ):
            raise ValueError("Opening coverage is invalid")
        return self


class CalendarAvailabilityAccount(BaseModel):
    """Private source evidence; never project the opaque grant to the model."""

    model_config = ConfigDict(extra="forbid", strict=True)
    account_id: str = Field(min_length=1, max_length=128)
    account_email: str = Field(min_length=1, max_length=320)
    binding: list[str] = Field(min_length=1, max_length=64)
    calendar_ids: list[str] = Field(min_length=1, max_length=250)

    @model_validator(mode="after")
    def unique_calendars(self) -> Self:
        if len(set(self.calendar_ids)) != len(self.calendar_ids) or any(
            not value.strip() for value in self.calendar_ids
        ):
            raise ValueError("Opening coverage is invalid")
        return self


class CalendarSharedOpeningWindow(CalendarOpeningRange):
    board_accounts: list[CalendarAvailabilityAccount] = Field(min_length=1, max_length=3)

    @model_validator(mode="after")
    def unique_accounts(self) -> Self:
        ids = [item.account_id for item in self.board_accounts]
        if len(set(ids)) != len(ids):
            raise ValueError("Opening account coverage is invalid")
        return self


class CalendarSharedOpeningSelection(CalendarSharedOpeningWindow):
    slot: CalendarOpening
    offer_created_at_ms: int = Field(ge=1)

    @model_validator(mode="after")
    def exact_slot(self) -> Self:
        self.validate_slot(self.slot)
        return self


class CalendarOpeningSelection(CalendarOpeningWindow):
    slot: CalendarOpening

    @model_validator(mode="after")
    def exact_slot(self) -> Self:
        self.validate_slot(self.slot)
        return self
