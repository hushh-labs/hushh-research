"""Confirmation-bound Calendar booking helpers for the existing service."""

from __future__ import annotations

import secrets
from datetime import UTC, date, datetime, timedelta
from typing import TYPE_CHECKING, Any
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from hushh_mcp.services.calendar_time_zone import normalize_time_zone
from hushh_mcp.services.google_connection_service import (
    CALENDAR_LIST_READ_SCOPE,
    GoogleConnectionError,
)

if TYPE_CHECKING:
    from hushh_mcp.services.google_calendar_service import GoogleCalendarService


def _account_status_error(message: str) -> GoogleConnectionError:
    return GoogleConnectionError(message, status_code=409, reason_code="calendar_accounts_changed")


async def board_booking_state(
    calendar: GoogleCalendarService, *, user_id: str, plan: dict[str, Any]
) -> list[dict[str, Any]]:
    """Seal and recheck the exact connected-account selection behind a Board opening."""

    owner = getattr(calendar.connections, "owner", calendar.connections)
    status_reader = getattr(owner, "calendar_accounts_status", None)
    if not callable(status_reader):
        raise GoogleConnectionError("Calendar account review is unavailable", status_code=503)
    status = await status_reader(user_id=user_id)
    accounts = status.get("accounts")
    checked = plan.get("checked_account_ids")
    if (
        not isinstance(accounts, list)
        or not 1 <= len(accounts) <= 3
        or not isinstance(checked, list)
        or len(checked) != len(accounts)
        or len(set(checked)) != len(checked)
        or set(checked) != {item.get("account_id") for item in accounts if isinstance(item, dict)}
        or plan.get("account_id") not in checked
        or any(not isinstance(item, dict) or not item.get("connected") for item in accounts)
    ):
        raise _account_status_error(
            "Calendar accounts changed. Refresh Free time and review again."
        )
    overrides = plan.get("calendar_overrides_by_account") or {}
    if not isinstance(overrides, dict) or set(overrides) - set(checked):
        raise GoogleConnectionError("Calendar selection changed", status_code=409)
    start = datetime.fromisoformat(plan["start_at"].replace("Z", "+00:00"))
    end = datetime.fromisoformat(plan["end_at"].replace("Z", "+00:00"))
    snapshots: list[dict[str, Any]] = []
    conflicts: list[dict[str, Any]] = []
    for account in accounts:
        snapshot, busy = await _account_snapshot(
            calendar,
            owner=owner,
            user_id=user_id,
            plan=plan,
            account=account,
            override=overrides.get(account["account_id"]),
            start=start,
            end=end,
        )
        snapshots.append(snapshot)
        conflicts.extend(busy)
    await _verify_board_snapshot(
        owner=owner,
        user_id=user_id,
        status_reader=status_reader,
        accounts=accounts,
        snapshots=snapshots,
        reviewed=plan.get("board_accounts"),
    )
    plan["board_accounts"] = snapshots
    return conflicts


async def _account_snapshot(
    calendar: GoogleCalendarService,
    *,
    owner: Any,
    user_id: str,
    plan: dict[str, Any],
    account: dict[str, Any],
    override: Any,
    start: datetime,
    end: datetime,
) -> tuple[dict[str, Any], list[dict[str, Any]]]:
    from hushh_mcp.services.calendar_account_board_service import account_schedule

    account_id = account["account_id"]
    schedule = account_schedule(account_id, owner)
    binding = await schedule._read_binding(user_id)
    inventory = await schedule._included_calendars(user_id, binding=binding)
    selected, _options = schedule._availability_selection(inventory, override)
    calendar_ids = [item["id"] for item in selected]
    if account_id == plan["account_id"]:
        primary = next((item for item in inventory if item.get("primary") is True), None)
        if primary is None or primary.get("access_role") not in {
            "owner",
            "writer",
            "writerWithoutPrivateAccess",
        }:
            raise GoogleConnectionError(
                "Choose a writable primary calendar for this account",
                status_code=403,
                reason_code="calendar_destination_read_only",
            )
        await schedule.calendar.connections.access_token(
            user_id=user_id, service="calendar", access_level="manage"
        )
    busy = await schedule._busy_intervals(
        user_id=user_id,
        start=start,
        end=end,
        calendar_ids=calendar_ids,
        binding=binding,
    )
    await schedule.calendar._check_read_binding(user_id, binding)
    snapshot = {
        "account_id": account_id,
        "account_email": account["google_email"],
        "binding": list(binding),
        "calendar_ids": calendar_ids,
    }
    conflicts = [
        {
            "account_id": account_id,
            "account_email": account["google_email"],
            "start_at": calendar._utc_iso(left),
            "end_at": calendar._utc_iso(right),
        }
        for left, right in busy
    ]
    return snapshot, conflicts


