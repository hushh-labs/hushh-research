"""Dates written in Drive file titles, and the period rule that uses them.

Pure functions: no provider call, no model, no I/O, no logging. A title date
decides a file's period when the title has one; otherwise the file's created
time, then its modified time (the autoshare precedence rule).

``in_requested_period`` is a drop-in superset of the owner search rule
``drive_owner_search_service._in_requested_period``: for every title that rule
can read (``2026-09-02``, ``2026/09/02 23:42 IST``, ``2026_09_02``,
``20260902``, and for autoshare ``14-09-2026`` and ``Sep 14, 2026``) it
returns the same answer (parity-tested), including the autoshare rule that
every title date must be inside the period. It also reads year-less month
names (``Sept 14``) and month-only titles (``September 2026``, ``2026-09``),
which the owner search rule replaces with file activity times.

Parsing is split from resolution so an index can parse each title once and
resolve it per request time zone cheaply.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from datetime import UTC, date, datetime, timedelta, timezone
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

_MONTHS = {
    "jan": 1,
    "january": 1,
    "feb": 2,
    "february": 2,
    "mar": 3,
    "march": 3,
    "apr": 4,
    "april": 4,
    "may": 5,
    "jun": 6,
    "june": 6,
    "jul": 7,
    "july": 7,
    "aug": 8,
    "august": 8,
    "sep": 9,
    "sept": 9,
    "september": 9,
    "oct": 10,
    "october": 10,
    "nov": 11,
    "november": 11,
    "dec": 12,
    "december": 12,
}
_MONTH = "|".join(sorted(_MONTHS, key=len, reverse=True))
_YEAR = r"(?:19|20)\d{2}"
# Same shapes as the owner search rule: any separator of - / . _ and compact.
_ISO_DAY = re.compile(r"(?<!\d)(?P<year>\d{4})[-/._](?P<month>\d{1,2})[-/._](?P<day>\d{1,2})(?!\d)")
_COMPACT_DAY = re.compile(rf"(?<!\d)(?P<year>{_YEAR})(?P<month>\d{{2}})(?P<day>\d{{2}})(?!\d)")
_DAY_FIRST = re.compile(
    rf"(?<!\d)(?P<first>\d{{1,2}})[-/.](?P<second>\d{{1,2}})[-/.](?P<year>{_YEAR})(?!\d)"
)
_MONTH_DAY = re.compile(
    rf"(?<![a-z])(?P<month>{_MONTH})\.?[\s-]*(?P<day>\d{{1,2}})(?:st|nd|rd|th)?(?!\d)"
    rf"(?:,?[\s-]+(?P<year>{_YEAR})(?!\d))?",
    re.I,
)
_DAY_MONTH = re.compile(
    rf"(?<!\d)(?P<day>\d{{1,2}})(?:st|nd|rd|th)?[\s-]*(?P<month>{_MONTH})\.?(?![a-z])"
    rf"(?:,?[\s-]+(?P<year>{_YEAR})(?!\d))?",
    re.I,
)
_MONTH_YEAR = re.compile(rf"(?<![a-z])(?P<month>{_MONTH})\.?,?[\s-]*(?P<year>{_YEAR})(?!\d)", re.I)
_ISO_MONTH = re.compile(rf"(?<!\d)(?P<year>{_YEAR})[-_.](?P<month>0[1-9]|1[0-2])(?!\d)(?![-_./]\d)")
_TITLE_TIME = re.compile(
    r"[ T](?P<hour>\d{1,2}):(?P<minute>\d{2})\s*"
    r"(?P<zone>IST|(?:UTC|GMT)(?:[+-]\d{1,2}(?::?\d{2})?)?)\b",
    re.I,
)

# Parsed readings, independent of any time zone:
#   ("day", year, month, day, hour, minute, zone)  hour == -1 means no time
#   ("either", year, (month, day), (month, day))   one numeric date, two readings
#   ("yearless", month, day)                       year comes from file time
#   ("month", year, month)                         a whole month
RawTitleDates = tuple[tuple, ...]


@dataclass(frozen=True, slots=True)
class TitleDates:
    days: tuple[date, ...] = ()
    either: tuple[tuple[date, ...], ...] = ()
    months: tuple[tuple[int, int], ...] = ()

    @property
    def present(self) -> bool:
        return bool(self.days or self.either or self.months)


@dataclass(frozen=True, slots=True)
class PeriodDecision:
    in_period: bool
    listing_day: str | None
    basis: str  # "title" | "created" | "modified" | "none"


def _mask(text: str, match: re.Match[str]) -> str:
    return text[: match.start()] + " " * (match.end() - match.start()) + text[match.end() :]


def parse_title_dates(name: str) -> RawTitleDates:
    """Every date written in ``name``; earlier patterns claim their text first."""
    if not isinstance(name, str) or not any(character.isdigit() for character in name):
        return ()
    readings: list[tuple] = []
    text = name
    for pattern in (_ISO_DAY, _COMPACT_DAY):
        for match in list(pattern.finditer(text)):
            time = _TITLE_TIME.match(name, match.end())
            readings.append(
                (
                    "day",
                    int(match["year"]),
                    int(match["month"]),
                    int(match["day"]),
                    int(time["hour"]) if time else -1,
                    int(time["minute"]) if time else -1,
                    time["zone"].upper() if time else "",
                )
            )
            text = _mask(text, match)
    for match in list(_DAY_FIRST.finditer(text)):
        first, second, year = int(match["first"]), int(match["second"]), int(match["year"])
        if first > 12 or first == second:
            readings.append(("day", year, second, first, -1, -1, ""))
        elif second > 12:
            readings.append(("day", year, first, second, -1, -1, ""))
        else:
            readings.append(("either", year, (second, first), (first, second)))
        text = _mask(text, match)
    for pattern in (_MONTH_DAY, _DAY_MONTH):
        for match in list(pattern.finditer(text)):
            month, day = _MONTHS[match["month"].lower()], int(match["day"])
            if match["year"]:
                readings.append(("day", int(match["year"]), month, day, -1, -1, ""))
            else:
                readings.append(("yearless", month, day))
            text = _mask(text, match)
    for pattern in (_MONTH_YEAR, _ISO_MONTH):
        for match in list(pattern.finditer(text)):
            month = match["month"]
            number = int(month) if month.isdigit() else _MONTHS[month.lower()]
            readings.append(("month", int(match["year"]), number))
            text = _mask(text, match)
    return tuple(readings)


def _source_zone(zone: str) -> timezone | ZoneInfo | None:
    if zone == "IST":
        return ZoneInfo("Asia/Kolkata")
    if zone in {"UTC", "GMT"}:
        return UTC
    offset = zone[3:]
    sign = 1 if offset[0] == "+" else -1
    clock = offset[1:]
    if ":" in clock:
        hour_text, minute_text = clock.split(":", 1)
    else:
        hour_text, minute_text = (clock[:-2], clock[-2:]) if len(clock) > 2 else (clock, "0")
    hours, minutes = int(hour_text), int(minute_text)
    if hours > 23 or minutes > 59:
        return None
    return timezone(sign * timedelta(hours=hours, minutes=minutes))


def _closest_year(month: int, day: int, reference: date) -> date | None:
    best = None
    for year in (reference.year - 1, reference.year, reference.year + 1):
        try:
            value = date(year, month, day)
        except ValueError:
            continue
        if best is None or abs(value - reference) < abs(best - reference):
            best = value
    return best


def resolve_title_dates(
    raw: RawTitleDates, *, zone: ZoneInfo | None = None, reference: date | None = None
) -> TitleDates:
    """Turn parsed readings into calendar days in ``zone``.

    A written clock time with a zone moves the day into ``zone``, exactly as
    the owner search rule does. An impossible date is skipped, not guessed.
    A year-less date takes the year nearest the file's own date, and stays
    unresolved without one.
    """
    days: list[date] = []
    either: list[tuple[date, ...]] = []
    months: list[tuple[int, int]] = []
    for reading in raw:
        kind = reading[0]
        try:
            if kind == "day":
                _, year, month, day, hour, minute, written_zone = reading
                value = date(year, month, day)
                if hour >= 0 and zone is not None:
                    source = _source_zone(written_zone)
                    if source is None:
                        continue
                    value = (
                        datetime(year, month, day, hour, minute, tzinfo=source)
                        .astimezone(zone)
                        .date()
                    )
                days.append(value)
            elif kind == "either":
                _, year, first, second = reading
                readings = tuple(dict.fromkeys(date(year, m, d) for m, d in (first, second)))
                if len(readings) == 1:
                    days.append(readings[0])
                else:
                    either.append(readings)
            elif kind == "yearless":
                if reference is not None:
                    value = _closest_year(reading[1], reading[2], reference)
                    if value is not None:
                        days.append(value)
            elif kind == "month" and 1 <= reading[2] <= 12:
                months.append((reading[1], reading[2]))
        except ValueError:
            continue
    return TitleDates(tuple(days), tuple(either), tuple(months))


def _zone(name: object) -> ZoneInfo:
    try:
        return ZoneInfo(name) if isinstance(name, str) and name else ZoneInfo("UTC")
    except (ValueError, ZoneInfoNotFoundError):
        return ZoneInfo("UTC")


def _timestamp_day(value: object, zone: ZoneInfo) -> date | None:
    if not isinstance(value, str):
        return None
    try:
        timestamp = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None
    if timestamp.tzinfo is None or timestamp.utcoffset() is None:
        return None
    return timestamp.astimezone(zone).date()


def _month_bounds(year: int, month: int) -> tuple[date, date]:
    first = date(year, month, 1)
    following = date(year + month // 12, month % 12 + 1, 1)
    return first, following - timedelta(days=1)


def period_decision(
    match: dict,
    period: dict | None,
    *,
    precedence: bool = True,
    raw: RawTitleDates | None = None,
) -> PeriodDecision:
    """Decide one file against a requested period and say which date decided.

    ``match`` carries ``name``, ``created_time`` and ``modified_time`` (the
    owner search match shape). ``period`` is ``{"start", "end", "timezone"}``
    or None. With ``precedence`` only the first present date decides: title,
    else created, else modified. Without it either timestamp may match.

    With ``precedence`` every title date must be inside the period, as the
    owner search rule requires for autoshare; without it, any one inside
    matches. One numeric date that reads two ways (``03-04-2026``) is inside
    only when both readings are, so an ambiguous title never widens automatic
    sharing. A month-only title is inside when that month overlaps the period.
    """
    zone = _zone(period.get("timezone")) if period else ZoneInfo("UTC")
    start = date.fromisoformat(period["start"]) if period else None
    end = date.fromisoformat(period["end"]) if period else None
    readings = parse_title_dates(match.get("name", "")) if raw is None else raw
    # File times are parsed only when a year-less title or the fallback needs them.
    reference = (
        _timestamp_day(match.get("created_time"), zone)
        or _timestamp_day(match.get("modified_time"), zone)
        if any(reading[0] == "yearless" for reading in readings)
        else None
    )
    title = resolve_title_dates(readings, zone=zone, reference=reference)
    if title.present:
        if start is None or end is None:
            latest = max(
                [*title.days, *(day for group in title.either for day in group)]
                + [_month_bounds(*month)[0] for month in title.months]
            )
            return PeriodDecision(True, latest.isoformat(), "title")
        readings = (
            [(start <= day <= end, day) for day in title.days]
            + [(all(start <= day <= end for day in group), max(group)) for group in title.either]
            + [
                (first <= end and start <= last, max(first, start))
                for first, last in (_month_bounds(*month) for month in title.months)
            ]
        )
        inside = [day for matched, day in readings if matched]
        # Autoshare (precedence) never grants a file with any title date
        # outside the period, the owner search rule; file activity needs one.
        if inside and (not precedence or len(inside) == len(readings)):
            return PeriodDecision(True, inside[0].isoformat(), "title")
        return PeriodDecision(False, None, "title")
    for basis, key in (("created", "created_time"), ("modified", "modified_time")):
        day = _timestamp_day(match.get(key), zone)
        if day is None:
            continue
        if start is None or end is None or start <= day <= end:
            return PeriodDecision(True, day.isoformat(), basis)
        if precedence:
            return PeriodDecision(False, day.isoformat(), basis)
    return PeriodDecision(period is None, None, "none")


def period_window(period: dict | None) -> tuple[float, float, ZoneInfo] | None:
    """The period as instants [local midnight of start, local midnight after end).

    A timestamp's local day is inside the period exactly when the timestamp
    is inside this window, so callers can compare epoch seconds directly.
    """
    if not period:
        return None
    zone = _zone(period.get("timezone"))
    first = date.fromisoformat(period["start"])
    after = date.fromisoformat(period["end"]) + timedelta(days=1)
    return (
        datetime(first.year, first.month, first.day, tzinfo=zone).timestamp(),
        datetime(after.year, after.month, after.day, tzinfo=zone).timestamp(),
        zone,
    )


def timestamp_seconds(value: object) -> float | None:
    """Epoch seconds of an RFC 3339 provider time; None when absent or naive."""
    if not isinstance(value, str):
        return None
    try:
        timestamp = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None
    if timestamp.tzinfo is None or timestamp.utcoffset() is None:
        return None
    return timestamp.timestamp()


def in_requested_period(match: dict, period: dict | None, *, precedence: bool = False) -> bool:
    """Drop-in for ``_in_requested_period``; same default (file activity)."""
    return period_decision(match, period, precedence=precedence).in_period


__all__ = [
    "PeriodDecision",
    "RawTitleDates",
    "TitleDates",
    "in_requested_period",
    "parse_title_dates",
    "period_decision",
    "period_window",
    "resolve_title_dates",
    "timestamp_seconds",
]
