"""Owner invitation reads and overlap evidence; no mutation or persistence authority."""

from __future__ import annotations

import asyncio
from datetime import UTC, datetime, timedelta
from zoneinfo import ZoneInfo

from hushh_mcp.services.google_connection_service import GoogleConnectionError

RESPONSES = frozenset({"needsAction", "accepted", "declined", "tentative"})
READABLE_ROLES = frozenset({"reader", "writer", "owner", "writerWithoutPrivateAccess"})


def attendee_status(event, email, *, raw=False):
    """(attendee, None) or (None, closed reason): why this email is not one attendee.

    Google's `self` identifies the source calendar, not necessarily this person,
    so only the verified email is matched.
    """
    organizer = event.get("organizer") or {}
    if not email:
        return None, "requester_not_listed"
    if str(organizer.get("email") or "").casefold() == email.casefold():
        return None, "requester_is_organizer"
    if event.get("status") == "cancelled":
        return None, "event_cancelled"
    if event.get("attendeesOmitted" if raw else "attendees_omitted"):
        return None, "attendees_omitted"
    matches = [
        a
        for a in event.get("attendees", [])
        if isinstance(a, dict)
        and str(a.get("email") or "").casefold() == email.casefold()
        and not a.get("organizer")
    ]
    if not matches:
        return None, "requester_not_listed"
    if len(matches) > 1:
        return None, "duplicate_attendee"
    return matches[0], None


def own_attendee(event, email, *, raw=False):
    """The one matching attendee entry, or None; see ``attendee_status`` for why not."""
    return attendee_status(event, email, raw=raw)[0]


def event_bounds(event, zone="UTC"):
    zone = event.get("source_time_zone") or zone

    def instant(value):
        if not isinstance(value, dict):
            raise ValueError("Missing event time")
        if value.get("dateTime"):
            parsed = datetime.fromisoformat(value["dateTime"].replace("Z", "+00:00"))
            if parsed.tzinfo is None:
                raise ValueError("Missing time zone")
            return parsed.astimezone(UTC)
        return datetime.fromisoformat(value["date"]).replace(tzinfo=ZoneInfo(zone)).astimezone(UTC)

    return instant(event.get("start")), instant(event.get("end"))


def occurrence_key(event):
    # A single event's UID is shared by its copies. Recurring instances add a
    # canonical original-start instant, not provider dictionary formatting.
    uid = event.get("ical_uid")
    if not uid:
        return (event.get("calendar_id"), event.get("id")), ""
    original = event.get("original_start_time")
    if not original:
        return uid, "single"
    if original.get("dateTime"):
        instant = datetime.fromisoformat(original["dateTime"].replace("Z", "+00:00"))
        if instant.tzinfo is None:
            raise ValueError("Recurring instance has no original time zone")
        return uid, instant.astimezone(UTC).isoformat()
    return uid, original.get("date")


def conflicts_for(event, events, email, zone):
    start, end = event_bounds(event, zone)
    conflicts, seen = [], set()
    for other in events:
        identity = occurrence_key(other)
        if (
            identity == occurrence_key(event)
            or identity in seen
            or other.get("transparency") == "transparent"
        ):
            continue
        if other.get("calendar_id") == event.get("calendar_id") and other.get("id") == event.get(
            "id"
        ):
            continue
        attendee = own_attendee(other, email)
        if attendee and attendee.get("response_status") == "declined":
            continue
        left, right = event_bounds(other, zone)
        if start < right and end > left:
            seen.add(identity)
            conflicts.append(
                {key: other.get(key) for key in ("calendar_id", "id", "title", "start", "end")}
            )
    return conflicts


