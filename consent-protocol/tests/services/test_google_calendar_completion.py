"""An Add account OAuth completion names the grant published by that attempt."""

from datetime import UTC, datetime
from types import SimpleNamespace
from unittest.mock import AsyncMock, Mock

import pytest

from hushh_mcp.services.google_connection_service import GoogleConnectionService
from hushh_mcp.services.google_oauth_attempt import connection_generation
from tests.google_oauth_test_support import TransactionEngine


class _CompletionDb:
    def __init__(self, existing: dict[str, str]):
        self.existing = existing
        self.calls: list[tuple[str, dict | None]] = []
        self.engine = TransactionEngine(self)

    def execute_raw(self, sql: str, params: dict | None = None):
        self.calls.append((sql, params))
        if "SELECT * FROM google_provider_connections" in sql:
            return SimpleNamespace(data=[self.existing])
        if "SELECT 1 FROM google_oauth_attempts" in sql:
            return SimpleNamespace(data=[{"present": 1}])
        if "SELECT provider_subject FROM google_provider_connections" in sql:
            return SimpleNamespace(data=[(self.existing["provider_subject"],)])
        if "INSERT INTO google_provider_connections" in sql:
            return SimpleNamespace(data=[{"user_id": "owner"}])
        if "INSERT INTO google_service_grants" in sql:
            return SimpleNamespace(data=[{"user_id": "owner"}])
        return SimpleNamespace(data=[])


def _service(monkeypatch, db: _CompletionDb, subject: str) -> GoogleConnectionService:
    service = GoogleConnectionService(db=db)
    monkeypatch.setattr(service, "_userinfo", AsyncMock(return_value={"sub": subject}))
    monkeypatch.setattr(service, "_decrypt", Mock(return_value="synthetic-old-refresh"))
    monkeypatch.setattr(
        service,
        "_encrypt",
        Mock(return_value={"ciphertext": "new", "iv": "iv", "tag": "tag"}),
    )
    return service


def _calendar_status(account_id: str, *, default_level: str) -> dict:
    return {
        "connected": True,
        "status": "connected",
        "access_level": default_level,
        "accounts": [
            {
                "account_id": account_id,
                "connected": True,
                "status": "connected",
                "access_level": "manage",
            }
        ],
    }


@pytest.mark.asyncio
async def test_additional_completion_identifies_the_published_account(monkeypatch):
    db = _CompletionDb({"status": "connected", "provider_subject": "google-a"})
    service = _service(monkeypatch, db, "google-b")
    monkeypatch.setattr(
        "hushh_mcp.services.google_connection_service.secrets.token_urlsafe",
        lambda _: "server-selected-account",
    )
    service.calendar_accounts_status = AsyncMock(
        return_value=_calendar_status("server-selected-account", default_level="read")
    )

    result = await service._store_additional_calendar_account(
        user_id="owner",
        token={
            "access_token": "synthetic-access",
            "refresh_token": "synthetic-refresh",
            "scope": " ".join(service.scopes("calendar", "manage")),
        },
        profile={"email": "second@example.com"},
        subject="google-b",
        requested_scopes=service.scopes("calendar", "manage"),
        oauth_started_at=datetime(2026, 10, 21, tzinfo=UTC),
        attempt_id="synthetic-attempt",
    )

    assert result["completed_account_id"] == "server-selected-account"
    assert result["access_level"] == "read"
    assert any("INSERT INTO google_calendar_additional_accounts" in sql for sql, _ in db.calls)


@pytest.mark.asyncio
async def test_add_attempt_selecting_primary_identifies_the_reauthorized_default(monkeypatch):
    db = _CompletionDb({"status": "connected", "provider_subject": "google-a"})
    service = _service(monkeypatch, db, "google-a")
    service.calendar_accounts_status = AsyncMock(
        return_value=_calendar_status("default", default_level="manage")
    )

    result = await service._store_authorized_connection(
        user_id="owner",
        token={
            "access_token": "synthetic-access",
            "refresh_token": "synthetic-refresh",
            "scope": " ".join(service.scopes("calendar", "manage")),
        },
        service="calendar",
        requested_scopes=service.scopes("calendar", "manage"),
        oauth_started_at=datetime(2026, 10, 21, tzinfo=UTC),
        attempt_id="synthetic-attempt",
        expected_generation=connection_generation(db.existing),
        calendar_additional=True,
    )

    assert result["completed_account_id"] == "default"
    assert result["accounts"][0]["access_level"] == "manage"
    assert any("INSERT INTO google_provider_connections" in sql for sql, _ in db.calls)
    assert not any("INSERT INTO google_calendar_additional_accounts" in sql for sql, _ in db.calls)
