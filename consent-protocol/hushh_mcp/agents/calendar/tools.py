"""Calendar tools exposed to One's authenticated text and voice heads.

The functions receive only the authenticated user id from ephemeral ADK state.
Google credentials remain inside ``GoogleConnectionService``. Calendar writes
create a short-lived proposal and a browser confirmation directive; they never
call Google until the owner presses the confirmation control.
"""

from __future__ import annotations

import asyncio
import json
import logging
from datetime import UTC, date, datetime, timedelta
from typing import Any, Awaitable, Callable, Literal
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from google.adk.tools.tool_context import ToolContext

from hushh_mcp.agents.calendar.read_offer import (
    STATE_CALENDAR_OFFER,
    STATE_EVENT_OFFER,
    STATE_INVITATION_OFFER,
    current_calendar_read_offer,
    make_calendar_read_offer,
)
from hushh_mcp.services.google_calendar_service import (
    EVENT_PAGE_MAX,
    get_google_calendar_service,
)
from hushh_mcp.services.google_connection_service import GoogleConnectionError
from hushh_mcp.services.owner_time import resolve_calendar_time

logger = logging.getLogger(__name__)

_CALENDAR_UNAVAILABLE_MESSAGE = "I couldn't reach your calendar just now. Try again in a moment."

_STATE_USER_ID = "hussh:user_id"
_STATE_TIMEZONE = "hussh:timezone"
_STATE_PENDING_DIRECTIVE = "hussh:pending_directive"
_STATE_CONVERSATION_ID = "hussh:conversation_id"


def _user_id(tool_context: ToolContext) -> str:
    user_id = str(tool_context.state.get(_STATE_USER_ID) or "").strip()
    if not user_id:
        raise GoogleConnectionError(
            "Sign in and unlock your vault to use Calendar",
            status_code=401,
            reason_code="google_not_connected",
        )
    return user_id


def _timezone(tool_context: ToolContext) -> str:
    value = str(tool_context.state.get(_STATE_TIMEZONE) or "UTC").strip() or "UTC"
    try:
        ZoneInfo(value)
    except (ValueError, ZoneInfoNotFoundError):
        # ZoneInfo raises ValueError, not ZoneInfoNotFoundError, for a key
        # shaped like an absolute or relative path (e.g. "../etc", "/UTC") --
        # _display_time below and nav_agent.py's own timezone guard already
        # catch both; this one caught only the narrower of the two.
        return "UTC"
    return value


async def _read_binding(service: Any, user_id: str) -> tuple[str, ...] | None:
    connections = getattr(service, "connections", None)
    binding_reader = getattr(connections, "read_grant_binding", None)
    if not callable(binding_reader):
        return None
    return await binding_reader(user_id=user_id, service="calendar")


def _conversation_id(tool_context: ToolContext) -> str:
    return str(tool_context.state.get(_STATE_CONVERSATION_ID) or "").strip()


async def _selected_calendar_id(
    *, tool_context: ToolContext, service: Any, user_id: str, ordinal: int
) -> str:
    binding = await _read_binding(service, user_id)
    offer = current_calendar_read_offer(
        tool_context.state.get(STATE_CALENDAR_OFFER),
        kind="calendars",
        owner_id=user_id,
        conversation_id=_conversation_id(tool_context),
        grant_binding=binding,
    )
    selected = offer.id_at(ordinal) if offer else None
    if not selected:
        raise GoogleConnectionError(
            "Show the subscribed calendars again, then choose one by position",
            status_code=422,
            reason_code="calendar_list_offer_required",
        )
    return selected


def _remember_offer(
    tool_context: ToolContext,
    *,
    key: str,
    kind: Literal["events", "calendars", "invitations"],
    user_id: str,
    binding: tuple[str, ...] | None,
    ids: list[str],
    calendar_id: str = "primary",
) -> None:
    tool_context.state[key] = (
        make_calendar_read_offer(
            kind=kind,
            owner_id=user_id,
            conversation_id=_conversation_id(tool_context),
            grant_binding=binding or (),
            ids=ids,
            calendar_id=calendar_id,
        )
        if binding
        else None
    )


async def _check_stable_binding(service: Any, user_id: str, before: tuple[str, ...] | None) -> None:
    if before is not None and await _read_binding(service, user_id) != before:
        raise GoogleConnectionError("Google Calendar connection changed", status_code=409)