async def invitation_snapshot(
    schedule,
    *,
    user_id,
    start_at=None,
    end_at=None,
    time_zone="UTC",
    binding=None,
    selected_calendar_id=None,
    selected_event_id=None,
):
    """Read every page in a bounded upcoming window across the subscribed inventory.

    Fail closed on incomplete readable calendars. Free/busy-only calendars are
    explicitly reported, so a partial check cannot be described as conflict-free.
    """
    try:
        ZoneInfo(time_zone)
        start = (
            datetime.fromisoformat(start_at.replace("Z", "+00:00"))
            if start_at
            else datetime.now(UTC)
        )
        end = (
            datetime.fromisoformat(end_at.replace("Z", "+00:00"))
            if end_at
            else start + timedelta(days=90)
        )
        if (
            start.tzinfo is None
            or end.tzinfo is None
            or not timedelta() < end - start <= timedelta(days=93)
        ):
            raise ValueError()
    except (ValueError, KeyError) as exc:
        raise GoogleConnectionError(
            "Choose an invitation window of up to 93 days and a valid time zone.", status_code=422
        ) from exc
    binding = binding or await schedule._read_binding(user_id)
    status = await schedule.calendar.connections.status(user_id=user_id, service="calendar")
    email = status.get("google_email") or ""
    if not email:
        raise GoogleConnectionError("Reconnect Calendar to verify your account.", status_code=401)
    calendars = await schedule._included_calendars(user_id, binding=binding)
    unreadable = [c for c in calendars if c.get("access_role") not in READABLE_ROLES]
    semaphore = asyncio.Semaphore(4)

    async def load(source):
        async with semaphore:
            calendar_id = "primary" if source.get("primary") else source["id"]
            events, page, seen = [], None, set()
            for _ in range(10):
                result = await schedule.calendar.list_events(
                    user_id=user_id,
                    calendar_id=calendar_id,
                    start_at=start.isoformat(),
                    end_at=end.isoformat(),
                    max_results=250,
                    page_token=page,
                    expected_binding=binding,
                    include_hidden_invitations=True,
                )
                await schedule.calendar._check_read_binding(user_id, binding)
                for event in result["events"]:
                    if event.get("status") == "cancelled":
                        continue
                    if not event.get("id") or event.get("recurrence_master"):
                        raise GoogleConnectionError(
                            "Invitation instances could not be verified.", status_code=502
                        )
                    try:
                        left, right = event_bounds(event, source.get("time_zone") or time_zone)
                        if right <= left:
                            raise ValueError()
                    except (ValueError, KeyError, TypeError) as exc:
                        raise GoogleConnectionError(
                            "Invitation times could not be verified.", status_code=502
                        ) from exc
                    if right <= start or left >= end:
                        continue
                    events.append(
                        {
                            **event,
                            "calendar_id": calendar_id,
                            "calendar_name": source.get("name"),
                            "access_role": source.get("access_role"),
                            "source_calendar_id": source["id"],
                            "source_time_zone": source.get("time_zone") or time_zone,
                        }
                    )
                page = result.get("next_page_token")
                if not page and not result.get("truncated"):
                    return events
                if not page or page in seen:
                    break
                seen.add(page)
            raise GoogleConnectionError(
                "Too many invitations to fully check. Choose a shorter window.", status_code=422
            )

    tasks = [
        asyncio.create_task(load(c)) for c in calendars if c.get("access_role") in READABLE_ROLES
    ]
    try:
        groups = await asyncio.gather(*tasks)
    finally:
        for task in tasks:
            if not task.done():
                task.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)
    events = [event for group in groups for event in group]
    invitations = {}
    # Prefer the owner's primary copy while preserving the chosen source ID.
    for event in sorted(
        events,
        key=lambda e: (
            not (selected_calendar_id == e["calendar_id"] and selected_event_id == e["id"]),
            e["calendar_id"] != "primary",
        ),
    ):
        attendee = own_attendee(event, email)
        if not attendee or attendee.get("response_status") not in RESPONSES:
            continue
        item = {
            **event,
            "response_status": attendee["response_status"],
            "can_respond": event["access_role"]
            in {"owner", "writer", "writerWithoutPrivateAccess"},
            "attendees": [
                {**a, "self": str(a.get("email") or "").casefold() == email.casefold()}
                for a in event.get("attendees", [])
            ],
        }
        item["conflicts"] = conflicts_for(item, events, email, time_zone)
        invitations.setdefault(occurrence_key(item), item)
    ordered = sorted(invitations.values(), key=lambda e: event_bounds(e, time_zone)[0])
    await schedule.calendar._check_read_binding(user_id, binding)
    return {
        "events": ordered,
        "account_email": email,
        "pending_count": sum(e["response_status"] == "needsAction" for e in ordered),
        "time_zone": time_zone,
        "start_at": start.isoformat(),
        "end_at": end.isoformat(),
        "unreadable_calendars": unreadable,
        "calendars": calendars,
        "complete": not unreadable,
    }
