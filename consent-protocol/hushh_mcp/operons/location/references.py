"""Transient resource locators, never execution or consent authority."""

from datetime import UTC, datetime, timedelta
from typing import Literal

from pydantic import Field, field_validator

from .plan import CommandValue


class LocationObservation(CommandValue):
    reference: str = Field(pattern=r"^candidate_[a-f0-9]{32}$")
    kind: Literal["person", "circle", "place", "share", "request"]
    id: str = Field(min_length=1, max_length=300)
    name: str = Field(min_length=1, max_length=120)
    observed_at: datetime

    @field_validator("observed_at")
    @classmethod
    def timezone_required(cls, value: datetime):
        if value.tzinfo is None:
            raise ValueError("An observation requires an absolute timestamp.")
        return value


def fresh_observations(
    values: list[LocationObservation],
    *,
    now: datetime | None = None,
    retention: timedelta = timedelta(minutes=15),
):
    now = now or datetime.now(UTC)
    if len(values) > 50 or len({value.reference for value in values}) != len(values):
        raise ValueError("The observation list exceeds its bounds or repeats a handle.")
    return [value for value in values if now - retention <= value.observed_at <= now]