def _connection_directive(
    tool_context: ToolContext,
    *,
    access_level: str,
    message: str,
    confirm_label: str | None = None,
    reason_code: str | None = None,
    include_calendar_list: bool = False,
) -> dict[str, Any]:
    directive = {
        "kind": "action",
        "delegateAgentId": "agent_calendar",
        "payload": {
            "type": "calendar.connect",
            "accessLevel": access_level,
            "reasonCode": reason_code,
            "includeCalendarList": include_calendar_list,
            "summary": message,
            "confirmLabel": confirm_label
            or ("Allow Calendar scheduling" if access_level == "manage" else "Connect Calendar"),
        },
    }
    tool_context.state[f"{_STATE_PENDING_DIRECTIVE}:calendar"] = directive
    return {
        "status": "connection_required",
        "reason_code": reason_code,
        "directive": directive,
        "message": message,
        "next_step": (
            "Ask the user to approve Calendar access; connection_required alone does not mean disconnected. Follow reason_code."
        ),
    }


def _handle_connection_error(
    tool_context: ToolContext,
    exc: GoogleConnectionError,
    *,
    access_level: str,
) -> dict[str, Any] | None:
    if exc.reason_code not in {
        "google_not_connected",
        "calendar_not_connected",
        "google_reauthorization_required",
        "google_permission_required",
        "calendar_reauthorization_required",
        "calendar_permission_required",
        "calendar_list_permission_required",
    }:
        return None
    if exc.reason_code == "calendar_list_permission_required":
        return _connection_directive(
            tool_context,
            access_level="read",
            message="Allow One to see your subscribed calendars before I can include them.",
            confirm_label="Allow calendar list access",
            reason_code=exc.reason_code,
            include_calendar_list=True,
        )
    label = "scheduling and editing events" if access_level == "manage" else "reading events"
    if exc.reason_code in {"google_permission_required", "calendar_permission_required"}:
        message = f"Allow Google Calendar permission for {label} to continue."
    elif exc.reason_code in {
        "google_reauthorization_required",
        "calendar_reauthorization_required",
    }:
        message = f"Renew Google Calendar permission for {label} to continue."
    else:
        message = f"Connect Google Calendar with permission for {label} to continue."
    return _connection_directive(
        tool_context,
        access_level=access_level,
        message=message,
        reason_code=exc.reason_code,
    )


async def _serve_via_door(
    tool_context: ToolContext, calendar_read: dict[str, Any] | None = None
) -> dict[str, Any] | None:
    """Read through the consented door in a hosted pod; None means read locally."""
    from hushh_mcp.one_adk.pod_connector_tools import (
        calendar_reads_via_door,
        calendar_turn_refusal,
    )

    if not calendar_reads_via_door():
        return await calendar_turn_refusal(tool_context)  # owner cloud: owner session only
    if calendar_read is not None:
        from hushh_mcp.services.pod_data_door import CalendarReadOptions

        calendar_read = CalendarReadOptions.model_validate(calendar_read).model_dump(mode="json")
    from hushh_mcp.one_adk.pod_data_door_specialist import (  # noqa: PLC0415
        serve_specialist_via_data_door,
    )

    options = {"calendar_read": calendar_read} if calendar_read is not None else {}
    payload = await serve_specialist_via_data_door("agent_calendar", tool_context, **options)
    if payload is None:
        return {"status": "failed", "message": _CALENDAR_UNAVAILABLE_MESSAGE}
    if calendar_read is not None:
        return {
            **payload.get("state", {}),
            "status": payload.get("status", "failed"),
            "source": "data_door",
        }
    text = str(payload.get("text") or "").strip()
    return {"status": "ok", "source": "data_door", "summary": text, "message": text}


