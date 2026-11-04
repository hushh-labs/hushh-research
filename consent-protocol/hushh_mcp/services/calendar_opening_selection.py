"""Exact Calendar opening facts shared by private offers and confirmed plans."""

from __future__ import annotations

from datetime import UTC, datetime, timedelta
from typing import Self

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

from hushh_mcp.services.calendar_time_zone import normalize_time_zone
from hushh_mcp.services.google_connection_contract import GoogleConnectionError


def instant(value: str) -> datetime:
    parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    if parsed.tzinfo is None:
        raise ValueError("Opening times require an offset")
    return parsed.astimezone(UTC)


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


class CalendarOpeningWindow(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)

    calendar_id: str = Field(min_length=1, max_length=1024)
    calendar_ids: list[str] = Field(min_length=1, max_length=20)
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
        if (
            instant(self.query_start) >= instant(self.query_end)
            or len(set(self.calendar_ids)) != len(self.calendar_ids)
            or any(not value.strip() for value in self.calendar_ids)
            or self.calendar_id not in self.calendar_ids
        ):
            raise ValueError("Opening coverage is invalid")
        return self

    def validate_slot(self, slot: CalendarOpening) -> None:
        if (
            not instant(self.query_start) <= instant(slot.start_at)
            or instant(slot.available_until) > instant(self.query_end)
            or instant(slot.end_at) - instant(slot.start_at)
            != timedelta(minutes=self.duration_minutes)
        ):
            raise ValueError("Opening does not fit its original window and duration")


class CalendarOpeningSelection(CalendarOpeningWindow):
    slot: CalendarOpening

    @model_validator(mode="after")
    def exact_slot(self) -> Self:
        self.validate_slot(self.slot)
        return self
