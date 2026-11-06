"""Calendar presentation from qualified instants and the current SDK turn clock."""

from datetime import UTC, datetime, timedelta
from typing import Any
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError


def turn_instant(context: Any) -> datetime | None:
    """The server admission instant, or the current SDK invocation's user event."""
    try:
        timestamp = context.state.get("temp:hussh:turn_started_at")
        if timestamp is None:
            timestamp = min(
                event.timestamp
                for event in context.session.events
                if event.invocation_id == context.invocation_id and event.author == "user"
            )
        return datetime.fromtimestamp(timestamp, UTC)
    except (AttributeError, TypeError, ValueError, OverflowError):
        return None


def turn_clock(context: Any) -> str:
    # An empty factory/evaluation context is not a user turn.
    if not getattr(context, "invocation_id", None):
        return ""
    zone_name = context.state.get("hussh:timezone")
    try:
        zone = ZoneInfo(zone_name)
        start = turn_instant(context)
        if start is None:
            raise ValueError("Missing user turn instant")
        now = start.astimezone(zone)
    except (AttributeError, TypeError, ValueError, ZoneInfoNotFoundError):
        return "\nCalendar date unknown: use get_current_time, never history.\n"
    return (
        f"\nToday={now.date().isoformat()}; tomorrow={(now + timedelta(days=1)).date().isoformat()} "
        f"[{zone.key}].\n"
    )


def local_read_result(result: dict[str, Any], time_zone: str) -> dict[str, Any]:
    zone = ZoneInfo(time_zone)

    def interval_projection(interval):
        local = {}
        for field in (
            "start_at",
            "end_at",
            "available_until",
            "time_min",
            "time_max",
            "range_start",
            "range_end",
            "start",
            "end",
        ):
            value = interval.get(field)
            if not isinstance(value, str):
                continue
            parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
            if parsed.tzinfo is None:
                raise ValueError("Calendar interval requires an offset")
            local[f"local_{field}"] = parsed.astimezone(zone).isoformat()
        return {**interval, **local}

    def event_projection(event):
        if not isinstance(event, dict):
            return event
        local = {}
        for field in ("start", "end"):
            value = event.get(field)
            if not isinstance(value, dict):
                continue
            if value.get("date"):
                local[f"local_{field}_date"] = value["date"]
            elif value.get("dateTime"):
                parsed = datetime.fromisoformat(value["dateTime"].replace("Z", "+00:00"))
                if parsed.tzinfo is None:
                    raise ValueError("Provider event time requires an offset")
                local[f"local_{field}_at"] = parsed.astimezone(zone).isoformat()
        return {**event, **local}

    projected = {**result, "display_time_zone": zone.key}
    if isinstance(result.get("events"), list):
        projected["events"] = [event_projection(event) for event in result["events"]]
    if isinstance(result.get("event"), dict):
        projected["event"] = event_projection(result["event"])
    if isinstance(result.get("openings"), list):
        projected["openings"] = [interval_projection(slot) for slot in result["openings"]]
    projected = interval_projection(projected)
    if isinstance(result.get("calendars"), dict):
        projected["calendars"] = {
            key: {**calendar, "busy": [interval_projection(b) for b in calendar["busy"]]}
            if isinstance(calendar, dict) and isinstance(calendar.get("busy"), list)
            else calendar
            for key, calendar in result["calendars"].items()
        }
    return projected
