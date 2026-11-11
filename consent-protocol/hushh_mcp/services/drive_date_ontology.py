"""Pure bounded date eligibility over one provider metadata row; no provider reads."""

from __future__ import annotations

import re
from calendar import monthrange
from datetime import date, datetime
from zoneinfo import ZoneInfo

DATE_ONTOLOGY_VERSION = "drive_activity_union_v1"
MAX_FILENAME_BYTES = 256 * 1024
MAX_FILENAME_TOKENS = 64
TIME_FIELDS = (
    "createdTime",
    "modifiedTime",
    "modifiedByMeTime",
    "sharedWithMeTime",
    "viewedByMeTime",
)
_DAY = re.compile(r"\d{4}-\d{2}-\d{2}", re.ASCII)
_RFC = re.compile(
    r"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)",
    re.ASCII,
)
_PHOTO = re.compile(
    r"(\d{4}):(\d{2}):(\d{2})[ T](\d{2}):(\d{2}):(\d{2})(Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)?",
    re.ASCII,
)
_MONTHS = {}
for _number, _names in enumerate(
    (
        "jan january",
        "feb february",
        "mar march",
        "apr april",
        "may",
        "jun june",
        "jul july",
        "aug august",
        "sep sept september",
        "oct october",
        "nov november",
        "dec december",
    ),
    1,
):
    _MONTHS.update(dict.fromkeys(_names.split(), _number))
_MONTH = "(?:" + "|".join(sorted(_MONTHS, key=len, reverse=True)) + ")"
_SEP = r"[-_./,\s]+"
_YEAR = r"(?:\d{4}|\d{2})"
_PATTERNS = tuple(
    (kind, re.compile(rf"(?<!\d){expression}(?![a-z0-9])", re.I | re.ASCII))
    for kind, expression in (
        ("ymd", rf"(\d{{4}}){_SEP}(\d{{1,2}}){_SEP}(\d{{1,2}})"),
        ("compact", r"(\d{4})(\d{2})(\d{2})"),
        ("numeric", rf"(\d{{1,2}}){_SEP}(\d{{1,2}}){_SEP}({_YEAR})"),
        ("day_named", rf"(\d{{1,2}}){_SEP}({_MONTH}){_SEP}({_YEAR})"),
        ("named_day", rf"(?<![a-z])({_MONTH}){_SEP}(\d{{1,2}}){_SEP}({_YEAR})"),
        ("year_named_day", rf"(\d{{4}}){_SEP}({_MONTH}){_SEP}(\d{{1,2}})"),
        ("month_named", rf"(?<![a-z])({_MONTH}){_SEP}({_YEAR})"),
        ("year_named", rf"(\d{{4}}){_SEP}({_MONTH})(?![a-z])"),
        ("month_numeric", rf"(\d{{1,2}}){_SEP}(\d{{4}})"),
        ("year_numeric", rf"(\d{{4}}){_SEP}(\d{{1,2}})"),
        ("year", r"(?<![a-z0-9])(\d{4})(?![a-z0-9])"),
    )
)


def _period(period):
    try:
        start, end, timezone = period["start"], period["end"], period["timezone"]
        if (
            not isinstance(start, str)
            or not _DAY.fullmatch(start)
            or not isinstance(end, str)
            or not _DAY.fullmatch(end)
            or not isinstance(timezone, str)
            or not 1 <= len(timezone) <= 100
        ):
            raise ValueError
        first, last = date.fromisoformat(start), date.fromisoformat(end)
        if first > last:
            raise ValueError
        return first, last, ZoneInfo(timezone)
    except (KeyError, TypeError, ValueError, OverflowError):
        raise ValueError("invalid_date_period") from None


def _instant(raw, zone):
    if not isinstance(raw, str) or len(raw) > 64 or not _RFC.fullmatch(raw):
        return None
    try:
        return datetime.fromisoformat(raw.replace("Z", "+00:00")).astimezone(zone).date()
    except (ValueError, OverflowError):
        return None


def _photo_day(raw, zone):
    if not isinstance(raw, str) or len(raw) > 64:
        return None, None
    match = _PHOTO.fullmatch(raw)
    if match:
        year, month, day, hour, minute, second, offset = match.groups()
        value = f"{year}-{month}-{day}T{hour}:{minute}:{second}"
        try:
            if offset:
                parsed = _instant(value + offset, zone)
                return parsed, "photo_offset" if parsed else None
            return datetime.fromisoformat(value).date(), "photo_recorded_date"
        except ValueError:
            return None, None
    parsed = _instant(raw, zone)
    return parsed, "photo_offset" if parsed else None


def _day(year, month, day):
    try:
        return date(year, month, day)
    except ValueError:
        return None


def _year(value):
    number = int(value)
    return number if len(value) == 4 else number + (1900 if number > 60 else 2000)


