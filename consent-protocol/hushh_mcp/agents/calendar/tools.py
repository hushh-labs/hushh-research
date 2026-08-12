"""Calendar tools exposed to One's authenticated text and voice heads.

The functions receive only the authenticated user id from ephemeral ADK state.
Google credentials remain inside ``GoogleConnectionService``. Calendar writes
create a short-lived proposal and a browser confirmation directive; they never
call Google until the owner presses the confirmation control.
"""

from __future__ import annotations

from datetime import UTC, datetime, timedelta
from typing import Any
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from google.adk.tools.tool_context import ToolContext

from hushh_mcp.services.google_calendar_service import get_google_calendar_service
from hushh_mcp.services.google_connection_service import GoogleConnectionError

_STATE_USER_ID = "hussh:user_id"
_STATE_TIMEZONE = "hussh:timezone"
_STATE_PENDING_DIRECTIVE = "hussh:pending_directive"


def _user_id(tool_context: ToolContext) -> str:
    user_id = str(tool_context.state.get(_STATE_USER_ID) or "").strip()
    if not user_id:
        raise GoogleConnectionError(
            "Sign in and unlock your vault to use Calendar", status_code=401
        )
    return user_id


def _timezone(tool_context: ToolContext) -> str:
    value = str(tool_context.state.get(_STATE_TIMEZONE) or "UTC").strip() or "UTC"
    try:
        ZoneInfo(value)
    except ZoneInfoNotFoundError:
        return "UTC"
    return value


def _connection_directive(
    tool_context: ToolContext, *, access_level: str, message: str
) -> dict[str, Any]:
    needs_scheduling = access_level == "manage"
    tool_context.state[f"{_STATE_PENDING_DIRECTIVE}:calendar"] = {
        "kind": "action",
        "delegateAgentId": "agent_calendar",
        "payload": {
            "type": "calendar.connect",
            "accessLevel": access_level,
            "summary": message,
            "confirmLabel": (
                "Allow Calendar scheduling" if needs_scheduling else "Connect Calendar"
            ),
        },
    }
    return {
        "status": "connection_required",
        "message": message,
        "next_step": (
            "The app is showing a Calendar authorization control. Ask the user to approve it."
        ),
    }


def _handle_connection_error(
    tool_context: ToolContext,
    exc: GoogleConnectionError,
    *,
    access_level: str,
) -> dict[str, Any] | None:
    if exc.status_code not in {401, 403}:
        return None
    label = "editing" if access_level == "manage" else "reading"
    return _connection_directive(
        tool_context,
        access_level=access_level,
        message=f"Connect Google Calendar with permission for {label} before I can help with that.",
    )


def _iso_window(tool_context: ToolContext, days: int) -> tuple[str, str]:
    clean_days = max(1, min(int(days), 31))
    zone = ZoneInfo(_timezone(tool_context))
    start = datetime.now(zone).replace(second=0, microsecond=0)
    end = start + timedelta(days=clean_days)
    return start.astimezone(UTC).isoformat().replace("+00:00", "Z"), end.astimezone(
        UTC
    ).isoformat().replace("+00:00", "Z")


def _calendar_iso(value: str, tool_context: ToolContext) -> str:
    """Use the person's declared timezone only when the model omitted an offset."""
    try:
        parsed = datetime.fromisoformat(str(value).replace("Z", "+00:00"))
    except ValueError:
        return str(value)
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=ZoneInfo(_timezone(tool_context)))
    return parsed.isoformat()


async def calendar_summary(tool_context: ToolContext, days: int = 7) -> dict[str, Any]:
    """Get calendar events for the next 1–31 days so One can summarize them."""
    user_id = _user_id(tool_context)
    start_at, end_at = _iso_window(tool_context, days)
    try:
        result = await get_google_calendar_service().list_events(
            user_id=user_id, start_at=start_at, end_at=end_at, max_results=100
        )
    except GoogleConnectionError as exc:
        directive = _handle_connection_error(tool_context, exc, access_level="read")
        if directive is not None:
            return directive
        raise
    return {"status": "ok", "range_start": start_at, "range_end": end_at, **result}


