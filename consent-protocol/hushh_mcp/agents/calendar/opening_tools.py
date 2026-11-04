"""Bounded Board availability and private positional follow-ups for Calendar Chat."""

from __future__ import annotations

import time
from datetime import timedelta
from typing import Any

from google.adk.tools.tool_context import ToolContext
from pydantic import ValidationError

from hushh_mcp.agents.calendar.read_offer import (
    STATE_OPENING_OFFER,
    CalendarOpeningOffer,
    CalendarSharedOpeningOffer,
)
from hushh_mcp.services.calendar_opening_selection import instant
from hushh_mcp.services.google_connection_service import GoogleConnectionError


async def calendar_shared_free_slots(
    tool_context: ToolContext,
    date: str,
    duration_minutes: int,
    limit: int = 3,
    time_zone: str | None = None,
) -> dict[str, Any]:
    """Find 1–20 shared slots across ALL connected accounts for one civil date.

    Ask for a missing date/duration; never invent working hours. Board supports
    15/30/60 minutes. This reads all included calendars, not invitee availability.
    No destination account is required for this read. Booking needs an exact
    verified destination and the usual explicit confirmation.
    """
    from hushh_mcp.agents.calendar import tools

    tool_context.state[STATE_OPENING_OFFER] = None

    async def call(user_id: str, board: Any, _account_id: str) -> dict[str, Any]:
        if isinstance(limit, bool) or not isinstance(limit, int) or not 1 <= limit <= 20:
            raise GoogleConnectionError("Choose one to twenty slots", status_code=422)
        result = await board.availability(
            user_id=user_id,
            date=date,
            time_zone=time_zone
            if time_zone is not None
            else str(tool_context.state.get("hussh:timezone") or "UTC"),
            duration_minutes=duration_minutes,
        )
        # Explicit projection: neither free/busy details nor grants enter the model.
        accounts = [
            {
                key: item[key]
                for key in ("account_id", "account_email", "status", "calendar_ids", "reason_code")
                if key in item
            }
            for item in result["accounts"]
        ]
        public = {
            "status": "ok" if result["complete"] else "incomplete",
            "complete": result["complete"],
            "date": result["date"],
            "time_zone": result["time_zone"],
            "duration_minutes": duration_minutes,
            "accounts": accounts,
            "openings": [],
        }
        if not result["complete"]:
            return {
                **public,
                "message": "Some accounts could not be checked. No shared free time is verified.",
            }
        slots = [
            {
                "start_at": window["start_at"],
                "end_at": (
                    instant(window["start_at"]) + timedelta(minutes=duration_minutes)
                ).isoformat(),
                "available_until": window["end_at"],
            }
            for window in result["shared_free_windows"][:limit]
        ]
        if not slots:
            return public
        offer = CalendarSharedOpeningOffer.model_validate(
            {
                "owner_id": user_id,
                "conversation_id": tools._conversation_id(tool_context),
                "created_at_ms": int(time.time() * 1000),
                "window": {
                    "query_start": result["time_min"],
                    "query_end": result["time_max"],
                    "duration_minutes": duration_minutes,
                    "time_zone": result["time_zone"],
                    "board_accounts": result["board_accounts"],
                },
                "slots": slots,
            }
        )
        tool_context.state[STATE_OPENING_OFFER] = offer.model_dump(mode="json")
        return {
            **public,
            "openings": [
                dict(ordinal=index, **slot.model_dump())
                for index, slot in enumerate(offer.slots, 1)
            ],
            "bounded": len(result["shared_free_windows"]) > limit,
        }

    return await tools._run_calendar_read(
        tool_context, call, shared_accounts=True, display_time_zone=time_zone
    )


def _shared_offer(tool_context: ToolContext, user_id: str) -> CalendarSharedOpeningOffer | None:
    from hushh_mcp.agents.calendar import tools

    raw = tool_context.state.get(STATE_OPENING_OFFER)
    if not isinstance(raw, dict) or "board_accounts" not in (raw.get("window") or {}):
        return None
    try:
        offer = CalendarSharedOpeningOffer.model_validate(raw)
        if not offer.current(
            owner_id=user_id, conversation_id=tools._conversation_id(tool_context)
        ):
            raise ValueError("Expired source")
    except (ValidationError, TypeError, ValueError) as exc:
        raise GoogleConnectionError("Show available slots again.", status_code=422) from exc
    return offer


