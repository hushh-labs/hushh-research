"""Read/compose credential and exact execution-grant seams for Gmail.

GmailReceiptsService remains the public credential owner. These helpers operate
only on that injected owner, preserve its scope checks and never cache tokens.
"""

from __future__ import annotations

import asyncio
import hashlib
import json
from typing import Any

from hushh_mcp.services.gmail_receipts_service import (
    _GMAIL_COMPOSE_SCOPE,
    _GMAIL_READONLY_SCOPE,
    GmailApiError,
)


async def get_compose_access_token(gmail: Any, *, user_id: str) -> str:
    """Resolve a provider-draft token only for the connected owner."""
    row = await asyncio.to_thread(gmail._fetch_connection_row, user_id=user_id)
    if not row or gmail._derive_connection_state(row) != "connected":
        raise GmailApiError("Connect Gmail first", status_code=409, code="GMAIL_NOT_CONNECTED")
    if _GMAIL_COMPOSE_SCOPE not in gmail._granted_scopes(row):
        raise GmailApiError(
            "Enable Gmail drafts before saving a draft.",
            status_code=409,
            code="GMAIL_COMPOSE_PERMISSION_REQUIRED",
        )
    access_token, current = await gmail._ensure_access_token(user_id=user_id)
    if _GMAIL_COMPOSE_SCOPE not in gmail._granted_scopes(current):
        raise GmailApiError(
            "Enable Gmail drafts before saving a draft.",
            status_code=409,
            code="GMAIL_COMPOSE_PERMISSION_REQUIRED",
        )
    return access_token


async def get_read_access_token(gmail: Any, *, user_id: str, force_refresh: bool = False) -> str:
    """Admit owner-bound Gmail reads without granting send authority.

    ``force_refresh`` is for a caller whose token Google just rejected
    before its recorded expiry; it never widens the granted scopes.
    """

    await gmail.assert_read_ready(user_id=user_id)
    if force_refresh:
        access_token, current_row = await gmail._ensure_access_token(
            user_id=user_id, force_refresh=True
        )
    else:
        access_token, current_row = await gmail._ensure_access_token(user_id=user_id)
    if _GMAIL_READONLY_SCOPE not in gmail._granted_scopes(current_row):
        raise GmailApiError(
            "Reconnect Gmail to grant email reading permission.",
            status_code=409,
            code="GMAIL_READ_PERMISSION_REQUIRED",
        )
    return access_token


def _execution_read_binding(
    gmail: Any, user_id: str, row: dict[str, Any] | None
) -> tuple[str, ...] | None:
    if (
        not row
        or row.get("status") != "connected"
        or row.get("revoked") is not False
        or _GMAIL_READONLY_SCOPE not in gmail._granted_scopes(row)
        or not row.get("google_sub")
        or not row.get("connected_at")
    ):
        return None
    observation = gmail._refresh_observation(row)
    if not all(observation.values()):
        return None
    revision = hashlib.sha256(
        json.dumps(
            [sorted(gmail._granted_scopes(row)), observation], sort_keys=True, default=str
        ).encode()
    ).hexdigest()
    return (user_id, "gmail", str(row["google_sub"]), str(row["connected_at"]), revision)


async def read_execution_grant_binding(gmail: Any, *, user_id: str) -> tuple[str, ...] | None:
    """Credential generation without unrelated receipt-sync xmin changes."""
    await gmail.assert_read_ready(user_id=user_id)
    row = await asyncio.to_thread(gmail._fetch_connection_row, user_id=user_id)
    return gmail._execution_read_binding(user_id, row)


async def get_bound_read_access_token(
    gmail: Any, *, user_id: str, compose: bool = False
) -> tuple[str, tuple[str, ...]]:
    """Bind the token's actual row to its live grant, allowing normal refresh.

    _ensure_access_token returns the post-refresh row. Never pair an old
    account's token with an observation made after reconnecting another one.
    """
    await gmail.assert_read_ready(user_id=user_id)
    token, token_row = await gmail._ensure_access_token(user_id=user_id)
    needed = _GMAIL_COMPOSE_SCOPE if compose else _GMAIL_READONLY_SCOPE
    if needed not in gmail._granted_scopes(token_row):
        raise GmailApiError(
            "Gmail permission is required",
            status_code=409,
            code="GMAIL_COMPOSE_PERMISSION_REQUIRED"
            if compose
            else "GMAIL_READ_PERMISSION_REQUIRED",
        )
    binding = gmail._execution_read_binding(user_id, token_row)
    if not binding or await gmail.read_execution_grant_binding(user_id=user_id) != binding:
        raise GmailApiError(
            "Gmail connection changed", status_code=409, code="GMAIL_CONNECTION_CHANGED"
        )
    return token, binding
