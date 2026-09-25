"""Narrow owner-only metadata listing for explicitly named recent Drive files.

This module makes no provider calls and grants no sharing authority. The caller
must search Drive under the owner's current access fence and treat the result
as candidates, since a bounded Drive search cannot prove complete coverage.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from datetime import date, datetime, timedelta
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

_PREFIX = (
    r"\s*(?:(?:please\s+)?(?:share|show|find|get|list)\s+(?:me\s+)?|"
    r"(?:i\s+(?:want|need)\s+))?all\s+(?:of\s+)?(?:my\s+)?"
)
_SUBJECT = r"(?P<title>[A-Za-z][A-Za-z0-9-]*(?:\s+[A-Za-z][A-Za-z0-9-]*){0,5})"
_DAYS = r"[1-9]|[12]\d|3[01]"
_LISTING = re.compile(
    _PREFIX + rf"(?:last|past)\s+(?P<days>{_DAYS})\s+days?\s+" + _SUBJECT,
    re.IGNORECASE,
)
_LISTING_SUBJECT_FIRST = re.compile(
    _PREFIX + _SUBJECT + rf"\s+(?:from|for)\s+(?:the\s+)?(?:last|past)\s+(?P<days>{_DAYS})\s+days?",
    re.IGNORECASE,
)
_SHOW_MY_LISTING = re.compile(
    r"\s*(?:please\s+)?(?:show|find|list)\s+(?:me\s+)?my\s+"
    + rf"(?:last|past)\s+(?P<days>{_DAYS})\s+days?\s+"
    + _SUBJECT,
    re.IGNORECASE,
)
_PRIOR_LISTING = re.compile(
    _PREFIX
    + _SUBJECT
    + rf"\s+from\s+(?:the\s+)?(?P<days>{_DAYS})\s+days?\s+before\s+the\s+"
    + rf"(?:last|latest|most\s+recent)\s+(?P<previous>{_DAYS})\s+days?",
    re.IGNORECASE,
)
_PRIOR_LISTING_PREFIX = re.compile(
    _PREFIX
    + rf"(?P<days>{_DAYS})\s+days?\s+before\s+the\s+"
    + rf"(?:last|latest|most\s+recent)\s+(?P<previous>{_DAYS})\s+days?\s+"
    + _SUBJECT,
    re.IGNORECASE,
)
# Exact UAT wording. The repeated numbers must agree before it acquires the
# clear "one preceding window" meaning; looser "last to last" text falls back.
_PRIOR_UAT = re.compile(
    _PREFIX
    + rf"last\s+to\s+last\s+(?P<days>{_DAYS})\s+days?\s+"
    + _SUBJECT
    + rf"\s+not\s+recent\s+last\s+(?P<recent>{_DAYS})\s+its\s+like\s+"
    + rf"(?P<before>{_DAYS})\s+before\s+then\s+(?P<then>{_DAYS})"
    + rf"\s+i\s+need\s+all\s+(?P<count>{_DAYS})\s+check\s+my\s+drive\s*[?.!]?\s*",
    re.IGNORECASE,
)
_TITLE_DATE = re.compile(
    r"(?<!\d)(?P<year>\d{4})(?P<separator>[-/])(?P<month>\d{2})"
    r"(?P=separator)(?P<day>\d{2})(?!\d)"
)
_FOLDER_MIME = "application/vnd.google-apps.folder"
_GENERIC_SUBJECT_WORDS = frozenset(
    {"file", "files", "doc", "docs", "document", "documents", "note", "notes"}
)
_CONTENT_OR_VAGUE_WORDS = frozenset(
    {
        "a",
        "about",
        "all",
        "an",
        "and",
        "any",
        "check",
        "compare",
        "contents",
        "explain",
        "for",
        "how",
        "in",
        "list",
        "me",
        "my",
        "of",
        "on",
        "recent",
        "share",
        "show",
        "some",
        "stuff",
        "summarize",
        "summary",
        "tell",
        "the",
        "them",
        "these",
        "things",
        "those",
        "to",
        "what",
        "why",
    }
)
_OPTIONAL_COUNT = re.compile(r"\s+i\s+need\s+all\s+(?P<count>\d{1,3})\s*$", re.IGNORECASE)
_CHECK_DRIVE = re.compile(r"\s*(?:/\s*)?check\s+my\s+drive\s*$", re.IGNORECASE)


@dataclass(frozen=True, slots=True)
class LongRangeListing:
    """A validated candidate-listing intent, never an instruction to share."""

    relative_days: int
    offset_days: int = 0
    anchor: str = ""
    title_terms: tuple[str, ...] = ()
    requested_count: int | None = None
    basis: str = (
        "Completed local calendar days. Dated by filename where present, "
        "otherwise Drive file dates."
    )

    def __post_init__(self) -> None:
        if (
            isinstance(self.relative_days, bool)
            or not 1 <= self.relative_days <= 31
            or isinstance(self.offset_days, bool)
            or not 0 <= self.offset_days <= 31
            or not re.fullmatch(r"[a-z0-9-]{2,50}", self.anchor)
            or not 1 <= len(self.title_terms) <= 3
            or self.title_terms[0] != self.anchor
            or any(not re.fullmatch(r"[a-z0-9-]{2,50}", term) for term in self.title_terms)
        ):
            raise ValueError("invalid long-range listing")

    def window(self, *, now_utc: datetime, timezone: str) -> tuple[date, date]:
        """Return N completed local calendar dates, inclusive, ending yesterday."""
        if now_utc.tzinfo is None or now_utc.utcoffset() is None:
            raise ValueError("current listing time must include a timezone")
        last = now_utc.astimezone(_zone(timezone)).date() - timedelta(days=self.offset_days + 1)
        return last - timedelta(days=self.relative_days - 1), last

    def window_description(self, *, now_utc: datetime, timezone: str) -> str:
        first, last = self.window(now_utc=now_utc, timezone=timezone)
        return (
            f"{first.isoformat()} through {last.isoformat()} ({_zone(timezone).key}). {self.basis}"
        )


def _zone(timezone: str) -> ZoneInfo:
    try:
        return ZoneInfo(timezone or "UTC")
    except (ValueError, ZoneInfoNotFoundError):
        return ZoneInfo("UTC")


def _subject_terms(title: str) -> tuple[str, ...] | None:
    words = ["standup" if word == "stand-up" else word for word in title.lower().split()]
    if any(word in _CONTENT_OR_VAGUE_WORDS for word in words):
        return None
    distinctive = tuple(dict.fromkeys(word for word in words if word not in _GENERIC_SUBJECT_WORDS))
    if (
        not 1 <= len(distinctive) <= 3
        or len(distinctive[0]) < 2
        or not any(len(word) >= 3 for word in distinctive)
    ):
        return None
    return distinctive


def parse_long_range_listing(message: str) -> LongRangeListing | None:
    """Recognize explicit all-files requests with a bounded, named subject.

    Requests about contents, unspecified files, other periods or other titles
    continue through the typed model planner and relevance selector.
    """
    if not isinstance(message, str):
        return None
    match = _PRIOR_UAT.fullmatch(message)
    offset_days = 0
    if match is not None:
        days = int(match["days"])
        if any(int(match[key]) != days for key in ("recent", "before", "then", "count")):
            return None
        offset_days = days
        count = days
    else:
        text = re.sub(r"[?.!]+\s*$", "", message.strip())
        text = _CHECK_DRIVE.sub("", text)
        count_match = _OPTIONAL_COUNT.search(text)
        count = int(count_match["count"]) if count_match else None
        if count_match:
            text = text[: count_match.start()]
        match = (
            _LISTING.fullmatch(text)
            or _LISTING_SUBJECT_FIRST.fullmatch(text)
            or _SHOW_MY_LISTING.fullmatch(text)
        )
        if match is None:
            match = _PRIOR_LISTING.fullmatch(text) or _PRIOR_LISTING_PREFIX.fullmatch(text)
            if match is not None:
                offset_days = int(match["previous"])
    if match is None:
        return None
    days = int(match["days"])
    if count is not None and count != days:
        return None
    title_terms = _subject_terms(match["title"])
    if title_terms is None:
        return None
    return LongRangeListing(
        relative_days=days,
        offset_days=offset_days,
        anchor=title_terms[0],
        title_terms=title_terms,
        requested_count=count,
    )


def _title_day(title: str) -> tuple[bool, date | None]:
    found = list(_TITLE_DATE.finditer(title))
    if not found:
        return False, None
    days: set[date] = set()
    for match in found:
        try:
            days.add(date(int(match["year"]), int(match["month"]), int(match["day"])))
        except ValueError:
            return True, None
    # A title with different dates does not identify one meeting day.
    return True, next(iter(days)) if len(days) == 1 else None


def _metadata_day(match: dict, *, zone: ZoneInfo) -> date | None:
    # Files "from" a day were made then. A modification alone cannot replace
    # a valid creation timestamp, even if it happens to fall in the window.
    value = match.get("created_time") or match.get("modified_time")
    if not isinstance(value, str):
        return None
    try:
        timestamp = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None
    if timestamp.tzinfo is None or timestamp.utcoffset() is None:
        return None
    return timestamp.astimezone(zone).date()


def _term_pattern(term: str) -> re.Pattern[str]:
    """Match a whole filename word with common singular/plural spelling."""
    if term == "standup":
        return re.compile(r"(?<!\w)stand[\s-]?ups?(?!\w)", re.IGNORECASE)
    if term.endswith("ies") and len(term) > 4:
        variants = (term, term[:-3] + "y")
    elif term.endswith(("xes", "ches", "shes", "sses", "zes")):
        variants = (term, term[:-2])
    elif term.endswith("s") and len(term) > 3 and not term.endswith("ss"):
        variants = (term, term[:-1])
    elif term.endswith(("x", "ch", "sh", "s", "z")):
        variants = (term, term + "es")
    else:
        variants = (term, term + "s")
    alternatives = "|".join(re.escape(value) for value in variants)
    return re.compile(rf"(?<!\w)(?:{alternatives})(?!\w)", re.IGNORECASE)


def filter_long_range_matches(
    spec: LongRangeListing,
    matches: list[dict],
    *,
    now_utc: datetime,
    timezone: str,
) -> list[dict]:
    """Keep title-matching, date-bounded candidates in newest-first order.

    A valid title date wins over Drive timestamps; an invalid or conflicting
    title date fails closed. Each result preserves provider-validated fields
    and adds ``listing_day`` for the owner's visible date label.
    """
    first, last = spec.window(now_utc=now_utc, timezone=timezone)
    zone = _zone(timezone)
    title_patterns = tuple(_term_pattern(term) for term in spec.title_terms)
    kept = []
    for match in matches:
        if not isinstance(match, dict):
            continue
        title = match.get("name")
        if (
            not isinstance(title, str)
            or not all(pattern.search(title) for pattern in title_patterns)
            or match.get("mime_type") == _FOLDER_MIME
        ):
            continue
        title_has_date, listing_day = _title_day(title)
        if not title_has_date:
            listing_day = _metadata_day(match, zone=zone)
        if listing_day is None or not first <= listing_day <= last:
            continue
        kept.append({**match, "listing_day": listing_day.isoformat()})
    # Python's sort is stable, so Drive order is preserved within a day.
    return sorted(kept, key=lambda item: item["listing_day"], reverse=True)


__all__ = ["LongRangeListing", "filter_long_range_matches", "parse_long_range_listing"]
