"""Deterministic optional Calendar fields within the existing sealed proposal."""

from __future__ import annotations

from datetime import UTC, date, datetime, time, timedelta
from typing import Any
from zoneinfo import ZoneInfo

from hushh_mcp.services.google_connection_service import GoogleConnectionError

MAX_WEEKLY_OCCURRENCES = 52


def invalid(message: str) -> GoogleConnectionError:
    return GoogleConnectionError(message, status_code=422, reason_code="calendar_invalid_request")


def all_day_window(start_date: object, end_date: object, zone_name: str) -> dict[str, Any]:
    try:
        if not isinstance(start_date, str) or not isinstance(end_date, str):
            raise ValueError("Dates required")
        first, last = date.fromisoformat(start_date), date.fromisoformat(end_date)
        if first.isoformat() != start_date or last.isoformat() != end_date or last <= first:
            raise ValueError("Invalid civil dates")
        zone = ZoneInfo(zone_name)
        start = datetime.combine(first, time.min, zone)
        end = datetime.combine(last, time.min, zone)
        _qualified_civil(start)
        _qualified_civil(end)
    except (ValueError, TypeError) as exc:
        raise invalid("Choose exact all-day start and exclusive end dates.") from exc
    return {
        "all_day": True,
        "start_date": first.isoformat(),
        "end_date": last.isoformat(),
        "start_at": start.astimezone(UTC).isoformat(),
        "end_at": end.astimezone(UTC).isoformat(),
    }


def reminder_minutes(value: object) -> list[int]:
    if (
        not isinstance(value, list)
        or len(value) > 5
        or any(type(minutes) is not int or not 0 <= minutes <= 40320 for minutes in value)
    ):
        raise invalid("Choose up to five popup reminders, each 0–40320 minutes before the event.")
    return list(dict.fromkeys(value))


def popup_reminders(value: object) -> dict[str, Any]:
    return {
        "useDefault": False,
        "overrides": [
            {"method": "popup", "minutes": minutes} for minutes in reminder_minutes(value)
        ],
    }


def merge_reminders(current: object, additions: object) -> dict[str, Any]:
    if not isinstance(current, list) or any(
        not isinstance(item, dict)
        or item.get("method") not in {"email", "popup"}
        or type(item.get("minutes")) is not int
        or not 0 <= item["minutes"] <= 40320
        for item in current
    ):
        raise invalid("The current reminders could not be verified. Open the event again.")
    values = {
        (item["method"], item["minutes"]): {"method": item["method"], "minutes": item["minutes"]}
        for item in current
    }
    values.update(
        {
            ("popup", minutes): {"method": "popup", "minutes": minutes}
            for minutes in reminder_minutes(additions)
        }
    )
    if len(values) > 5:
        raise invalid(
            "This would exceed five reminders. Choose which existing reminder to replace."
        )
    return {"useDefault": False, "overrides": list(values.values())}


def weekly_options(payload: dict[str, Any], plan: dict[str, Any]) -> None:
    enabled = payload.get("repeat_weekly", False)
    if type(enabled) is not bool:
        raise invalid("Choose whether this event repeats weekly.")
    count, until = payload.get("repeat_count"), payload.get("repeat_until")
    if not enabled:
        if count is not None or until is not None:
            raise invalid("Choose weekly recurrence before supplying its limit.")
        return
    if plan.get("booking_source") == "board" or any(
        key in plan for key in ("opening_selection", "shared_opening_selection")
    ):
        raise invalid(
            "A selected free slot reviews one meeting only. Give exact times for a weekly series."
        )
    if (count is None) == (until is None):
        raise invalid(
            "How many weekly occurrences, or through which date, should this event repeat?"
        )
    zone = ZoneInfo(plan["time_zone"])
    first = datetime.fromisoformat(plan["start_at"].replace("Z", "+00:00")).astimezone(zone)
    if until is not None:
        try:
            final_date = date.fromisoformat(until) if isinstance(until, str) else None
            if final_date is None or final_date.isoformat() != until or final_date < first.date():
                raise ValueError("Invalid last date")
        except (ValueError, TypeError) as exc:
            raise invalid(
                "Choose an exact recurrence end date on or after the first event."
            ) from exc
        count = (final_date - first.date()).days // 7 + 1
    if type(count) is not int or not 1 <= count <= MAX_WEEKLY_OCCURRENCES:
        raise invalid("Review a weekly series of 1–52 occurrences at a time.")
    plan["weekly_recurrence"] = {"count": count, "until_date": until}
    plan["recurrence"] = [f"RRULE:FREQ=WEEKLY;COUNT={count}"]
    windows = occurrence_windows(plan)
    plan["recurrence_last_date"] = windows[-1][0].astimezone(zone).date().isoformat()