async def calendar_events(
    tool_context: ToolContext,
    start_at: str,
    end_at: str,
) -> dict[str, Any]:
    """List events in an exact ISO-8601, time-zone-qualified interval.

    Use this before rescheduling or cancelling so you use the event id returned
    by Google rather than guessing one.
    """
    try:
        return {
            "status": "ok",
            **await get_google_calendar_service().list_events(
                user_id=_user_id(tool_context),
                start_at=_calendar_iso(start_at, tool_context),
                end_at=_calendar_iso(end_at, tool_context),
            ),
        }
    except GoogleConnectionError as exc:
        directive = _handle_connection_error(tool_context, exc, access_level="read")
        if directive is not None:
            return directive
        raise


async def calendar_availability(
    tool_context: ToolContext,
    start_at: str,
    end_at: str,
) -> dict[str, Any]:
    """Check busy periods in an exact ISO-8601, time-zone-qualified interval."""
    try:
        return {
            "status": "ok",
            **await get_google_calendar_service().freebusy(
                user_id=_user_id(tool_context),
                start_at=_calendar_iso(start_at, tool_context),
                end_at=_calendar_iso(end_at, tool_context),
            ),
        }
    except GoogleConnectionError as exc:
        directive = _handle_connection_error(tool_context, exc, access_level="read")
        if directive is not None:
            return directive
        raise


async def calendar_free_slots(
    tool_context: ToolContext,
    start_at: str,
    end_at: str,
    duration_minutes: int,
    limit: int = 3,
) -> dict[str, Any]:
    """Find the earliest 1–20 open slots in an exact time window.

    Use this when the person gives a scheduling window and a call duration.
    It searches only the owner's primary Calendar; it does not claim invitee
    availability. Once a person chooses a slot, use the normal proposal tool
    so the browser still presents the final explicit confirmation.
    """
    try:
        return {
            "status": "ok",
            **await get_google_calendar_service().find_openings(
                user_id=_user_id(tool_context),
                start_at=_calendar_iso(start_at, tool_context),
                end_at=_calendar_iso(end_at, tool_context),
                duration_minutes=duration_minutes,
                limit=limit,
            ),
        }
    except GoogleConnectionError as exc:
        directive = _handle_connection_error(tool_context, exc, access_level="read")
        if directive is not None:
            return directive
        raise


async def propose_calendar_event(
    tool_context: ToolContext,
    title: str,
    start_at: str,
    end_at: str,
    attendees: list[str] | None = None,
    description: str | None = None,
    location: str | None = None,
    send_updates: bool = True,
) -> dict[str, Any]:
    """Prepare a meeting for review. It is not created until the owner confirms."""
    return await _propose(
        action="create",
        payload={
            "title": title,
            "start_at": _calendar_iso(start_at, tool_context),
            "end_at": _calendar_iso(end_at, tool_context),
            "time_zone": _timezone(tool_context) if tool_context else "UTC",
            "attendees": attendees or [],
            "description": description or "",
            "location": location or "",
            "send_updates": send_updates,
        },
        tool_context=tool_context,
    )


async def propose_calendar_reschedule(
    tool_context: ToolContext,
    event_id: str,
    title: str,
    start_at: str,
    end_at: str,
    attendees: list[str] | None = None,
    description: str | None = None,
    location: str | None = None,
    send_updates: bool = True,
) -> dict[str, Any]:
    """Prepare a reschedule for a real event id. It is not changed until confirmed."""
    return await _propose(
        action="reschedule",
        payload={
            "event_id": event_id,
            "title": title,
            "start_at": _calendar_iso(start_at, tool_context),
            "end_at": _calendar_iso(end_at, tool_context),
            "time_zone": _timezone(tool_context) if tool_context else "UTC",
            "attendees": attendees or [],
            "description": description or "",
            "location": location or "",
            "send_updates": send_updates,
        },
        tool_context=tool_context,
    )


