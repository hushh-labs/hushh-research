"""Record the Mail grant a Calendar consent returned for the primary account.

The primary account's Mail credential lives in the legacy Mail connection, not
with Calendar. When one Google consent returns Gmail scope for that same
account, this records it there so Follow-ups needs no second Google screen.

It records a grant and nothing else. It never starts a receipt sync, a mailbox
watch or a follow-up scan: those stay behind their own explicit opt-ins. It
never replaces a mailbox that belongs to a different Google account, never
narrows permissions the person already gave Mail, and reuses a valid existing
grant without writing. Any refusal leaves Calendar connected and reports Mail
as unavailable.
"""

from __future__ import annotations

import asyncio
import logging
from datetime import UTC, datetime, timedelta
from typing import Any

from hushh_mcp.services.google_calendar_authorization import (
    CALENDAR_MAIL_READ_SCOPE,
    CALENDAR_MAIL_SEND_SCOPE,
    MailGrant,
)

logger = logging.getLogger(__name__)

_ADOPT_SQL = """
INSERT INTO kai_gmail_connections (
    user_id, google_email, google_sub, scope_csv, status,
    refresh_token_ciphertext, refresh_token_iv, refresh_token_tag,
    access_token_ciphertext, access_token_iv, access_token_tag, access_token_expires_at,
    auto_sync_enabled, send_enabled, revoked, watch_status, bootstrap_state,
    status_refreshed_at, connected_at, disconnected_at, token_updated_at,
    last_sync_status, last_sync_error, updated_at
) VALUES (
    :user_id, :google_email, :google_sub, :scope_csv, 'connected',
    :refresh_token_ciphertext, :refresh_token_iv, :refresh_token_tag,
    :access_token_ciphertext, :access_token_iv, :access_token_tag, :access_token_expires_at,
    FALSE, :send_enabled, FALSE, 'not_configured', 'idle',
    NOW(), NOW(), NULL, NOW(),
    'idle', NULL, NOW()
)
ON CONFLICT (user_id) DO UPDATE SET
    google_email = COALESCE(EXCLUDED.google_email, kai_gmail_connections.google_email),
    google_sub = COALESCE(EXCLUDED.google_sub, kai_gmail_connections.google_sub),
    scope_csv = EXCLUDED.scope_csv,
    status = 'connected',
    refresh_token_ciphertext = EXCLUDED.refresh_token_ciphertext,
    refresh_token_iv = EXCLUDED.refresh_token_iv,
    refresh_token_tag = EXCLUDED.refresh_token_tag,
    access_token_ciphertext = EXCLUDED.access_token_ciphertext,
    access_token_iv = EXCLUDED.access_token_iv,
    access_token_tag = EXCLUDED.access_token_tag,
    access_token_expires_at = EXCLUDED.access_token_expires_at,
    send_enabled = EXCLUDED.send_enabled,
    revoked = FALSE,
    connected_at = COALESCE(kai_gmail_connections.connected_at, NOW()),
    disconnected_at = NULL,
    token_updated_at = NOW(),
    status_refreshed_at = NOW(),
    updated_at = NOW()
WHERE kai_gmail_connections.disconnected_at IS NULL
   OR kai_gmail_connections.disconnected_at <= :oauth_started_at
RETURNING user_id
"""


def _text(value: object | None) -> str:
    return str(value or "").strip()


async def adopt_primary_mail_grant(
    gmail: Any,
    *,
    user_id: str,
    subject: str,
    email: str,
    token: dict[str, Any],
    mail: MailGrant,
    same_client: bool,
    oauth_started_at: datetime,
) -> str:
    """Return `mail.outcome`, or `unavailable` when granted but not recordable."""
    if not mail.read:
        return mail.outcome
    try:
        return await _adopt(
            gmail,
            user_id=user_id,
            subject=subject,
            email=email,
            token=token,
            mail=mail,
            same_client=same_client,
            oauth_started_at=oauth_started_at,
        )
    except Exception as exc:
        # Calendar is already connected. Keep the failure class, never a
        # provider payload or credential envelope, out of the log.
        logger.warning("calendar.mail.adopt_failed reason=%s", type(exc).__name__)
        return "unavailable"


async def _adopt(
    gmail: Any,
    *,
    user_id: str,
    subject: str,
    email: str,
    token: dict[str, Any],
    mail: MailGrant,
    same_client: bool,
    oauth_started_at: datetime,
) -> str:
    # A refresh token minted for one OAuth client cannot be refreshed by another.
    if not same_client or not gmail.is_configured():
        return "unavailable"
    granted = {value for value in _text(token.get("scope")).split() if value}
    existing = await asyncio.to_thread(gmail._fetch_connection_row, user_id=user_id)
    if existing and gmail._derive_connection_state(existing) == "connected":
        if _text(existing.get("google_sub")) != subject:
            return "unavailable"
        have = gmail._granted_scopes(existing)
        if CALENDAR_MAIL_READ_SCOPE in have and (not mail.send or CALENDAR_MAIL_SEND_SCOPE in have):
            return "granted"
        if not have <= granted:
            return "unavailable"
    refresh_token = _text(token.get("refresh_token"))
    access_token = _text(token.get("access_token"))
    if not refresh_token or not access_token:
        return "unavailable"
    refresh = gmail._encrypt_token(refresh_token)
    access = gmail._encrypt_token(access_token)
    expires_in = max(60, int(token.get("expires_in") or 3600))
    written = await gmail._publish_connection(
        _ADOPT_SQL,
        {
            "user_id": user_id,
            "google_email": _text(email).lower() or None,
            "google_sub": subject,
            "scope_csv": " ".join(sorted(granted)),
            "refresh_token_ciphertext": refresh["ciphertext"],
            "refresh_token_iv": refresh["iv"],
            "refresh_token_tag": refresh["tag"],
            "access_token_ciphertext": access["ciphertext"],
            "access_token_iv": access["iv"],
            "access_token_tag": access["tag"],
            "access_token_expires_at": datetime.now(UTC) + timedelta(seconds=expires_in),
            "send_enabled": mail.send,
            "oauth_started_at": oauth_started_at,
        },
    )
    return "granted" if written.data else "unavailable"