async def _run_calendar_read(
    tool_context: ToolContext,
    call: Callable[[str], Awaitable[dict[str, Any]]],
    *,
    calendar_read: dict[str, Any] | None = None,
    owner_local_only: bool = False,
) -> dict[str, Any]:
    """Resolve the user id and run a Calendar read call inside one error
    boundary, converting any failure into a clean result instead of letting
    it escape the tool.

    An uncaught exception from a voice tool crashes the whole live session
    (Gemini Live's tool-response path has no error boundary of its own) --
    the same failure class a raw datetime once caused, just triggered by an
    exception instead of a serialization gap. GoogleConnectionError covers
    401/403 (needs a fresh connection, handled by _handle_connection_error)
    and other provider status codes (a rate limit, a 5xx, ...); the plain
    Exception catch covers what the HTTP client itself can raise on a
    timeout or connection failure, which is not a GoogleConnectionError at
    all.
    """
    try:
        user_id = _user_id(tool_context)
        async with asyncio.timeout(25):
            if owner_local_only:
                from hushh_mcp.one_adk.pod_connector_tools import calendar_reads_via_door

                if calendar_reads_via_door():
                    return {
                        "status": "unavailable",
                        "message": "This Calendar read requires your owner-cloud agent.",
                    }
            served = await _serve_via_door(tool_context, calendar_read)
            if served is not None:
                return served
            return await call(user_id)
    except TimeoutError:
        return {"status": "timeout", "message": "Calendar took too long. Please try again."}
    except GoogleConnectionError as exc:
        directive = _handle_connection_error(tool_context, exc, access_level="read")
        if directive is not None:
            return directive
        logger.warning("one_adk_calendar_call_failed status=%s", exc.status_code)
        if exc.status_code == 409:
            return {
                "status": "connection_changed",
                "message": "Your Calendar connection changed while I checked. Please ask again.",
            }
        if exc.status_code == 429:
            return {
                "status": "rate_limited",
                "message": "Google Calendar is busy right now. Please try again shortly.",
            }
        if exc.status_code == 404:
            return {
                "status": "not_found",
                "message": "That Calendar event was not found. Check the event and try again.",
            }
        if exc.status_code == 422:
            if exc.reason_code == "calendar_list_offer_required":
                return {
                    "status": "input_required",
                    "message": "Show the subscribed calendars again, then choose one from that list.",
                }
            if exc.reason_code == "calendar_event_offer_required":
                return {
                    "status": "input_required",
                    "message": "Show the events again, then choose one from that list.",
                }
            return {
                "status": "input_required",
                "message": "I need a valid Calendar date, time, or selection to check that.",
            }
        return {"status": "failed", "message": _CALENDAR_UNAVAILABLE_MESSAGE}
    except Exception as exc:  # noqa: BLE001 - keep provider information out of diagnostics
        logger.warning("one_adk_calendar_call_failed error_type=%s", type(exc).__name__)
        return {"status": "failed", "message": _CALENDAR_UNAVAILABLE_MESSAGE}


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
        resolved = resolve_calendar_time(str(value), timezone_name=_timezone(tool_context))
        parsed = datetime.fromisoformat(str(value).replace("Z", "+00:00"))
        return (
            parsed if parsed.tzinfo else resolved.astimezone(ZoneInfo(_timezone(tool_context)))
        ).isoformat()
    except (ValueError, OverflowError) as exc:
        raise GoogleConnectionError(
            "Use a valid Calendar time with an explicit offset when local time repeats",
            status_code=422,
            reason_code="calendar_time_invalid",
        ) from exc


async def calendar_summary(tool_context: ToolContext, days: int = 7) -> dict[str, Any]:
    """Get calendar events for the next 1–31 days so One can summarize them."""
    start_at, end_at = _iso_window(tool_context, days)

    async def _call(user_id: str) -> dict[str, Any]:
        tool_context.state[STATE_EVENT_OFFER] = None
        service = get_google_calendar_service()
        before = await _read_binding(service, user_id)
        result = await service.list_events(
            user_id=user_id, start_at=start_at, end_at=end_at, max_results=EVENT_PAGE_MAX
        )
        await _check_stable_binding(service, user_id, before)
        _remember_offer(
            tool_context,
            key=STATE_EVENT_OFFER,
            kind="events",
            user_id=user_id,
            binding=before,
            ids=[item.get("id") or "" for item in result.get("events", [])],
        )
        return {"status": "ok", "range_start": start_at, "range_end": end_at, **result}

    return await _run_calendar_read(
        tool_context,
        _call,
        calendar_read={"operation": "events", "start_at": start_at, "end_at": end_at},
    )


async def _event_calendar_id(
    tool_context: ToolContext,
    service: Any,
    user_id: str,
    calendar_id: str,
    calendar_ordinal: int | None,
) -> str:
    if calendar_ordinal is not None:
        if calendar_id != "primary":
            raise GoogleConnectionError(
                "Choose a Calendar by position",
                status_code=422,
                reason_code="calendar_list_offer_required",
            )
        return await _selected_calendar_id(
            tool_context=tool_context,
            service=service,
            user_id=user_id,
            ordinal=calendar_ordinal,
        )
    elif calendar_id == "primary":
        return "primary"
    else:
        raise GoogleConnectionError(
            "Show subscribed calendars and choose one by position",
            status_code=422,
            reason_code="calendar_list_offer_required",
        )


