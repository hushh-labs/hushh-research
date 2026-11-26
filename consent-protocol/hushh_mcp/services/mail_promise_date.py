"""Normalize an evidenced promise into the civil date/time fields of a shared Task."""

from __future__ import annotations

import re
from datetime import date, datetime
from email.utils import parsedate_to_datetime


def promise_deadline(
    wording: str | None, received_at: str, date_header: str
) -> tuple[str | None, str | None]:
    if not wording:
        return None, None
    value = re.sub(r"^(?:(?:by|on)\s+)?(?:the\s+)?", "", wording.strip(), flags=re.I)
    day_text, _, clock = value.lower().partition(" at ")
    day_text = re.sub(r"(?<=\d)(?:st|nd|rd|th)\b", "", day_text)
    day = None
    for fmt in ("%Y-%m-%d", "%d %B %Y", "%d %b %Y", "%B %d, %Y", "%b %d, %Y"):
        try:
            day = datetime.strptime(day_text, fmt).date()
            break
        except ValueError:
            continue
    if day is None:
        try:
            instant = datetime.fromisoformat(received_at)
            if instant.tzinfo is None:
                return None, None
            if date_header:
                zone = parsedate_to_datetime(date_header).tzinfo
                if zone is None:
                    return None, None
                instant = instant.astimezone(zone)
            if re.fullmatch(r"\d{1,2}", day_text):
                day = date(instant.year, instant.month, int(day_text))
            else:
                for fmt in ("%d %B %Y", "%d %b %Y", "%B %d %Y", "%b %d %Y"):
                    try:
                        day = datetime.strptime(f"{day_text} {instant.year}", fmt).date()
                        break
                    except ValueError:
                        continue
            if day is None or day < instant.date():
                return None, None
        except (ValueError, TypeError, OverflowError):
            return None, None
    for fmt in ("%H:%M", "%I:%M %p", "%I %p", "%I%p"):
        try:
            return day.isoformat(), datetime.strptime(clock, fmt).strftime("%H:%M")
        except ValueError:
            continue
    return day.isoformat(), None