def _qualified_civil(value: datetime) -> None:
    # Google expands recurrence in its IANA zone. Refuse skipped/ambiguous civil
    # times rather than silently shifting them across a clock change.
    if (
        value.astimezone(UTC).astimezone(value.tzinfo).replace(tzinfo=None)
        != value.replace(tzinfo=None)
        or value.replace(fold=0).utcoffset() != value.replace(fold=1).utcoffset()
    ):
        raise invalid(
            "This time crosses an ambiguous or skipped clock change. Choose another time."
        )


def occurrence_windows(plan: dict[str, Any]) -> list[tuple[datetime, datetime]]:
    start, end = (
        datetime.fromisoformat(plan[key].replace("Z", "+00:00")) for key in ("start_at", "end_at")
    )
    recurrence = plan.get("weekly_recurrence")
    if not recurrence:
        return [(start, end)]
    count = recurrence["count"]
    if type(count) is not int or not 1 <= count <= MAX_WEEKLY_OCCURRENCES:
        raise invalid("The weekly review needs a valid occurrence count.")
    zone = ZoneInfo(
        plan.get("calendar_time_zone", plan["time_zone"])
        if plan.get("all_day")
        else plan["time_zone"]
    )
    local = start.astimezone(zone)
    days = (
        (date.fromisoformat(plan["end_date"]) - date.fromisoformat(plan["start_date"])).days
        if plan.get("all_day")
        else 0
    )
    windows = []
    for index in range(count):
        left = local + timedelta(weeks=index)
        _qualified_civil(left)
        right = left + timedelta(days=days) if days else left.astimezone(UTC) + (end - start)
        if days:
            _qualified_civil(right)
        windows.append((left.astimezone(UTC), right.astimezone(UTC)))
    return windows


def conflict_window(plan: dict[str, Any]) -> tuple[str, str]:
    windows = occurrence_windows(plan)
    return windows[0][0].isoformat(), windows[-1][1].isoformat()


def series_conflicts(plan: dict[str, Any], events: list[dict[str, Any]]) -> list[dict[str, Any]]:
    if not plan.get("weekly_recurrence"):
        return events
    windows = occurrence_windows(plan)

    def boundary(value: object, calendar_zone: object) -> datetime:
        if not isinstance(value, dict):
            raise ValueError("Missing provider time")
        if value.get("dateTime"):
            parsed = datetime.fromisoformat(value["dateTime"].replace("Z", "+00:00"))
            if parsed.tzinfo is None:
                raise ValueError("Unqualified provider time")
            return parsed
        if not isinstance(calendar_zone, str) or not calendar_zone:
            raise ValueError("Missing source calendar zone")
        return datetime.combine(
            date.fromisoformat(value["date"]), time.min, ZoneInfo(calendar_zone)
        )

    matching = []
    try:
        for event in events:
            source_zone = event.get("calendar_time_zone")
            start, end = (
                boundary(event.get("start"), source_zone),
                boundary(event.get("end"), source_zone),
            )
            if any(start < right and end > left for left, right in windows):
                matching.append(event)
    except (ValueError, KeyError, TypeError) as exc:
        raise GoogleConnectionError(
            "Calendar conflict timing could not be verified.",
            status_code=502,
            reason_code="calendar_invalid_response",
        ) from exc
    return matching
