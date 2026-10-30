"""Advisory Gmail send readiness for One's typed-chat Gmail draft.

The draft result says whether Gmail can send, so the card can offer Connect,
Reconnect or Allow sending before the owner reaches Send. It is advisory:
prepare stays the authority when the owner taps Send.
"""

from __future__ import annotations

import asyncio
import logging
from typing import Literal

from hushh_mcp.services.gmail_receipts_service import GmailApiError, get_gmail_receipts_service

logger = logging.getLogger(__name__)

GmailSendReadiness = Literal[
    "ready",
    "connect_required",
    "reconnect_required",
    "send_permission_required",
    "send_disabled",
    "unknown",
]

_READINESS_BY_CODE: dict[str, GmailSendReadiness] = {
    "GMAIL_NOT_CONNECTED": "connect_required",
    "GMAIL_SEND_PERMISSION_REQUIRED": "send_permission_required",
    "GMAIL_SEND_DISABLED": "send_disabled",
}


async def _send_readiness(owner: str) -> GmailSendReadiness:
    service = get_gmail_receipts_service()
    try:
        await service.assert_send_ready(user_id=owner)
    except GmailApiError as exc:
        code = str(exc.code or "")
        # Admission reports a connection that needs re-authorisation as not
        # connected; the status read tells it apart from no connection at all.
        if code == "GMAIL_NOT_CONNECTED":
            status = await service.get_status(user_id=owner)
            if status.get("connection_state") == "needs_reauth":
                return "reconnect_required"
        return _READINESS_BY_CODE.get(code, "unknown")
    return "ready"


async def gmail_send_readiness(user_id: str, *, timeout_seconds: float = 2.5) -> GmailSendReadiness:
    """Advisory Gmail send state from DB-only reads that share one time budget.

    The admission check runs first; only when it reports Gmail not connected
    does a status read separate ``reconnect_required`` from
    ``connect_required``. Neither read calls Google or refreshes or returns a
    token. Never raises: any failure other than a known admission code,
    including the timeout, is ``unknown``.
    """
    owner = str(user_id or "").strip()
    if not owner:
        return "unknown"
    readiness = asyncio.ensure_future(_send_readiness(owner))
    try:
        # Shielded, the budget holds even when a read defers cancellation: the
        # status read's account check finishes its database call first.
        return await asyncio.wait_for(asyncio.shield(readiness), timeout=timeout_seconds)
    except Exception as exc:  # noqa: BLE001 - advisory readiness never blocks a draft
        logger.warning("one.gmail_send_readiness outcome=unknown error=%s", type(exc).__name__)
        return "unknown"
    finally:
        readiness.cancel()