async def calendar_events(
    tool_context: ToolContext,
    start_at: str,
    end_at: str,
    query: str | None = None,
    limit: int = 100,
    calendar_id: str = "primary",
    calendar_ordinal: int | None = None,
    page_token: str | None = None,
) -> dict[str, Any]:
    """List events in an exact ISO-8601, time-zone-qualified interval.

    ``query`` is optional free text Google matches against title, description,
    location, attendees and organizer. ``limit`` is 1-250 events. When the
    result says ``truncated``, more events exist than were returned: say so,
    never claim the list is complete. Use this before rescheduling or
    cancelling so you use the event id returned by Google rather than
    guessing one.
    """

    async def _call(user_id: str) -> dict[str, Any]:
        tool_context.state[STATE_EVENT_OFFER] = None
        service = get_google_calendar_service()
        selected_id = await _event_calendar_id(
            tool_context, service, user_id, calendar_id, calendar_ordinal
        )
        before = await _read_binding(service, user_id)
        result = await service.list_events(
            user_id=user_id,
            start_at=_calendar_iso(start_at, tool_context),
            end_at=_calendar_iso(end_at, tool_context),
            max_results=_bounded_limit(limit),
            query=query,
            calendar_id=selected_id,
            page_token=page_token,
        )
        await _check_stable_binding(service, user_id, before)
        _remember_offer(
            tool_context,
            key=STATE_EVENT_OFFER,
            kind="events",
            user_id=user_id,
            binding=before,
            ids=[item.get("id") or "" for item in result.get("events", [])],
            calendar_id=selected_id,
        )
        return {
            "status": "ok",
            **result,
        }

    return await _run_calendar_read(
        tool_context,
        _call,
        calendar_read={
            "operation": "events",
            "query": query,
            "event_limit": _bounded_limit(limit),
            "start_at": _calendar_iso(start_at, tool_context),
            "end_at": _calendar_iso(end_at, tool_context),
        },
        owner_local_only=calendar_ordinal is not None
        or calendar_id != "primary"
        or page_token is not None,
    )


async def calendar_calendars(
    tool_context: ToolContext, limit: int = 50, page_token: str | None = None
) -> dict[str, Any]:
    """List subscribed calendars before selecting a secondary calendar."""

    async def _call(user_id: str) -> dict[str, Any]:
        tool_context.state[STATE_CALENDAR_OFFER] = None
        service = get_google_calendar_service()
        before = await _read_binding(service, user_id)
        result = await service.list_calendars(
            user_id=user_id, max_results=_bounded_limit(limit), page_token=page_token
        )
        await _check_stable_binding(service, user_id, before)
        _remember_offer(
            tool_context,
            key=STATE_CALENDAR_OFFER,
            kind="calendars",
            user_id=user_id,
            binding=before,
            ids=[item.get("id") or "" for item in result.get("calendars", [])],
        )
        return {
            "status": "ok",
            **result,
        }

    return await _run_calendar_read(tool_context, _call, owner_local_only=True)


async def calendar_event_detail(tool_context: ToolContext, ordinal: int) -> dict[str, Any]:
    """Read one exact event by its position in the last owner-visible list."""

    async def _call(user_id: str) -> dict[str, Any]:
        service = get_google_calendar_service()
        binding = await _read_binding(service, user_id)
        offer = current_calendar_read_offer(
            tool_context.state.get(STATE_EVENT_OFFER),
            kind="events",
            owner_id=user_id,
            conversation_id=_conversation_id(tool_context),
            grant_binding=binding,
        )
        event_id = offer.id_at(ordinal) if offer else None
        if not event_id or offer is None:
            tool_context.state[STATE_EVENT_OFFER] = None
            raise GoogleConnectionError(
                "Show the events again, then choose one by position",
                status_code=422,
                reason_code="calendar_event_offer_required",
            )
        result = await service.get_event(
            user_id=user_id, calendar_id=offer.calendar_id, event_id=event_id
        )
        await _check_stable_binding(service, user_id, binding)
        return {
            "status": "ok",
            **result,
        }

    return await _run_calendar_read(tool_context, _call, owner_local_only=True)


def _bounded_limit(value: object) -> int:
    if isinstance(value, bool) or not isinstance(value, (int, float, str)):
        return 100
    try:
        number = int(value)
    except ValueError:
        return 100
    bounded: int = max(1, min(number, EVENT_PAGE_MAX))
    return bounded


