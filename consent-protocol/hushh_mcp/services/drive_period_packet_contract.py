"""Calendar and immutable metadata contracts for provider-discovery packets."""

from __future__ import annotations

import calendar
from datetime import date, datetime
from typing import Literal
from uuid import UUID, uuid5
from zoneinfo import ZoneInfo

from pydantic import BaseModel, ConfigDict, model_validator

PERIOD_PACKET_POLICY = "drive-period-provider-discovery-v1"
PERIOD_PACKET_PRICE_CENTS = 500
PERIOD_PACKET_KIND = "provider_discovery"
Category = Literal["financial", "bank", "brokerage", "insurance"]
CATEGORY_PURPOSES = {
    "financial": "All financial statements",
    "bank": "All bank account statements",
    "brokerage": "All brokerage statements",
    "insurance": "All insurance documents",
}


class PacketPeriod(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)
    start: date
    end: date
    timezone: str

    @model_validator(mode="after")
    def calendar_pair(self):
        ZoneInfo(self.timezone)
        if (
            self.start.day != 1
            or self.start.month % 2 != 1
            or self.end.year != self.start.year
            or self.end.month != self.start.month + 1
            or self.end.day != calendar.monthrange(self.end.year, self.end.month)[1]
        ):
            raise ValueError("A packet period must be a complete calendar month pair")
        return self

    def closed(self, now: datetime) -> bool:
        if now.tzinfo is None:
            raise ValueError("A current instant must be timezone aware")
        return now.astimezone(ZoneInfo(self.timezone)).date() > self.end


def current_year_periods(now: datetime, timezone: str) -> list[PacketPeriod]:
    if now.tzinfo is None:
        raise ValueError("A current instant must be timezone aware")
    today = now.astimezone(ZoneInfo(timezone)).date()
    return [
        PacketPeriod(
            start=date(today.year, month, 1),
            end=date(today.year, month + 1, calendar.monthrange(today.year, month + 1)[1]),
            timezone=timezone,
        )
        for month in range(1, today.month + 1, 2)
    ]


def period_packet_key(category: Category, period: PacketPeriod) -> str:
    if category not in CATEGORY_PURPOSES:
        raise ValueError("Unknown period packet category")
    return f"{PERIOD_PACKET_POLICY}:{category}:{period.start}:{period.end}:{period.timezone}"


def packet_document_id(packet_id: str, provider_file_id: str) -> str:
    return str(uuid5(UUID(str(packet_id)), provider_file_id))
