"""Credential owners expose exact, read-only grant observations to Chat."""

from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest

from hushh_mcp.services.gmail_receipts_service import GmailApiError, GmailReceiptsService
from hushh_mcp.services.google_connection_service import GoogleConnectionService


@pytest.mark.asyncio
async def test_gmail_binding_changes_on_token_refresh_and_never_returns_credentials(monkeypatch):
    row = {
        "google_sub": "account-a",
        "scope_csv": "https://www.googleapis.com/auth/gmail.readonly",
        "status": "connected",
        "revoked": False,
        "connected_at": "connected-a",
        "grant_revision": "21",
    }
    service = GmailReceiptsService()
    monkeypatch.setattr(service, "is_configured", lambda: True)
    monkeypatch.setattr(service, "_fetch_connection_row", lambda *, user_id: row)
    query = AsyncMock(return_value=SimpleNamespace(data=[row]))
    monkeypatch.setattr(service, "_execute_raw_async", query)

    first = await service.read_grant_binding(user_id="owner-a")
    assert first == ("owner-a", "gmail", "account-a", "connected-a", "21")
    row["grant_revision"] = "22"  # xmin changes on token refresh as well as grant changes.
    assert await service.read_grant_binding(user_id="owner-a") != first
    assert "xmin::text" in query.call_args.args[0]
    assert "access_token" not in str(first)


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "field,value",
    [("revoked", None), ("google_sub", None), ("connected_at", None), ("grant_revision", None)],
)
async def test_gmail_binding_fails_closed_on_nullable_or_missing_authority(
    monkeypatch, field, value
):
    row = {
        "google_sub": "account-a",
        "scope_csv": "https://www.googleapis.com/auth/gmail.readonly",
        "status": "connected",
        "revoked": False,
        "connected_at": "connected-a",
        "grant_revision": "21",
    }
    row[field] = value
    service = GmailReceiptsService()
    monkeypatch.setattr(service, "is_configured", lambda: True)
    monkeypatch.setattr(service, "_fetch_connection_row", lambda *, user_id: row)
    monkeypatch.setattr(
        service, "_execute_raw_async", AsyncMock(return_value=SimpleNamespace(data=[row]))
    )
    assert await service.read_grant_binding(user_id="owner-a") is None


@pytest.mark.asyncio
async def test_gmail_binding_requires_read_scope_even_when_send_scope_remains(monkeypatch):
    row = {
        "status": "connected",
        "revoked": False,
        "scope_csv": "https://www.googleapis.com/auth/gmail.send",
    }
    service = GmailReceiptsService()
    monkeypatch.setattr(service, "is_configured", lambda: True)
    monkeypatch.setattr(service, "_fetch_connection_row", lambda *, user_id: row)
    query = AsyncMock()
    monkeypatch.setattr(service, "_execute_raw_async", query)
    with pytest.raises(GmailApiError):
        await service.read_grant_binding(user_id="owner-a")
    query.assert_not_awaited()


@pytest.mark.asyncio
async def test_google_binding_survives_token_refresh_but_fences_reconnect_and_grant_changes():
    row = {
        "provider_subject": "account-a",
        "connection_status": "connected",
        "connected_at": "connected-a",
        "connection_revision": "11",
        "refresh_token_ciphertext": "refresh-envelope-a",
        "grant_status": "connected",
        "scope_csv": "https://www.googleapis.com/auth/drive.readonly",
        "grant_revision": "12",
    }
    db = SimpleNamespace(execute_raw=lambda sql, params: SimpleNamespace(data=[row]))
    service = GoogleConnectionService(db=db)
    first = await service.read_grant_binding(user_id="owner-a", service="drive")
    assert first is not None
    assert first[:4] == ("owner-a", "drive", "account-a", "connected-a")
    assert len(first[4]) == 64 and first[5] == "12"
    assert "refresh-envelope-a" not in str(first)
    row["connection_revision"] = "13"  # Normal access-token refresh changes only the row revision.
    assert await service.read_grant_binding(user_id="owner-a", service="drive") == first
    row["refresh_token_ciphertext"] = "refresh-envelope-b"  # Same-account reauthorization.
    assert await service.read_grant_binding(user_id="owner-a", service="drive") != first
    row["refresh_token_ciphertext"] = "refresh-envelope-a"
    row["grant_revision"] = "14"
    assert await service.read_grant_binding(user_id="owner-a", service="drive") != first


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "field,value",
    [
        ("provider_subject", None),
        ("connected_at", None),
        ("refresh_token_ciphertext", None),
        ("grant_revision", None),
        ("grant_status", None),
        ("connection_status", None),
        ("scope_csv", "https://www.googleapis.com/auth/calendar.events"),
    ],
)
async def test_google_binding_fails_closed_on_missing_read_authority(field, value):
    row = {
        "provider_subject": "account-a",
        "connection_status": "connected",
        "connected_at": "connected-a",
        "connection_revision": "11",
        "refresh_token_ciphertext": "refresh-envelope-a",
        "grant_status": "connected",
        "scope_csv": "https://www.googleapis.com/auth/calendar.events.readonly https://www.googleapis.com/auth/calendar.freebusy",
        "grant_revision": "12",
    }
    row[field] = value
    db = SimpleNamespace(execute_raw=lambda sql, params: SimpleNamespace(data=[row]))
    assert (
        await GoogleConnectionService(db=db).read_grant_binding(
            user_id="owner-a", service="calendar"
        )
        is None
    )


@pytest.mark.asyncio
@pytest.mark.parametrize("event_scope", ["calendar.events", "calendar.events.readonly"])
async def test_calendar_manage_and_read_grants_both_allow_read_binding(event_scope):
    row = {
        "provider_subject": "account-a",
        "connection_status": "connected",
        "connected_at": "connected-a",
        "refresh_token_ciphertext": "refresh-envelope",
        "grant_status": "connected",
        "grant_revision": "12",
        "scope_csv": f"https://www.googleapis.com/auth/{event_scope} https://www.googleapis.com/auth/calendar.freebusy",
    }
    db = SimpleNamespace(execute_raw=lambda sql, params: SimpleNamespace(data=[row]))
    service = GoogleConnectionService(db=db)
    assert await service.read_grant_binding(user_id="owner-a", service="calendar") is not None
    row["scope_csv"] = "https://www.googleapis.com/auth/calendar.freebusy"
    assert await service.read_grant_binding(user_id="owner-a", service="calendar") is None
