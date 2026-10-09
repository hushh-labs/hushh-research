"""Read-only Calendar adapter for One Live Voice.

Google remains the source of truth. Event and calendar names go to the owner's
screen, while the operational Live model receives only a count/status receipt.
Positions are resolved against short-lived, account-bound server offers.
"""

from __future__ import annotations

import logging
from datetime import timedelta
from typing import Any, Literal

from pydantic import Field

from hushh_mcp.one_voice.tools.base import (
    OfferedCalendarEvents,
    ToolContext,
    ToolInput,
    ToolPolicy,
    ToolResult,
    ToolSpec,
)
from hushh_mcp.services.google_calendar_service import get_google_calendar_service
from hushh_mcp.services.google_connection_service import GoogleConnectionError
from hushh_mcp.services.owner_time import resolve_calendar_time

logger = logging.getLogger(__name__)
CALENDAR_SERVICE = "voice_calendar"
MAX_EVENTS = 10
MAX_CALENDARS = 20
MAX_WINDOW = timedelta(days=31)


class ReadCalendarInput(ToolInput):
    operation: Literal["events", "event", "calendars", "freebusy", "openings"] = Field(
        description="Events, offered detail, calendars, busy time or openings."
    )
    more: bool = Field(default=False, description="Next events/calendars page; omit filters.")
    start_at: str | None = Field(
        default=None,
        max_length=40,
        description="ISO start; no offset means owner time.",
    )
    end_at: str | None = Field(
        default=None,
        max_length=40,
        description="Exclusive ISO end; no offset means owner time.",
    )
    calendar_ordinal: int | None = Field(
        default=None,
        ge=1,
        le=MAX_CALENDARS,
        description="Position in last calendar list; omit for primary.",
    )
    event_ordinal: int | None = Field(
        default=None,
        ge=1,
        le=MAX_EVENTS,
        description="Position in last event list.",
    )
    query: str | None = Field(
        default=None,
        max_length=256,
        description="Optional event search words.",
    )
    duration_minutes: int | None = Field(
        default=None,
        ge=5,
        le=720,
        description="Free slot minutes.",
    )


class CalendarReadResult(ToolResult):
    status: Literal["ok", "rejected"] = "ok"
    operation: str = ""
    events: list[dict[str, Any]] = Field(default_factory=list)
    event: dict[str, Any] | None = None
    calendars: list[dict[str, Any]] = Field(default_factory=list)
    busy: list[dict[str, Any]] = Field(default_factory=list)
    openings: list[dict[str, Any]] = Field(default_factory=list)
    returned_count: int = 0
    truncated: bool = False
    time_zone: str | None = None

    def model_public(self) -> dict[str, Any]:
        # No Google-supplied text or identifiers enter the operational session,
        # including its provider-side compressed history/resumption handle.
        return {
            "status": self.status,
            "operation": self.operation,
            "returned_count": self.returned_count,
            "truncated": self.truncated,
            "reason_code": self.reason_code,
            "spoken_facts": self.spoken_facts,
        }

    def narratable_digest(self) -> str:
        # This crosses only into the isolated, tool-less TTS context. The
        # operational model receives model_public() above. Keep it brief.
        if self.status != "ok":
            return ""
        if self.operation in {"events", "event"}:
            rows = [self.event] if self.event else self.events[:3]
            parts = []
            for row in rows:
                if not isinstance(row, dict):
                    continue
                title = " ".join(str(row.get("title") or "Untitled event").split())
                start = _event_when(row.get("start"))
                end = _event_when(row.get("end"))
                location = " ".join(str(row.get("location") or "").split())
                parts.append(
                    f"{title[:100]}, {start} to {end}"
                    + (f", at {location[:80]}" if location else "")
                    + "."
                )
            if not parts:
                return "No events were found in that time."
            intro = (
                f"I found {self.returned_count} events. "
                if self.operation == "events"
                else "Here is that event. "
            )
            ending = " More events are on screen." if self.returned_count > len(parts) else ""
            if self.truncated:
                ending += " More matching events exist."
            return (intro + " ".join(parts) + ending)[:650]
        if self.operation == "freebusy":
            return (
                f"I found {self.returned_count} busy periods in that window. "
                "Their times are on screen."
            )
        if self.operation == "openings":
            return f"I found {self.returned_count} available openings. Their times are on screen."
        return ""


def _event_when(value: Any) -> str:
    if isinstance(value, dict):
        return str(value.get("dateTime") or value.get("date") or "time unavailable")[:40]
    return "time unavailable"


def _reject(operation: str, code: str, fact: str) -> CalendarReadResult:
    return CalendarReadResult(
        status="rejected", operation=operation, reason_code=code, spoken_facts=[fact]
    )


def _range(args: ReadCalendarInput, ctx: ToolContext) -> tuple[str, str] | None:
    if not args.start_at or not args.end_at:
        return None
    try:
        start = resolve_calendar_time(args.start_at, timezone_name=ctx.timezone)
        end = resolve_calendar_time(args.end_at, timezone_name=ctx.timezone)
        if end <= start or end - start > MAX_WINDOW:
            return None
        return start.isoformat(), end.isoformat()
    except (OverflowError, TypeError, ValueError):
        return None


