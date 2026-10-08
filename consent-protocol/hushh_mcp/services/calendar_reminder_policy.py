"""Pure Calendar reminder eligibility and preview policy; no provider authority."""

from __future__ import annotations

from datetime import UTC, datetime, timedelta
from typing import Any
from zoneinfo import ZoneInfo

REMINDER_OFFSET = timedelta(minutes=10)


def event_times(event: dict[str, Any]) -> tuple[datetime, datetime] | None:
    if event.get("status") == "cancelled" or event.get("eventType", "default") != "default":
        return None
    if any(
        a.get("self") and a.get("responseStatus") == "declined"
        for a in (event.get("attendees") or [])
        if isinstance(a, dict)
    ):
        return None
    try:
        start = datetime.fromisoformat(event["start"]["dateTime"].replace("Z", "+00:00"))
        end = datetime.fromisoformat(event["end"]["dateTime"].replace("Z", "+00:00"))
        if start.tzinfo is None or end.tzinfo is None or end <= start:
            return None
        return start.astimezone(UTC), end.astimezone(UTC)
    except (KeyError, TypeError, ValueError, AttributeError):
        return None


def reminder_copy(
    event: dict[str, Any], *, now: datetime, time_zone: str, show_title: bool
) -> tuple[str, str]:
    times = event_times(event)
    if times is None or times[0] <= now:
        raise ValueError("reminder_expired")
    start = times[0]
    minutes = max(1, int((start - now).total_seconds() + 59) // 60)
    # Provider text may be shown only under the saved preview choice, never logged.
    title = " ".join(str(event.get("summary") or "Calendar meeting").split())[:120]
    local = start.astimezone(ZoneInfo(time_zone))
    at = local.strftime("%I:%M %p").lstrip("0")
    return (
        title if show_title else "Upcoming meeting",
        f"Starts in {minutes} minutes · {at}. Open One to join.",
    )