def _numeric_dates(parts, anchors):
    left, right, year = int(parts[0]), int(parts[1]), _year(parts[2])
    dmy, mdy = _day(year, right, left), _day(year, left, right)
    if dmy is None:
        return [(mdy, "title_mdy")] if mdy else []
    if mdy is None:
        return [(dmy, "title_dmy")]
    if dmy == mdy:
        return [(dmy, "title_numeric_unambiguous")]
    if anchors:
        dmy_distance = min(abs((dmy - anchor).days) for anchor in anchors)
        mdy_distance = min(abs((mdy - anchor).days) for anchor in anchors)
        if dmy_distance <= 14 and mdy_distance > 20:
            return [(dmy, "title_anchor_dmy")]
        if mdy_distance <= 14 and dmy_distance > 20:
            return [(mdy, "title_anchor_mdy")]
    return [(dmy, "title_dmy"), (mdy, "title_mdy")]


def _ranges(kind, parts, anchors, first, last):
    if kind == "numeric":
        return [
            (value, value, label, "filename_date")
            for value, label in _numeric_dates(parts, anchors)
        ]
    if kind in {"ymd", "compact"}:
        value = _day(*map(int, parts))
        return [(value, value, "title_ymd", "filename_date")] if value else []
    if kind in {"day_named", "named_day", "year_named_day"}:
        if kind == "day_named":
            year, month, day = _year(parts[2]), _MONTHS[parts[1].lower()], int(parts[0])
        elif kind == "named_day":
            year, month, day = _year(parts[2]), _MONTHS[parts[0].lower()], int(parts[1])
        else:
            year, month, day = int(parts[0]), _MONTHS[parts[1].lower()], int(parts[2])
        value = _day(year, month, day)
        return [(value, value, "title_named_day", "filename_date")] if value else []
    if kind == "year":
        year = int(parts[0])
        beginning, ending = date(year, 1, 1), date(year, 12, 31)
        return (
            [(beginning, ending, "title_full_year", "filename_year")]
            if first <= beginning and ending <= last
            else []
        )
    if kind == "month_named":
        year, month = _year(parts[1]), _MONTHS[parts[0].lower()]
    elif kind == "year_named":
        year, month = int(parts[0]), _MONTHS[parts[1].lower()]
    elif kind == "month_numeric":
        year, month = int(parts[1]), int(parts[0])
    else:
        year, month = int(parts[0]), int(parts[1])
    beginning, ending = date(year, month, 1), date(year, month, monthrange(year, month)[1])
    return [(beginning, ending, "title_month_year", "filename_month_year")]


def _filename(name, anchors, first, last):
    signals, interpretations, unknown = set(), set(), set()
    if not isinstance(name, str) or not name:
        return signals, interpretations, {"filename_missing"}
    try:
        if len(name) > MAX_FILENAME_BYTES or len(name.encode("utf-8")) > MAX_FILENAME_BYTES:
            return signals, interpretations, {"filename_invalid"}
    except UnicodeError:
        return signals, interpretations, {"filename_invalid"}
    occupied = []
    for kind, pattern in _PATTERNS:
        for match in pattern.finditer(name):
            start, end = match.span()
            if any(
                start < previous_end and previous_start < end
                for previous_start, previous_end in occupied
            ):
                continue
            if len(occupied) >= MAX_FILENAME_TOKENS:
                return signals, interpretations, unknown | {"filename_budget"}
            occupied.append((start, end))
            try:
                ranges = _ranges(kind, match.groups(), anchors, first, last)
            except (KeyError, ValueError, OverflowError):
                ranges = []
            if not ranges and kind != "year":
                unknown.add("filename_invalid_date")
            for lower, upper, label, signal in ranges:
                if lower <= last and first <= upper:
                    signals.add(signal)
                    interpretations.add(label)
    if not occupied:
        unknown.add("filename_no_supported_date")
    return signals, interpretations, unknown


def match_activity_dates(source, period, *, basis="activity_union"):
    """Return bounded frozen evidence; unknown labels never contain source values."""
    if basis not in {"activity_union", "created", "modified"}:
        raise ValueError("invalid_date_basis")
    if not isinstance(source, dict):
        raise ValueError("invalid_date_source")
    first, last, zone = _period(period)
    signals, interpretations, unknown, observed = set(), set(), set(), {}
    for field in TIME_FIELDS:
        value = _instant(source.get(field), zone)
        if value is None:
            unknown.add(field)
        else:
            observed[field] = value
            if first <= value <= last:
                signals.add(field)
    image = source.get("imageMediaMetadata")
    photo, interpretation = _photo_day(image.get("time") if isinstance(image, dict) else None, zone)
    if photo is None:
        unknown.add("image_capture_time")
    elif first <= photo <= last:
        signals.add("image_capture_time")
        interpretations.add(interpretation)
    anchors = [observed[field] for field in ("createdTime", "modifiedTime") if field in observed]
    title_signals, title_interpretations, title_unknown = _filename(
        source.get("name", source.get("title")), anchors, first, last
    )
    signals.update(title_signals)
    interpretations.update(title_interpretations)
    unknown.update(title_unknown)
    if basis != "activity_union":
        signals.intersection_update({"createdTime" if basis == "created" else "modifiedTime"})
        interpretations.clear()
    return {
        "policy": DATE_ONTOLOGY_VERSION,
        "matched": bool(signals),
        "signals": sorted(signals),
        "interpretations": sorted(interpretations),
        "unknown": sorted(unknown),
    }
