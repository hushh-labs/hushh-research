"""Owner-bound three-account Calendar board assembled from live schedule reads."""

from __future__ import annotations

import asyncio
from datetime import UTC, datetime
from typing import Any

from hushh_mcp.services.calendar_invitations import event_bounds, occurrence_key
from hushh_mcp.services.calendar_schedule_service import CalendarScheduleService
from hushh_mcp.services.google_calendar_service import GoogleCalendarService
from hushh_mcp.services.google_connection_service import (
    GoogleConnectionError,
    GoogleConnectionService,
    get_google_connection_service,
)


def account_schedule(
    account_id: str, connections: GoogleConnectionService | None = None
) -> CalendarScheduleService:
    owner = connections or get_google_connection_service()
    return CalendarScheduleService(
        calendar=GoogleCalendarService(
            db=owner.db, connections=owner.for_calendar_account(account_id)
        ),
        db=owner.db,
    )


def _window_intersection(
    left: list[dict[str, Any]], right: list[dict[str, Any]]
) -> list[dict[str, str]]:
    """Intersect sorted half-open UTC free intervals without inventing a slot."""
    result: list[dict[str, str]] = []
    i = j = 0
    while i < len(left) and j < len(right):
        start = max(left[i]["start_at"], right[j]["start_at"])
        end = min(left[i]["end_at"], right[j]["end_at"])
        if start < end:
            result.append({"start_at": start, "end_at": end})
        if left[i]["end_at"] <= right[j]["end_at"]:
            i += 1
        else:
            j += 1
    return result


def _shared_free_windows(
    accounts: list[dict[str, Any]], duration_minutes: int
) -> list[dict[str, Any]]:
    shared = accounts[0]["free_windows"]
    for account in accounts[1:]:
        shared = _window_intersection(shared, account["free_windows"])
    return [
        window
        for window in shared
        if (
            datetime.fromisoformat(window["end_at"]) - datetime.fromisoformat(window["start_at"])
        ).total_seconds()
        >= duration_minutes * 60
    ]


def _event_is_busy(event: dict[str, Any], account_email: str) -> bool:
    if event.get("status") == "cancelled" or event.get("transparency") == "transparent":
        return False
    for attendee in event.get("attendees") or []:
        if str(attendee.get("email") or "").casefold() == account_email.casefold():
            return attendee.get("response_status") != "declined"
    return True


def _same_meeting(a: dict[str, Any], b: dict[str, Any], zone: str) -> bool:
    uid_a, uid_b = a.get("ical_uid"), b.get("ical_uid")
    return bool(
        uid_a
        and uid_a == uid_b
        and occurrence_key(a) == occurrence_key(b)
        and event_bounds(a, zone) == event_bounds(b, zone)
    )


def _conflicts(accounts: list[dict[str, Any]], zone: str) -> list[dict[str, Any]]:
    intervals = []
    for account in accounts:
        if account["status"] != "complete":
            continue
        for event in account["events"]:
            if not _event_is_busy(event, account["google_email"]):
                continue
            try:
                start, end = event_bounds(event, zone)
            except (KeyError, TypeError, ValueError):
                continue
            intervals.append((start, end, event))
    intervals.sort(key=lambda item: (item[0], item[1]))
    active: list[tuple[datetime, datetime, dict[str, Any]]] = []
    pairs = []
    for start, end, event in intervals:
        active = [item for item in active if item[1] > start]
        for other_start, other_end, other in active:
            if other["account_id"] == event["account_id"] or _same_meeting(other, event, zone):
                continue
            pairs.append(
                {
                    "left": {
                        "account_id": other["account_id"],
                        "calendar_id": other["calendar_id"],
                        "event_id": other["id"],
                    },
                    "right": {
                        "account_id": event["account_id"],
                        "calendar_id": event["calendar_id"],
                        "event_id": event["id"],
                    },
                    "start_at": max(other_start, start).isoformat(),
                    "end_at": min(other_end, end).isoformat(),
                }
            )
        active.append((start, end, event))
    return pairs


