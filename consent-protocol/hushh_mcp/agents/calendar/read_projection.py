"""Calendar presentation from qualified instants and the current SDK turn clock."""

from datetime import UTC, datetime, timedelta
from typing import Any
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError


def turn_clock(context: Any) -> str:
    zone_name = context.state.get("hussh:timezone")
    try:
        zone = ZoneInfo(zone_name)
        timestamps = [
            event.timestamp
            for event in context.session.events
            if event.invocation_id == context.invocation_id and event.author == "user"
        ]
        timestamp = context.state.get("temp:hussh:turn_started_at")
        now = datetime.fromtimestamp(
            timestamp if timestamp is not None else min(timestamps), UTC
        ).astimezone(zone)
    except (AttributeError, TypeError, ValueError, ZoneInfoNotFoundError):
        return "\nCALENDAR CLOCK: For relative dates, call get_current_time; do not use chat history.\n"
    return (
        f"\nCALENDAR CLOCK for this user turn: {now.isoformat()} [{zone.key}]. "
        f"Today={now.date().isoformat()}; tomorrow={(now + timedelta(days=1)).date().isoformat()}. "
        "Resolve relative dates from this turn, never earlier messages. Preserve explicit dates. "
        "Use Calendar read services for meetings and availability; never prepare a proposal "
        "as a read or conflict-check workaround. Summarize local_start_at/local_end_at in "
        "display_time_zone, preserving their dates. Coverage and suggestion limits are separate.\n"
    )


def local_read_result(result: dict[str, Any], time_zone: str) -> dict[str, Any]:
    zone = ZoneInfo(time_zone)

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
        projected["openings"] = [
            {
                **slot,
                **{
                    f"local_{field}": datetime.fromisoformat(slot[field].replace("Z", "+00:00"))
                    .astimezone(zone)
                    .isoformat()
                    for field in ("start_at", "end_at")
                },
            }
            for slot in result["openings"]
        ]
    return projected
