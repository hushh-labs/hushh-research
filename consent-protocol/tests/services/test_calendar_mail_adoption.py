"""The primary account's Mail grant is recorded from a Calendar consent, and nothing more."""

from __future__ import annotations

from datetime import UTC, datetime
from types import SimpleNamespace
from unittest.mock import AsyncMock, Mock

import pytest

from hushh_mcp.services.calendar_mail_adoption import adopt_primary_mail_grant
from hushh_mcp.services.google_calendar_authorization import (
    CALENDAR_MAIL_READ_SCOPE,
    CALENDAR_MAIL_SEND_SCOPE,
    mail_grant,
)

CALENDAR = "https://www.googleapis.com/auth/calendar.events"
REQUESTED = (CALENDAR, CALENDAR_MAIL_READ_SCOPE, CALENDAR_MAIL_SEND_SCOPE)


def _gmail(existing=None, *, configured=True, written=True):
    gmail = Mock()
    gmail.is_configured.return_value = configured
    gmail._fetch_connection_row.return_value = existing
    gmail._derive_connection_state.side_effect = lambda row: (
        "connected" if row and row.get("status") == "connected" and not row.get("revoked") else "x"
    )
    gmail._granted_scopes.side_effect = lambda row: set((row or {}).get("scope_csv", "").split())
    gmail._encrypt_token.return_value = {"ciphertext": "c", "iv": "i", "tag": "t"}
    gmail._publish_connection = AsyncMock(
        return_value=SimpleNamespace(data=[{"user_id": "o"}] if written else [])
    )
    return gmail


async def _adopt(
    gmail, *, scope=" ".join(REQUESTED), refresh="r", same_client=True, subject="sub-a"
):
    token = {"access_token": "a", "refresh_token": refresh, "scope": scope, "expires_in": 3600}
    return await adopt_primary_mail_grant(
        gmail,
        user_id="o",
        subject=subject,
        email="A@Example.com",
        token=token,
        mail=mail_grant(REQUESTED, scope),
        same_client=same_client,
        oauth_started_at=datetime(2026, 11, 3, tzinfo=UTC),
    )


@pytest.mark.asyncio
async def test_records_a_connected_mail_grant_without_any_background_work():
    gmail = _gmail()
    assert await _adopt(gmail) == "granted"
    sql, params = gmail._publish_connection.await_args.args
    # Consent records a grant; receipt sync, watch and bootstrap stay off.
    assert "FALSE, :send_enabled, FALSE, 'not_configured', 'idle'" in sql
    assert params["send_enabled"] is True and params["google_email"] == "a@example.com"
    gmail.queue_sync.assert_not_called()


@pytest.mark.asyncio
async def test_declined_mail_writes_nothing():
    gmail = _gmail()
    assert await _adopt(gmail, scope=CALENDAR) == "declined"
    gmail._publish_connection.assert_not_awaited()


@pytest.mark.asyncio
async def test_another_accounts_mailbox_is_never_replaced():
    existing = {
        "status": "connected",
        "google_sub": "sub-other",
        "scope_csv": CALENDAR_MAIL_READ_SCOPE,
    }
    gmail = _gmail(existing)
    assert await _adopt(gmail) == "unavailable"
    gmail._publish_connection.assert_not_awaited()


@pytest.mark.asyncio
async def test_a_valid_existing_grant_is_reused_without_a_write():
    existing = {
        "status": "connected",
        "google_sub": "sub-a",
        "scope_csv": f"{CALENDAR_MAIL_READ_SCOPE} {CALENDAR_MAIL_SEND_SCOPE}",
    }
    gmail = _gmail(existing)
    assert await _adopt(gmail) == "granted"
    gmail._publish_connection.assert_not_awaited()


@pytest.mark.asyncio
async def test_existing_mail_permissions_are_never_narrowed():
    kept = "https://www.googleapis.com/auth/gmail.compose"
    existing = {
        "status": "connected",
        "google_sub": "sub-a",
        "scope_csv": f"{CALENDAR_MAIL_READ_SCOPE} {kept}",
    }
    gmail = _gmail(existing)
    assert await _adopt(gmail) == "unavailable"
    gmail._publish_connection.assert_not_awaited()


@pytest.mark.asyncio
@pytest.mark.parametrize("case", ["client", "unconfigured", "no_refresh", "refused", "error"])
async def test_every_other_refusal_leaves_calendar_connected_and_mail_unavailable(case):
    gmail = _gmail(configured=case != "unconfigured", written=case != "refused")
    if case == "error":
        gmail._publish_connection.side_effect = RuntimeError("db detail with secrets")
    outcome = await _adopt(
        gmail, same_client=case != "client", refresh="" if case == "no_refresh" else "r"
    )
    assert outcome == "unavailable"
