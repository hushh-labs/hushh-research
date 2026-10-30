"""Gene: the date that files a Drive file into a fiscal quarter.

Pure. The rule is the owner's: the date written in the file's title, else its
created time, else its modified time, read in the owner's time zone. Title
parsing is the repository's own (``drive_title_dates``); this adds only the
choice of one date and the fiscal calendar. A title that names several dates
files the file under the latest, because a statement belongs to the quarter it
ends in. A numeric date that reads two ways (``03-04-2026``) is not trusted, so
the file falls back to its created time rather than guessing a quarter.
"""

from __future__ import annotations

import calendar
from dataclasses import dataclass
from datetime import UTC, date, datetime
from zoneinfo import ZoneInfo

from hushh_mcp.services.drive_title_dates import parse_title_dates, resolve_title_dates


@dataclass(frozen=True, slots=True)
class FiscalQuarter:
    """``year`` is the two digits of the calendar year the fiscal year ends in."""

    year: int
    quarter: int

    @property
    def label(self) -> str:
        return f"FY {self.year:02d} Q{self.quarter}"


def fiscal_quarter(day: date, start_month: int = 4) -> FiscalQuarter:
    """The fiscal quarter of ``day`` for a year that starts on the 1st of ``start_month``.

    With April, 1 April 2025 to 31 March 2026 is FY 26, and April to June is Q1.
    With January the fiscal year is the calendar year.
    """
    if type(start_month) is not int or not 1 <= start_month <= 12:
        raise ValueError("fiscal year start month out of range")
    ends = day.year + (1 if start_month > 1 and day.month >= start_month else 0)
    return FiscalQuarter(ends % 100, ((day.month - start_month) % 12) // 3 + 1)


def title_day(name: str, *, zone: ZoneInfo, reference: date | None = None) -> date | None:
    """The latest unambiguous date written in a file title, or None.

    ``reference`` is the file's own date, used only to give a year-less date such
    as "Sept 14" the nearest year. A month alone counts as its last day.
    """
    resolved = resolve_title_dates(parse_title_dates(name), zone=zone, reference=reference)
    days = [*resolved.days]
    days.extend(
        date(year, month, calendar.monthrange(year, month)[1]) for year, month in resolved.months
    )
    return max(days) if days else None


def deciding_day(
    *, title: date | None, created: datetime | None, modified: datetime | None, zone: ZoneInfo
) -> tuple[date | None, str]:
    """The one date that decides a file's quarter, and which of the three it was."""
    if title is not None:
        return title, "title"
    for basis, moment in (("created", created), ("modified", modified)):
        if moment is not None:
            aware = moment if moment.tzinfo is not None else moment.replace(tzinfo=UTC)
            return aware.astimezone(zone).date(), basis
    return None, "none"