async def _binding(service: Any, user_id: str) -> tuple[str, ...] | None:
    value = await service.connections.read_grant_binding(user_id=user_id, service="calendar")
    return tuple(value) if value else None


async def _selected_calendar(
    ctx: ToolContext, service: Any, ordinal: int | None, binding: tuple[str, ...]
) -> str | None:
    if ordinal is None:
        return "primary"
    offer = ctx.entities.offered_calendars
    if (
        not ctx.entities.calendar_list_is_fresh()
        or offer is None
        or offer.grant_binding != binding
        or ordinal > len(offer.calendar_ids)
    ):
        return None
    return offer.calendar_ids[ordinal - 1]


async def _read_calendar(ctx: ToolContext, args: ReadCalendarInput) -> ToolResult:
    service = ctx.service(CALENDAR_SERVICE, get_google_calendar_service)
    operation = args.operation
    try:
        binding = await _binding(service, ctx.user_id)
        if binding is None:
            status_reader = getattr(service.connections, "status", None)
            status = (
                await status_reader(user_id=ctx.user_id, service="calendar")
                if callable(status_reader)
                else {}
            )
            if status.get("status") == "needs_reauth":
                return _reject(
                    operation, "reconnect_required", "Reconnect Google Calendar so I can read it."
                )
            if status.get("connected"):
                return _reject(
                    operation,
                    "permission_required",
                    "Allow Calendar reading before I can check it.",
                )
            return _reject(operation, "calendar_not_connected", "Connect Calendar to read it.")
        continuation = None
        if args.more:
            if operation not in {"events", "calendars"} or any(
                value is not None
                for value in (
                    args.start_at,
                    args.end_at,
                    args.calendar_ordinal,
                    args.event_ordinal,
                    args.query,
                    args.duration_minutes,
                )
            ):
                return _reject(
                    operation,
                    "invalid_continuation",
                    "Ask for the next page, or start a new search.",
                )
            continuation = (
                ctx.entities.offered_calendar_events
                if operation == "events"
                else ctx.entities.offered_calendars
            )
            fresh = (
                ctx.entities.calendar_offer_is_fresh()
                if operation == "events"
                else ctx.entities.calendar_list_is_fresh()
            )
            if not fresh or continuation is None or continuation.grant_binding != binding:
                return _reject(
                    operation, "page_expired", "Show the list again before asking for more."
                )
            if not continuation.next_page_token:
                return _reject(
                    operation, "no_more_results", "There are no more results in that list."
                )
        if operation == "calendars":
            data = await service.list_calendars(
                user_id=ctx.user_id,
                max_results=MAX_CALENDARS,
                **({"page_token": continuation.next_page_token} if continuation else {}),
            )
            if await _binding(service, ctx.user_id) != binding:
                return _reject(
                    operation, "connection_changed", "Calendar changed. Please ask again."
                )
            rows = [item for item in data.get("calendars", []) if isinstance(item, dict)]
            ctx.entities.offer_calendars(
                [str(item["id"]) for item in rows if item.get("id")],
                grant_binding=binding,
                next_page_token=data.get("next_page_token"),
            )
            count = len(rows)
            truncated = bool(data.get("truncated"))
            return CalendarReadResult(
                operation=operation,
                calendars=rows,
                returned_count=count,
                truncated=truncated,
                spoken_facts=[
                    f"I found {count} calendars. Their names are on screen."
                    + (" Ask for the next page to see more." if truncated else "")
                ],
            )
        if operation == "event":
            offer = ctx.entities.offered_calendar_events
            ordinal = args.event_ordinal
            if (
                ordinal is None
                or not ctx.entities.calendar_offer_is_fresh()
                or offer is None
                or offer.grant_binding != binding
                or ordinal > len(offer.event_ids)
            ):
                return _reject(
                    operation,
                    "event_not_offered",
                    "Show me the events first, then choose one by its position.",
                )
            data = await service.get_event(
                user_id=ctx.user_id,
                calendar_id=offer.calendar_id,
                event_id=offer.event_ids[ordinal - 1],
            )
            if await _binding(service, ctx.user_id) != binding:
                return _reject(
                    operation, "connection_changed", "Calendar changed. Please ask again."
                )
            event = data.get("event")
            if not isinstance(event, dict):
                return _reject(operation, "event_unavailable", "I couldn't open that event.")
            return CalendarReadResult(
                operation=operation,
                event=event,
                returned_count=1,
                time_zone=ctx.timezone,
                spoken_facts=["I opened that event's details on screen."],
            )

        event_page = continuation if isinstance(continuation, OfferedCalendarEvents) else None
        window = (
            (event_page.start_at, event_page.end_at)
            if event_page and event_page.start_at and event_page.end_at
            else _range(args, ctx)
        )
        if window is None:
            return _reject(
                operation,
                "invalid_window",
                "Give me a valid time within 31 days, including a UTC offset if the local time repeats.",
            )
        calendar_id = (
            event_page.calendar_id
            if event_page
            else await _selected_calendar(ctx, service, args.calendar_ordinal, binding)
        )
        if calendar_id is None:
            return _reject(
                operation,
                "calendar_not_offered",
                "Show me your calendars first, then choose one by its position.",
            )
        start_at, end_at = window
        if operation == "events":
            data = await service.list_events(
                user_id=ctx.user_id,
                calendar_id=calendar_id,
                start_at=start_at,
                end_at=end_at,
                max_results=MAX_EVENTS,
                query=event_page.query if event_page else args.query,
                **({"page_token": continuation.next_page_token} if continuation else {}),
            )
            if await _binding(service, ctx.user_id) != binding:
                return _reject(
                    operation, "connection_changed", "Calendar changed. Please ask again."
                )
            rows = [item for item in data.get("events", []) if isinstance(item, dict)]
            ctx.entities.offer_calendar_events(
                [str(item["id"]) for item in rows if item.get("id")],
                calendar_id=calendar_id,
                grant_binding=binding,
                start_at=start_at,
                end_at=end_at,
                query=event_page.query if event_page else args.query,
                next_page_token=data.get("next_page_token"),
            )
            count = len(rows)
            truncated = bool(data.get("truncated"))
            return CalendarReadResult(
                operation=operation,
                events=rows,
                returned_count=count,
                truncated=truncated,
                time_zone=data.get("time_zone") or ctx.timezone,
                spoken_facts=[
                    f"I found {count} events in that time. Their details are on screen."
                    + (" Ask for the next page to see more matching events." if truncated else "")
                ],
            )
        if operation == "freebusy":
            data = await service.freebusy(
                user_id=ctx.user_id,
                start_at=start_at,
                end_at=end_at,
                calendar_ids=[calendar_id],
            )
            if await _binding(service, ctx.user_id) != binding:
                return _reject(
                    operation, "connection_changed", "Calendar changed. Please ask again."
                )
            calendar = (data.get("calendars") or {}).get(calendar_id) or {}
            rows = [item for item in calendar.get("busy", []) if isinstance(item, dict)]
            return CalendarReadResult(
                operation=operation,
                busy=rows,
                returned_count=len(rows),
                time_zone=data.get("time_zone") or ctx.timezone,
                spoken_facts=[f"I found {len(rows)} busy periods. Their times are on screen."],
            )
        if args.duration_minutes is None:
            return _reject(operation, "duration_required", "How long should each free slot be?")
        data = await service.find_openings(
            user_id=ctx.user_id,
            start_at=start_at,
            end_at=end_at,
            duration_minutes=args.duration_minutes,
            limit=5,
            calendar_ids=[calendar_id],
        )
        if await _binding(service, ctx.user_id) != binding:
            return _reject(operation, "connection_changed", "Calendar changed. Please ask again.")
        rows = [item for item in data.get("openings", []) if isinstance(item, dict)]
        return CalendarReadResult(
            operation=operation,
            openings=rows,
            returned_count=len(rows),
            time_zone=data.get("time_zone") or ctx.timezone,
            spoken_facts=[f"I found {len(rows)} available openings. Their times are on screen."],
        )
    except GoogleConnectionError as exc:
        # Provider errors can contain third-party text. Map by status only.
        status = getattr(exc, "status_code", None)
        if status == 401:
            return _reject(
                operation, "reconnect_required", "Reconnect Google Calendar so I can read it."
            )
        if status == 504 or exc.reason_code == "calendar_timeout":
            return _reject(operation, "read_timeout", "Calendar took too long. Please try again.")
        if status == 403:
            fact = (
                "Reconnect Calendar to allow its calendar list."
                if operation == "calendars"
                else "Connect Calendar or allow Calendar reading first."
            )
            return _reject(operation, "permission_required", fact)
        if status == 409:
            return _reject(operation, "connection_changed", "Calendar changed. Please ask again.")
        if status == 429:
            return _reject(operation, "rate_limited", "Calendar is busy. Please try again later.")
        if status == 404 and operation == "event":
            return _reject(operation, "event_unavailable", "That event is no longer available.")
        logger.info("one_voice.calendar_read failure=%s status=%s", type(exc).__name__, status)
        return _reject(operation, "calendar_unavailable", "I couldn't check Calendar just now.")
    except Exception as exc:  # noqa: BLE001 - no provider text reaches model/log
        logger.info("one_voice.calendar_read failure=%s", type(exc).__name__)
        return _reject(operation, "calendar_unavailable", "I couldn't check Calendar just now.")


TOOLS: tuple[ToolSpec, ...] = (
    ToolSpec(
        name="read_calendar",
        gateway_action_id="calendar.read",
        policy=ToolPolicy.read,
        input_model=ReadCalendarInput,
        output_model=CalendarReadResult,
        description=(
            "Read Calendar events, offered detail, calendars, busy "
            "time, or openings. Use more to continue; omit filters. "
            "Use owner-local windows and shown positions. "
            "Screen holds details; model sees counts. No writes."
        ),
        handler=_read_calendar,
    ),
)