async def calendar_availability(
    tool_context: ToolContext,
    start_at: str,
    end_at: str,
) -> dict[str, Any]:
    """Check busy periods in an exact ISO-8601, time-zone-qualified interval."""

    async def _call(user_id: str) -> dict[str, Any]:
        return {
            "status": "ok",
            **await get_google_calendar_service().freebusy(
                user_id=user_id,
                start_at=_calendar_iso(start_at, tool_context),
                end_at=_calendar_iso(end_at, tool_context),
            ),
        }

    return await _run_calendar_read(
        tool_context,
        _call,
        calendar_read={
            "operation": "availability",
            "start_at": _calendar_iso(start_at, tool_context),
            "end_at": _calendar_iso(end_at, tool_context),
        },
    )


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

    async def _call(user_id: str) -> dict[str, Any]:
        return {
            "status": "ok",
            **await get_google_calendar_service().find_openings(
                user_id=user_id,
                start_at=_calendar_iso(start_at, tool_context),
                end_at=_calendar_iso(end_at, tool_context),
                duration_minutes=duration_minutes,
                limit=limit,
            ),
        }

    return await _run_calendar_read(
        tool_context,
        _call,
        calendar_read={
            "operation": "openings",
            "start_at": _calendar_iso(start_at, tool_context),
            "end_at": _calendar_iso(end_at, tool_context),
            "duration_minutes": duration_minutes,
            "limit": limit,
        },
    )


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
    """Prepare a meeting for review. It is not created until the owner confirms.

    Preserve a title and description supplied by the owner. Otherwise, write
    for every guest who will see the Calendar invitation: use a neutral topic
    or "Meeting with <verified inviter name>" (not the guest's own name), and
    briefly identify the inviter, date, time range, and timezone in the
    description. If the inviter's name is unavailable, do not guess one.
    """
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
    start_at: str,
    end_at: str,
    title: str | None = None,
    attendees: list[str] | None = None,
    description: str | None = None,
    location: str | None = None,
    send_updates: bool = True,
) -> dict[str, Any]:
    """Prepare a reschedule for a real event id. It is not changed until confirmed.

    Only the new time is required. Leave title, attendees, description and
    location out to keep them exactly as they are. ``attendees`` replaces the
    whole guest list, so pass it only to change who is invited; the review
    shows every attendee it adds or removes. An all-day event stays all-day.
    """
    payload: dict[str, Any] = {
        "event_id": event_id,
        "start_at": _calendar_iso(start_at, tool_context),
        "end_at": _calendar_iso(end_at, tool_context),
        "time_zone": _timezone(tool_context) if tool_context else "UTC",
        "send_updates": send_updates,
    }
    changes = {
        "title": title,
        "attendees": attendees,
        "description": description,
        "location": location,
    }
    payload.update({key: value for key, value in changes.items() if value})
    return await _propose(action="reschedule", payload=payload, tool_context=tool_context)


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
    *,
    action: Literal["create", "reschedule", "cancel"],
    payload: dict[str, Any],
    tool_context: ToolContext,
) -> dict[str, Any]:
    from hushh_mcp.one_adk.pod_connector_tools import (
        calendar_reads_via_door,
        calendar_turn_refusal,
    )

    if calendar_reads_via_door() or await calendar_turn_refusal(tool_context):
        return {
            "status": "runtime_unavailable",
            "message": "Prepare and confirm calendar changes in the owner app.",
        }
    try:
        proposal = await get_google_calendar_service().propose(
            user_id=_user_id(tool_context), action=action, payload=payload
        )
    except GoogleConnectionError as exc:
        directive = _handle_connection_error(tool_context, exc, access_level="manage")
        if directive is not None:
            return directive
        logger.warning(
            "one_adk_calendar_call_failed status=%s reason=%s", exc.status_code, exc.reason_code
        )
        return {
            "status": "failed",
            "reason_code": exc.reason_code or "calendar_unavailable",
            "message": _CALENDAR_UNAVAILABLE_MESSAGE,
        }
    except Exception:  # noqa: BLE001 - the model must be told something failed, not why internally
        logger.warning("one_adk_calendar_call_failed reason=unexpected")
        return {"status": "failed", "message": _CALENDAR_UNAVAILABLE_MESSAGE}
    plan = proposal.get("plan")
    proposal_id = proposal.get("proposal_id")
    expires_at = proposal.get("expires_at")
    if not isinstance(plan, dict) or not proposal_id or not expires_at:
        # Defensive: today's propose() always supplies all three. If that
        # contract ever drifts, a bracket-indexed KeyError here would
        # otherwise escape the tool the same way an uncaught exception
        # anywhere else in it would.
        logger.error("one_adk_calendar_propose_malformed action=%s", action)
        return {
            "status": "failed",
            "message": "Could not prepare that calendar change. Try again in a moment.",
        }
    verb = {"create": "Schedule", "reschedule": "Reschedule", "cancel": "Cancel"}[action]

    raw_conflicts = plan.get("conflicts")
    conflicts: list[object] = raw_conflicts if isinstance(raw_conflicts, list) else []
    if conflicts:
        confirm_label = f"{verb} anyway"
    elif action == "create":
        confirm_label = "Schedule meeting"
    else:
        confirm_label = verb
    # Presentation belongs to the active chat session, not to the provider's
    # event payload.  A proposal can legitimately contain UTC instants while
    # the person is using One in another local timezone.
    summary = _proposal_summary(
        action=action,
        plan=plan,
        conflicts=conflicts,
        display_time_zone=_timezone(tool_context),
    )
    event_fields = _directive_event_fields(action=action, plan=plan)
    # New events always request a unique Google Meet conference after the
    # owner confirms. A link does not exist yet, so the directive deliberately
    # communicates the reviewed outcome rather than inventing one.
    google_meet = action == "create"
    directive = {
        "kind": "action",
        "delegateAgentId": "agent_calendar",
        "payload": {
            "type": "calendar.execute_proposal",
            "proposalId": proposal_id,
            "action": action,
            "summary": summary,
            "confirmLabel": confirm_label,
            "expiresAt": expires_at,
            # Structured fields alongside `summary` so the client can render a
            # real card (title/time/attendees) instead of a flattened
            # sentence. `summary` stays authoritative for voice/non-card
            # surfaces -- these are additive, not a replacement.
            "eventId": plan.get("event_id"),
            "title": event_fields["title"],
            "startAt": event_fields["startAt"],
            "endAt": event_fields["endAt"],
            "timeZone": _timezone(tool_context),
            "attendees": event_fields["attendees"],
            "location": event_fields["location"],
            "description": event_fields["description"],
            "googleMeet": google_meet,
            **(
                {
                    "attendeesAdded": event_fields["attendeesAdded"],
                    "attendeesRemoved": event_fields["attendeesRemoved"],
                }
                if action == "reschedule"
                else {}
            ),
            "sendUpdates": bool(plan.get("send_updates")),
            "conflicts": [
                {"title": item.get("title"), "startAt": _flat_iso(item.get("start"))}
                for item in conflicts
                if isinstance(item, dict)
            ],
        },
    }
    tool_context.state[f"{_STATE_PENDING_DIRECTIVE}:calendar"] = directive
    return {
        "status": "confirmation_required",
        "proposal_id": proposal_id,
        "plan": plan,
        "conflicts": conflicts,
        "directive": directive,
        "message": (
            "Your requested time overlaps an existing Calendar event. The app is showing "
            "the exact conflict and will only schedule after you explicitly choose to proceed."
            if conflicts
            else (
                "The app is showing the meeting details for owner confirmation. "
                "A Google Meet link will be added after scheduling."
                if google_meet
                else "The app is showing the exact calendar change for owner confirmation."
            )
        ),
    }