async def _verify_board_snapshot(
    *,
    owner: Any,
    user_id: str,
    status_reader: Any,
    accounts: list[dict[str, Any]],
    snapshots: list[dict[str, Any]],
    reviewed: Any,
) -> None:
    from hushh_mcp.services.calendar_account_board_service import account_schedule

    latest = await status_reader(user_id=user_id)
    if [
        (item.get("account_id"), item.get("google_email"), item.get("status"))
        for item in latest.get("accounts", [])
    ] != [
        (item.get("account_id"), item.get("google_email"), item.get("status")) for item in accounts
    ]:
        raise _account_status_error("Calendar accounts changed. Review the time again.")
    for item in snapshots:
        current = await account_schedule(item["account_id"], owner)._read_binding(user_id)
        if tuple(item["binding"]) != current:
            raise _account_status_error("Calendar account changed. Review the time again.")
    if reviewed is not None and snapshots != reviewed:
        raise GoogleConnectionError(
            "Calendar account or selection changed. Review the time again.",
            status_code=409,
            reason_code="calendar_selection_changed",
        )


def validate_plan(
    calendar: GoogleCalendarService, *, action: str, payload: dict[str, Any]
) -> dict[str, Any]:
    event_id = str(payload.get("event_id") or "").strip()
    title = str(payload.get("title") or "").strip()
    if action in {"reschedule", "cancel"} and not event_id:
        raise GoogleConnectionError("Calendar event id is required", status_code=422)
    if action == "cancel":
        return {"event_id": event_id, "send_updates": bool(payload.get("send_updates", True))}
    if (action == "create" and not title) or len(title) > 512:
        raise GoogleConnectionError("Calendar event title is required", status_code=422)
    start = calendar._iso(str(payload.get("start_at") or ""))
    end = calendar._iso(str(payload.get("end_at") or ""))
    if start >= end:
        raise GoogleConnectionError("Calendar end must be after start", status_code=422)
    booking_source = payload.get("booking_source")
    account_id = str(payload.get("account_id") or "default")
    provided_zone = str(payload.get("time_zone") or "")
    # A board booking must name its zone; other callers default to UTC. Either
    # way a zone that is not in the tz database is refused before anything is
    # stored or sent, so no booking can silently fall back to the wrong clock.
    board_zone = normalize_time_zone(
        provided_zone, default="" if booking_source == "board" else "UTC"
    )
    if booking_source == "board":
        validate_board_request(
            action=action,
            payload=payload,
            account_id=account_id,
            start=start,
            end=end,
            board_zone=board_zone,
        )
    raw_attendees = payload.get("attendees")
    attendees = [
        str(item).strip().lower()
        for item in (raw_attendees if isinstance(raw_attendees, list) else [])
        if str(item).strip()
    ]
    if len(attendees) > 100 or any("@" not in item for item in attendees):
        raise GoogleConnectionError(
            "Calendar attendees must be valid email addresses", status_code=422
        )
    description = str(payload.get("description") or "")[:8000]
    location = str(payload.get("location") or "")[:1024]
    plan: dict[str, Any] = {
        "event_id": event_id or None,
        "start_at": start,
        "end_at": end,
        "time_zone": board_zone,
        "send_updates": bool(payload.get("send_updates", True)),
    }
    if action == "create":
        meeting_type = str(payload.get("meeting_type") or "google_meet")
        meeting_link = str(payload.get("meeting_link") or "").strip()
        if booking_source == "board":
            validate_meeting_place(meeting_type, meeting_link, location)
        plan.update(
            {
                "title": title,
                "attendees": attendees,
                "description": description,
                "location": meeting_link
                if booking_source == "board" and meeting_type == "external_link"
                else location,
                "conference_request_id": f"meet_{secrets.token_urlsafe(18)}",
            }
        )
        if booking_source == "board":
            plan.update(board_create_fields(payload, account_id, meeting_type, meeting_link))
        return plan
    changes = {"title": title, "description": description, "location": location}
    plan.update({key: value for key, value in changes.items() if value})
    if attendees:
        plan["attendees"] = list(dict.fromkeys(attendees))
    return plan


def validate_board_request(
    *,
    action: str,
    payload: dict[str, Any],
    account_id: str,
    start: str,
    end: str,
    board_zone: str,
) -> None:
    if action != "create":
        raise GoogleConnectionError("Board booking must create one event", status_code=422)
    start_at = datetime.fromisoformat(start.replace("Z", "+00:00"))
    end_at = datetime.fromisoformat(end.replace("Z", "+00:00"))
    if start_at <= datetime.now(UTC):
        raise GoogleConnectionError("Choose a future time before reviewing", status_code=422)
    if end_at - start_at not in {
        timedelta(minutes=15),
        timedelta(minutes=30),
        timedelta(minutes=60),
    }:
        raise GoogleConnectionError("Choose a 15, 30 or 60 minute meeting", status_code=422)
    try:
        zone = ZoneInfo(board_zone)
        selected_date = date.fromisoformat(str(payload.get("selected_date") or ""))
        if start_at.astimezone(zone).date() != selected_date:
            raise ValueError("Selected date does not match the meeting time")
    except (ValueError, ZoneInfoNotFoundError) as exc:
        raise GoogleConnectionError("Choose a valid date and time zone", status_code=422) from exc
    checked = payload.get("checked_account_ids")
    if not isinstance(checked, list) or not 1 <= len(checked) <= 3 or account_id not in checked:
        raise GoogleConnectionError("Refresh Calendar accounts before reviewing", status_code=409)