async def _verify_shared_source(offer: CalendarSharedOpeningOffer, user_id: str) -> None:
    from hushh_mcp.one_adk.pod_connector_tools import calendar_reads_via_door
    from hushh_mcp.services.pod_google_connections import calendar_runs_locally

    if calendar_reads_via_door() or calendar_runs_locally():
        raise GoogleConnectionError(
            "Cross-account Calendar is unavailable in this runtime", status_code=422
        )
    from hushh_mcp.services.google_calendar_booking import _verify_board_snapshot
    from hushh_mcp.services.google_connection_service import get_google_connection_service

    owner = get_google_connection_service()
    status = await owner.calendar_accounts_status(user_id=user_id)
    accounts = status.get("accounts", [])
    if [(item.get("account_id"), item.get("google_email")) for item in accounts] != [
        (item.account_id, item.account_email) for item in offer.window.board_accounts
    ] or any(not item.get("connected") for item in accounts):
        raise GoogleConnectionError(
            "Calendar accounts changed. Check openings again.", status_code=409
        )
    await _verify_board_snapshot(
        owner=owner,
        user_id=user_id,
        status_reader=owner.calendar_accounts_status,
        accounts=accounts,
        snapshots=[item.model_dump() for item in offer.window.board_accounts],
        reviewed=None,
    )


async def select_shared_opening(
    tool_context: ToolContext, *, user_id: str, payload: dict[str, Any], ordinal: int
) -> tuple[str, ...] | None:
    """Resolve a private source without manufacturing a destination or new times."""
    from hushh_mcp.agents.calendar import tools

    offer = _shared_offer(tool_context, user_id)
    if offer is None:
        return None
    slot = offer.slot_at(ordinal)
    if (
        slot is None
        or payload.get("start_at")
        or payload.get("end_at")
        or payload.get("calendar_id") != "primary"
    ):
        raise GoogleConnectionError(
            "Choose a listed slot without replacing its target or times.", status_code=422
        )
    await _verify_shared_source(offer, user_id)
    accounts = offer.window.board_accounts
    destination = payload.get("account_id")
    if destination is None:
        if len(accounts) > 1:
            raise tools._AccountSelectionRequired(
                [
                    {"account_id": item.account_id, "account_email": item.account_email}
                    for item in accounts
                ]
            )
        destination = accounts[0].account_id
    selected = next((item for item in accounts if item.account_id == destination), None)
    if selected is None:
        raise GoogleConnectionError(
            "Choose a destination from the verified accounts.", status_code=422
        )
    payload.update(
        account_id=destination,
        start_at=slot.start_at,
        end_at=slot.end_at,
        time_zone=offer.window.time_zone,
        shared_opening_selection={
            **offer.window.model_dump(mode="json"),
            "slot": slot.model_dump(mode="json"),
            "offer_created_at_ms": offer.created_at_ms,
        },
    )
    return tuple(selected.binding)


async def calendar_opening_detail(tool_context: ToolContext, ordinal: int) -> dict[str, Any]:
    """Show an exact previously offered slot by position. Never prepares a booking."""
    from hushh_mcp.agents.calendar import tools

    async def call(user_id: str, _service: Any, _account_id: str) -> dict[str, Any]:
        shared = _shared_offer(tool_context, user_id)
        if shared is not None:
            await _verify_shared_source(shared, user_id)
            offer = shared
            accounts = [
                {
                    "account_id": item.account_id,
                    "account_email": item.account_email,
                    "calendar_ids": item.calendar_ids,
                }
                for item in shared.window.board_accounts
            ]
        else:
            try:
                offer = CalendarOpeningOffer.model_validate(
                    tool_context.state.get(STATE_OPENING_OFFER)
                )
            except (ValidationError, TypeError, ValueError) as exc:
                raise GoogleConnectionError("Show available slots again.", status_code=422) from exc
            if not offer.current(
                owner_id=user_id,
                conversation_id=tools._conversation_id(tool_context),
                grant_binding=await tools._read_binding(
                    tools._calendar_service(offer.account_id), user_id
                ),
            ):
                raise GoogleConnectionError("Show available slots again.", status_code=422)
            accounts = [{"account_id": offer.account_id, "calendar_ids": offer.window.calendar_ids}]
        slot = offer.slot_at(ordinal)
        if slot is None:
            raise GoogleConnectionError("Choose one of the listed slots.", status_code=422)
        return {
            "status": "ok",
            "ordinal": ordinal,
            **slot.model_dump(),
            "time_zone": offer.window.time_zone,
            "accounts": accounts,
            "checked_at_ms": offer.created_at_ms,
            "message": "Availability will be checked again before booking review.",
        }

    # Account selection belongs to the source, not the latest unrelated read.
    # A default-account owner-cloud offer keeps its existing local read port.
    raw = tool_context.state.get(STATE_OPENING_OFFER)
    if (
        isinstance(raw, dict)
        and isinstance(raw.get("window"), dict)
        and "board_accounts" in raw["window"]
    ):
        return await tools._run_calendar_read(tool_context, call, shared_accounts=True)
    try:
        candidate = CalendarOpeningOffer.model_validate(raw)
    except (ValidationError, TypeError, ValueError):
        return {"status": "input_required", "message": "Show available slots again."}
    return await tools._run_calendar_read(
        tool_context, call, account_id=candidate.account_id, owner_local_only=True
    )