def _proposal_summary(
    *,
    action: str,
    plan: dict[str, Any],
    conflicts: list[object],
    display_time_zone: str,
) -> str:
    verb = {"create": "Schedule", "reschedule": "Reschedule", "cancel": "Cancel"}[action]
    current = plan.get("current_event")
    current = current if isinstance(current, dict) else {}

    title = str(plan.get("title") or current.get("title") or plan.get("event_id") or "this event")
    if action == "cancel":
        timing = ""
    elif plan.get("all_day") and plan.get("start_date"):
        timing = f" to {_display_all_day(plan['start_date'], plan.get('end_date'))}"
    else:
        timing = f" for {_display_time(plan.get('start_at'), display_time_zone)}"
    count = _resulting_attendee_count(action=action, plan=plan)
    if not plan.get("send_updates"):
        attendee_note = " without sending updates" if count else ""
    else:
        attendee_note = f" and notify {_attendees(count)}" if count else ""
    change_note = _attendee_change_note(plan) if action == "reschedule" else ""
    details = [
        _conflict_detail(item, time_zone=display_time_zone)
        for item in conflicts
        if isinstance(item, dict)
    ]
    if details:
        return (
            f"You already have {', '.join(details)}. "
            f"{verb} “{title}”{timing}{attendee_note} anyway?{change_note}"
        )
    return f"{verb} “{title}”{timing}{attendee_note}?{change_note}"


def _attendees(count: int) -> str:
    return f"{count} attendee" if count == 1 else f"{count} attendees"


def _current_attendee_emails(plan: dict[str, Any]) -> list[str]:
    current = plan.get("current_event")
    current = current if isinstance(current, dict) else {}
    return [
        str(item.get("email"))
        for item in current.get("attendees", [])
        if isinstance(item, dict) and item.get("email")
    ]


def _resulting_attendee_count(*, action: str, plan: dict[str, Any]) -> int:
    """How many people the change reaches: never the model's argument count.

    A cancel or reschedule that did not name attendees still notifies every
    guest already on the event.
    """
    if action == "create":
        return len(plan.get("attendees", []))
    change = plan.get("attendee_change")
    if action == "reschedule" and isinstance(change, dict):
        return int(change.get("result_count") or 0)
    return len(_current_attendee_emails(plan))