async def propose_calendar_cancellation(
    tool_context: ToolContext,
    event_id: str,
    send_updates: bool = True,
) -> dict[str, Any]:
    """Prepare cancellation of a real event id. It is not cancelled until confirmed."""
    return await _propose(
        action="cancel",
        payload={"event_id": event_id, "send_updates": send_updates},
        tool_context=tool_context,
    )


async def _propose(
    *, action: str, payload: dict[str, Any], tool_context: ToolContext
) -> dict[str, Any]:
    try:
        proposal = await get_google_calendar_service().propose(
            user_id=_user_id(tool_context), action=action, payload=payload
        )
    except GoogleConnectionError as exc:
        directive = _handle_connection_error(tool_context, exc, access_level="manage")
        if directive is not None:
            return directive
        raise
    plan = proposal["plan"]
    verb = {"create": "Schedule", "reschedule": "Reschedule", "cancel": "Cancel"}[action]
    conflicts = plan.get("conflicts") if isinstance(plan.get("conflicts"), list) else []
    summary = _proposal_summary(action=action, plan=plan, conflicts=conflicts)
    confirm_label = f"{verb} anyway" if conflicts else verb
    tool_context.state[f"{_STATE_PENDING_DIRECTIVE}:calendar"] = {
        "kind": "action",
        "delegateAgentId": "agent_calendar",
        "payload": {
            "type": "calendar.execute_proposal",
            "proposalId": proposal["proposal_id"],
            "action": action,
            "summary": summary,
            "confirmLabel": confirm_label,
            "expiresAt": proposal["expires_at"],
        },
    }
    return {
        "status": "confirmation_required",
        "proposal_id": proposal["proposal_id"],
        "plan": plan,
        "conflicts": conflicts,
        "message": (
            "Your requested time overlaps an existing Calendar event. The app is showing "
            "the exact conflict and will only schedule after you explicitly choose to proceed."
            if conflicts
            else "The app is showing the exact calendar change for owner confirmation."
        ),
    }


def _proposal_summary(*, action: str, plan: dict[str, Any], conflicts: list[object]) -> str:
    verb = {"create": "Schedule", "reschedule": "Reschedule", "cancel": "Cancel"}[action]
    title = str(plan.get("title") or plan.get("event_id") or "this event")
    timing = (
        ""
        if action == "cancel"
        else f" for {_display_time(plan.get('start_at'), plan.get('time_zone'))}"
    )
    attendee_note = (
        f" and notify {len(plan.get('attendees', []))} attendee(s)"
        if plan.get("send_updates")
        else " without sending updates"
    )
    details = [
        _conflict_detail(item, time_zone=str(plan.get("time_zone") or "UTC"))
        for item in conflicts
        if isinstance(item, dict)
    ]
    if details:
        return (
            f"You already have {', '.join(details)}. "
            f"{verb} “{title}”{timing}{attendee_note} anyway?"
        )
    return f"{verb} “{title}”{timing}{attendee_note}?"


def _conflict_detail(event: dict[str, Any], *, time_zone: str) -> str:
    title = str(event.get("title") or "an existing event")
    start = event.get("start")
    if isinstance(start, dict):
        value = start.get("dateTime") or start.get("date")
        if value:
            return f"“{title}” at {_display_time(value, time_zone)}"
    return f"“{title}” during that time"


def _display_time(value: object, time_zone: object) -> str:
    text = str(value or "").strip()
    zone_name = str(time_zone or "UTC")
    if not text:
        return "the requested time"
    try:
        parsed = datetime.fromisoformat(text.replace("Z", "+00:00"))
        if parsed.tzinfo is None:
            return text
        return parsed.astimezone(ZoneInfo(zone_name)).strftime("%a, %b %-d at %-I:%M %p %Z")
    except (ValueError, ZoneInfoNotFoundError):
        return text