class CalendarAccountBoardService:
    def __init__(self, connections: GoogleConnectionService | None = None) -> None:
        self.connections = connections or get_google_connection_service()

    async def day(
        self,
        *,
        user_id: str,
        date: str,
        time_zone: str,
        duration_minutes: int = 30,
        calendar_overrides_by_account: dict[str, dict[str, bool]] | None = None,
    ) -> dict[str, Any]:
        if duration_minutes not in (15, 30, 60):
            raise GoogleConnectionError("Choose 15, 30 or 60 minutes", status_code=422)
        status = await self.connections.calendar_accounts_status(user_id=user_id)
        identities = status["accounts"]
        if not identities:
            raise GoogleConnectionError(
                "Connect Calendar first", status_code=403, reason_code="calendar_not_connected"
            )
        overrides = calendar_overrides_by_account or {}
        if set(overrides) - {item["account_id"] for item in identities}:
            raise GoogleConnectionError(
                "Calendar account selection changed. Refresh the board.", status_code=409
            )

        async def load(identity: dict[str, Any]) -> dict[str, Any]:
            base = {
                "account_id": identity["account_id"],
                "google_email": identity["google_email"],
                "connection_status": identity["status"],
            }
            if not identity["connected"]:
                return {
                    **base,
                    "status": "needs_reauth",
                    "events": [],
                    "free_windows": [],
                    "unreadable_calendars": [],
                    "error": "Reconnect this Calendar account.",
                }
            schedule = account_schedule(identity["account_id"], self.connections)
            try:
                binding = await schedule._read_binding(user_id)
                day, availability = await asyncio.gather(
                    schedule.today(
                        user_id=user_id,
                        date=date,
                        time_zone=time_zone,
                        include_hidden_invitations=True,
                    ),
                    schedule.free_windows(
                        user_id=user_id,
                        date=date,
                        time_zone=time_zone,
                        duration_minutes=duration_minutes,
                        max_windows=None,
                        calendar_overrides=overrides.get(identity["account_id"]),
                    ),
                )
                if binding != await schedule._read_binding(user_id):
                    raise GoogleConnectionError(
                        "Calendar account changed during the check", status_code=409
                    )
                return {
                    **base,
                    "status": "complete",
                    "events": [
                        {
                            **event,
                            "account_id": identity["account_id"],
                            "account_email": identity["google_email"],
                        }
                        for event in day["events"]
                    ],
                    "calendars": day["calendars"],
                    "calendar_options": availability["calendar_options"],
                    "unreadable_calendars": day["unreadable_calendars"],
                    "free_windows": availability["windows"],
                    "checked_at": datetime.now(UTC).isoformat(),
                }
            except GoogleConnectionError as exc:
                return {
                    **base,
                    "status": "incomplete",
                    "events": [],
                    "free_windows": [],
                    "unreadable_calendars": [],
                    "error": str(exc),
                    "reason_code": exc.reason_code,
                }

        accounts = await asyncio.gather(*(load(identity) for identity in identities))
        latest = await self.connections.calendar_accounts_status(user_id=user_id)
        if [
            (item["account_id"], item["google_email"], item["status"])
            for item in latest["accounts"]
        ] != [(item["account_id"], item["google_email"], item["status"]) for item in identities]:
            raise GoogleConnectionError(
                "Calendar account list changed. Refresh the board.", status_code=409
            )
        for account, identity in zip(accounts, latest["accounts"], strict=True):
            account["profile_photo_url"] = identity.get("profile_photo_url")
        complete = all(account["status"] == "complete" for account in accounts)
        shared = _shared_free_windows(accounts, duration_minutes) if complete else []
        conflicts_complete = complete and not any(
            account["unreadable_calendars"] for account in accounts
        )
        return {
            "date": date,
            "time_zone": time_zone,
            "duration_minutes": duration_minutes,
            "accounts": accounts,
            "complete": complete,
            "conflicts_complete": conflicts_complete,
            "conflicts": _conflicts(accounts, time_zone),
            "shared_free_windows": shared,
            "checked_at": datetime.now(UTC).isoformat(),
        }