def _attendee_change_note(plan: dict[str, Any]) -> str:
    change = plan.get("attendee_change")
    if not isinstance(change, dict):
        return ""
    parts = []
    for verb, key in (("adds", "added"), ("removes", "removed")):
        emails = [str(item) for item in change.get(key, []) if item]
        if emails:
            parts.append(f"{verb} {_attendees(len(emails))} ({', '.join(emails)})")
    return f" This {' and '.join(parts)}." if parts else ""


def _display_all_day(start_date: object, end_date: object) -> str:
    """ "Fri, Oct 2 (all day)"; a multi-day span names its last day."""
    try:
        first = date.fromisoformat(str(start_date))
        last = date.fromisoformat(str(end_date)) - timedelta(days=1) if end_date else first
    except ValueError:
        return f"{start_date} (all day)"
    label = f"{first:%a, %b} {first.day}"
    if last > first:
        label = f"{label} to {last:%a, %b} {last.day}"
    return f"{label} (all day)"


def _flat_iso(value: object) -> str | None:
    """Normalize Google's `{dateTime|date}` shape and a plain ISO string into
    one flat string the client always gets, regardless of which shape the
    source field happened to carry."""
    if isinstance(value, dict):
        value = value.get("dateTime") or value.get("date")
    text = str(value or "").strip()
    return text or None


def _directive_event_fields(*, action: str, plan: dict[str, Any]) -> dict[str, Any]:
    """Normalize the proposed event's title/time/attendees/location across all
    three actions for the client directive payload.

    `create` proposals carry the new title/time directly on `plan` (from the
    tool's own input). `cancel` only ever receives an `event_id` +
    `send_updates`, and a `reschedule` names only what it changes: the rest
    lives under `plan["current_event"]`, the real event `propose()` fetched
    from Google before staging the proposal (see `GoogleCalendarService.propose`).
    """
    current = plan.get("current_event")
    current = current if isinstance(current, dict) else {}
    if action == "cancel":
        return {
            "title": current.get("title"),
            "startAt": _flat_iso(current.get("start")),
            "endAt": _flat_iso(current.get("end")),
            "attendees": _current_attendee_emails(plan),
            "location": current.get("location") or None,
            "description": current.get("description") or None,
        }
    if action == "reschedule":
        change = plan.get("attendee_change")
        change = change if isinstance(change, dict) else {}
        removed = {str(item).lower() for item in change.get("removed", [])}
        attendees = [
            email for email in _current_attendee_emails(plan) if email.lower() not in removed
        ] + [str(item) for item in change.get("added", [])]
        all_day = bool(plan.get("all_day") and plan.get("start_date"))
        return {
            "title": plan.get("title") or current.get("title"),
            "startAt": plan.get("start_date") if all_day else _flat_iso(plan.get("start_at")),
            "endAt": plan.get("end_date") if all_day else _flat_iso(plan.get("end_at")),
            "attendees": attendees,
            "attendeesAdded": [str(item) for item in change.get("added", [])],
            "attendeesRemoved": [str(item) for item in change.get("removed", [])],
            "location": plan.get("location") or current.get("location") or None,
            "description": plan.get("description") or current.get("description") or None,
        }
    return {
        "title": plan.get("title"),
        "startAt": _flat_iso(plan.get("start_at")),
        "endAt": _flat_iso(plan.get("end_at")),
        "attendees": [str(item) for item in plan.get("attendees", [])],
        "location": plan.get("location") or None,
        "description": plan.get("description") or None,
    }


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
        local = parsed.astimezone(ZoneInfo(zone_name))
        return f"{local:%a, %b} {local.day} at {local.hour % 12 or 12}:{local:%M %p %Z}"
    except (ValueError, ZoneInfoNotFoundError):
        return text


