"""
mcp_modules/tools/gmail_calendar_tools.py

Read-only Gmail receipts + Google Calendar MCP tools, following the RIA
consent_token + VAULT_OWNER pattern (see ria_read_tools.py). Both reuse
existing, already-consented OAuth grants (gmail.readonly,
calendar.events.readonly) -- no new consent screen is required for these.

Hard rule: never import support_email_service or one_email_kyc_service here.
Both operate a domain-wide-delegation, app-owned mailbox (one@hushh.ai-style)
that is completely unrelated to the signed-in owner's personal Gmail OAuth
token, and their names are easy to reach for by mistake while grepping for
"gmail"/"email" services.
"""

from __future__ import annotations

import json
import logging
from typing import Any

from mcp.types import TextContent

from hushh_mcp.consent.token import validate_token_with_db
from hushh_mcp.constants import ConsentScope
from hushh_mcp.services.gmail_receipts_service import get_gmail_receipts_service
from hushh_mcp.services.google_calendar_service import get_google_calendar_service
from hushh_mcp.services.google_connection_service import GoogleConnectionError

logger = logging.getLogger("hushh-mcp-server")


async def _authorize_user(user_id: str, consent_token: str) -> tuple[bool, str | None]:
    valid, reason, payload = await validate_token_with_db(consent_token, ConsentScope.VAULT_OWNER)
    if not valid or payload is None:
        return False, reason
    if payload.user_id != user_id:
        return False, "token_user_mismatch"
    return True, None


def _ok(payload: dict[str, Any]) -> list[TextContent]:
    return [TextContent(type="text", text=json.dumps(payload, default=str))]


async def handle_list_gmail_receipts(args: dict[str, Any]) -> list[TextContent]:
    """List the caller's own pre-synced Gmail purchase-receipt records.

    Reads the structured kai_gmail_receipts table (merchant/order/amount/date);
    never fetches raw email bodies. Reuses the existing gmail.readonly OAuth
    grant -- no new consent screen.
    """
    user_id = str(args.get("user_id") or "").strip()
    consent_token = str(args.get("consent_token") or "").strip()
    if not user_id or not consent_token:
        return _ok({"status": "error", "error": "user_id and consent_token are required"})

    allowed, reason = await _authorize_user(user_id, consent_token)
    if not allowed:
        return _ok({"status": "forbidden", "reason": reason})

    page = int(args.get("page") or 1)
    per_page = int(args.get("per_page") or 25)
    result = await get_gmail_receipts_service().list_receipts(
        user_id=user_id, page=page, per_page=per_page
    )
    return _ok({"status": "ok", **result})


async def handle_list_upcoming_calendar_events(args: dict[str, Any]) -> list[TextContent]:
    """List the caller's own upcoming Google Calendar events.

    Calls GoogleCalendarService.list_events(), which already requests
    calendar access="read" internally. The underlying _event_summary()
    includes description/location/attendees (with emails) -- this handler
    MUST redact the response down to title/start/end/status only before it
    ever reaches the model.
    """
    user_id = str(args.get("user_id") or "").strip()
    consent_token = str(args.get("consent_token") or "").strip()
    if not user_id or not consent_token:
        return _ok({"status": "error", "error": "user_id and consent_token are required"})

    allowed, reason = await _authorize_user(user_id, consent_token)
    if not allowed:
        return _ok({"status": "forbidden", "reason": reason})

    start_at = str(args.get("start_at") or "").strip()
    end_at = str(args.get("end_at") or "").strip()
    max_results = int(args.get("max_results") or 20)
    if not start_at or not end_at:
        return _ok({"status": "error", "error": "start_at and end_at are required"})

    try:
        result = await get_google_calendar_service().list_events(
            user_id=user_id,
            start_at=start_at,
            end_at=end_at,
            max_results=max_results,
        )
    except GoogleConnectionError as exc:
        return _ok({"status": "error", "error": str(exc)})

    # Mandatory redaction -- never forward description/location/attendees.
    events = [
        {
            "title": event.get("title"),
            "start": event.get("start"),
            "end": event.get("end"),
            "status": event.get("status"),
        }
        for event in (result.get("events") or [])
    ]
    return _ok({"status": "ok", "events": events, "time_zone": result.get("time_zone")})