def validate_meeting_place(meeting_type: str, meeting_link: str, location: str) -> None:
    from hushh_mcp.services.google_calendar_service import _meeting_link

    if meeting_type not in {"google_meet", "external_link", "in_person"}:
        raise GoogleConnectionError("Choose a meeting place", status_code=422)
    if meeting_type == "external_link" and not _meeting_link(meeting_link):
        raise GoogleConnectionError("Choose a valid existing meeting link", status_code=422)
    if meeting_type == "in_person" and not location.strip():
        raise GoogleConnectionError("Enter an in-person location", status_code=422)
    if meeting_type != "external_link" and meeting_link:
        raise GoogleConnectionError("Remove the unused meeting link", status_code=422)


def board_create_fields(
    payload: dict[str, Any], account_id: str, meeting_type: str, meeting_link: str
) -> dict[str, Any]:
    return {
        "account_id": account_id,
        "booking_source": "board",
        "checked_account_ids": payload["checked_account_ids"],
        "calendar_overrides_by_account": payload.get("calendar_overrides_by_account") or {},
        "selected_date": str(payload["selected_date"]),
        "meeting_type": meeting_type,
        "meeting_link": meeting_link,
    }


async def prepare_proposal_account(
    calendar: GoogleCalendarService,
    *,
    user_id: str,
    plan: dict[str, Any],
    binding: tuple[str, ...],
) -> None:
    if plan.get("account_id", "default") != getattr(calendar.connections, "account_id", "default"):
        raise GoogleConnectionError("Calendar account review changed", status_code=409)
    plan["connection_binding"] = list(binding)
    if plan.get("booking_source") == "board":
        plan["board_conflicts"] = await calendar._board_booking_state(user_id=user_id, plan=plan)


async def prepare_included_conflicts(
    calendar: GoogleCalendarService,
    *,
    user_id: str,
    action: str,
    plan: dict[str, Any],
    binding: tuple[str, ...],
) -> None:
    if (
        action == "create"
        and plan.get("booking_source") != "board"
        and await calendar.connections.has_service_scope(
            user_id=user_id, service="calendar", scope=CALENDAR_LIST_READ_SCOPE
        )
    ):
        plan["included_conflicts"] = await calendar._creation_conflicts(
            user_id=user_id, plan=plan, binding=binding
        )


async def verify_board_execution(
    calendar: GoogleCalendarService, *, user_id: str, plan: dict[str, Any]
) -> None:
    if datetime.fromisoformat(plan["start_at"].replace("Z", "+00:00")) <= datetime.now(UTC):
        raise GoogleConnectionError(
            "This time is in the past. Review another time.", status_code=409
        )
    if not plan.get("board_accounts"):
        raise GoogleConnectionError("Calendar account review is incomplete", status_code=409)
    calendar._reject_board_conflicts(
        planned=plan.get("board_conflicts"),
        current=await calendar._board_booking_state(user_id=user_id, plan=plan),
    )


async def execute_create(
    calendar: GoogleCalendarService,
    *,
    user_id: str,
    proposal_id: str,
    plan: dict[str, Any],
    binding: tuple[str, ...] | None,
) -> dict[str, Any]:
    if not str(plan.get("conference_request_id") or "").strip():
        plan["conference_request_id"] = f"meet_legacy_{proposal_id.removeprefix('gcal_')}"
    if plan.get("booking_source") != "board":
        calendar._reject_new_conflicts(
            planned=plan.get("primary_conflicts", plan.get("conflicts")),
            current=await calendar._find_conflicts(
                user_id=user_id,
                start_at=plan["start_at"],
                end_at=plan["end_at"],
                expected_binding=binding,
            ),
        )
    return await calendar._request(
        user_id=user_id,
        method="POST",
        path="/calendars/primary/events",
        access="manage",
        expected_binding=binding,
        params={
            "sendUpdates": "all" if plan["send_updates"] else "none",
            **(
                {"conferenceDataVersion": 1}
                if plan.get("meeting_type", "google_meet") == "google_meet"
                else {}
            ),
        },
        payload=calendar._event_payload(plan),
    )


def reject_board_conflicts(*, planned: object, current: list[dict[str, Any]]) -> None:
    if planned != current or current:
        raise GoogleConnectionError(
            "This time is no longer free across the checked accounts. Choose another opening.",
            status_code=409,
            reason_code="calendar_availability_changed",
        )


def event_payload(plan: dict[str, Any]) -> dict[str, Any]:
    body = {
        "summary": plan["title"],
        "description": plan["description"] or None,
        "location": plan["location"] or None,
        "start": {"dateTime": plan["start_at"], "timeZone": plan["time_zone"]},
        "end": {"dateTime": plan["end_at"], "timeZone": plan["time_zone"]},
        "attendees": [{"email": email} for email in plan["attendees"]],
    }
    if plan.get("meeting_type", "google_meet") == "google_meet":
        body["conferenceData"] = {
            "createRequest": {
                "requestId": plan["conference_request_id"],
                "conferenceSolutionKey": {"type": "hangoutsMeet"},
            }
        }
    return body