async def calendar_invitations(
    tool_context: ToolContext,
    filter: Literal["pending", "responded", "all"] = "pending",
    start_at: str = "",
    end_at: str = "",
    selected_calendar_id: str = "",
    selected_event_id: str = "",
    expected_account_email: str = "",
) -> dict[str, Any]:
    """Read real received invitations; show inline results, never navigate or write.

    For an RSVP request, read the relevant window first, resolve ambiguity with
    the owner, then call open_calendar_invitation with its returned ordinal.
    """

    async def call(user_id):
        service = get_google_calendar_service()
        binding = await _read_binding(service, user_id)
        tool_context.state[STATE_INVITATION_OFFER] = None
        window = {}
        if start_at:
            window["start_at"] = _calendar_iso(start_at, tool_context)
        if end_at:
            window["end_at"] = _calendar_iso(end_at, tool_context)
        result = await service.invitations(
            user_id=user_id,
            time_zone=_timezone(tool_context),
            selected_calendar_id=selected_calendar_id or None,
            selected_event_id=selected_event_id or None,
            **window,
        )
        await _check_stable_binding(service, user_id, binding)
        account = str(result.get("account_email") or "")
        if expected_account_email and account.casefold() != expected_account_email.casefold():
            raise GoogleConnectionError(
                "The connected Calendar account changed. Check this invitation again.",
                status_code=409,
                reason_code="calendar_connection_changed",
            )
        events = [
            e
            for e in result["events"]
            if filter == "all" or (e["response_status"] == "needsAction") == (filter == "pending")
        ]
        offered = events[:250]
        _remember_offer(
            tool_context,
            key=STATE_INVITATION_OFFER,
            kind="invitations",
            user_id=user_id,
            binding=binding,
            ids=[
                json.dumps(
                    [e["calendar_id"], e["id"], result["start_at"], result["end_at"], account]
                )
                for e in offered
            ],
        )
        directive = {
            "kind": "action",
            "delegateAgentId": "agent_calendar",
            "payload": {
                "type": "calendar.invitations",
                "filter": filter,
                "accountEmail": account,
                "timeZone": _timezone(tool_context),
                "startAt": result["start_at"],
                "endAt": result["end_at"],
            },
        }
        tool_context.state["hussh:pending_directive:calendar_invitations"] = directive
        return {
            "status": "completed",
            "events": [{**e, "ordinal": i + 1} for i, e in enumerate(offered)],
            "account_email": account,
            "pending_count": result["pending_count"],
            "truncated": len(events) > len(offered),
            "complete": result["complete"],
            "directive": directive,
            "message": "Invitations are shown inside this conversation. No response was changed. Use open_calendar_invitation to prepare the owner's requested decision; only their explicit browser confirmation can apply it.",
        }

    return await _run_calendar_read(tool_context, call)


async def open_calendar_invitation(
    tool_context: ToolContext,
    ordinal: int,
    decision: Literal["view", "accepted", "declined", "offer_times"] = "view",
    alternative_date: str = "",
    alternative_start_time: str = "",
    alternative_end_time: str = "",
    alternative_duration_minutes: int = 0,
    organizer_message: str = "",
) -> dict[str, Any]:
    """Client-only invitation review, never RSVP, Mail preparation or delivery.

    Select only an ordinal from calendar_invitations. The browser re-reads the
    event, lets the owner edit the message/window, and prepares its own exact
    confirmation. No Calendar text can authorize a provider action here.
    """

    async def call(user_id):
        service = get_google_calendar_service()
        binding = await _read_binding(service, user_id)
        offer = current_calendar_read_offer(
            tool_context.state.get(STATE_INVITATION_OFFER),
            kind="invitations",
            owner_id=user_id,
            conversation_id=_conversation_id(tool_context),
            grant_binding=binding,
        )
        selected = offer.id_at(ordinal) if offer else None
        if not selected:
            return {
                "status": "input_required",
                "message": "Show the invitations again, then choose one from that list.",
            }
        calendar_id, event_id, start_at, end_at, account = json.loads(selected)
        try:
            if alternative_date:
                date.fromisoformat(alternative_date)
            for clock in (alternative_start_time, alternative_end_time):
                if clock:
                    datetime.strptime(clock, "%H:%M")
            if alternative_duration_minutes and not 1 <= alternative_duration_minutes <= 1440:
                raise ValueError()
            if len(organizer_message) > 8000:
                raise ValueError()
        except ValueError:
            return {
                "status": "input_required",
                "message": "Choose a valid alternative date, time window, duration and message.",
            }
        terms = {
            key: value
            for key, value in {
                "date": alternative_date,
                "startTime": alternative_start_time,
                "endTime": alternative_end_time,
                "durationMinutes": alternative_duration_minutes,
                "message": organizer_message,
            }.items()
            if value
        }
        directive = {
            "kind": "action",
            "delegateAgentId": "agent_calendar",
            "payload": {
                "type": "calendar.invitations",
                "filter": "all",
                "calendarId": calendar_id,
                "eventId": event_id,
                "decision": decision,
                "accountEmail": account,
                **({"terms": terms} if terms else {}),
                "timeZone": _timezone(tool_context),
                "startAt": start_at,
                "endAt": end_at,
            },
        }
        tool_context.state["hussh:pending_directive:calendar_invitations"] = directive
        return {
            "status": "review_required",
            "directive": directive,
            "message": "Review this invitation in the current conversation. Nothing has been changed or sent.",
        }

    return await _run_calendar_read(tool_context, call)
