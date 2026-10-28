"""Synthetic Google connection store and publication fixtures."""

from datetime import UTC, datetime
from types import SimpleNamespace
from unittest.mock import AsyncMock, Mock

from hushh_mcp.services.google_connection_service import GoogleConnectionService
from hushh_mcp.services.google_oauth_attempt import connection_generation
from tests.google_oauth_test_support import TransactionEngine


class _Db:
    def __init__(
        self,
        existing=None,
        *,
        accept_connection=True,
        accept_grant=True,
        grants=None,
        additional_subjects=None,
    ):
        self.existing = existing
        self.grants = grants or []
        self.accept_connection = accept_connection
        self.accept_grant = accept_grant
        self.additional_subjects = additional_subjects or []
        self.calls = []
        self.engine = TransactionEngine(self)

    def execute_raw(self, sql, params=None):
        self.calls.append((sql, params))
        if "SELECT * FROM google_provider_connections" in sql:
            return SimpleNamespace(data=[self.existing] if self.existing else [])
        if "SELECT service, scope_csv FROM google_service_grants" in sql:
            return SimpleNamespace(
                data=[{"service": "calendar", "scope_csv": value} for value in self.grants]
            )
        if "SELECT 1 FROM google_calendar_additional_accounts" in sql:
            return SimpleNamespace(
                data=[{"present": 1}] if params["subject"] in self.additional_subjects else []
            )
        if "SELECT COUNT(*) FROM google_calendar_additional_accounts" in sql:
            return SimpleNamespace(data=[{"count": len(self.additional_subjects)}])
        if "INSERT INTO google_provider_connections" in sql:
            return SimpleNamespace(data=[{"user_id": "owner"}] if self.accept_connection else [])
        if "INSERT INTO google_service_grants" in sql:
            return SimpleNamespace(data=[{"user_id": "owner"}] if self.accept_grant else [])
        return SimpleNamespace(data=[])


def _service(monkeypatch, db, *, subject="google-a"):
    service = GoogleConnectionService(db=db)
    monkeypatch.setattr(service, "_userinfo", AsyncMock(return_value={"sub": subject}))
    monkeypatch.setattr(service, "_decrypt", Mock(return_value="synthetic-old-refresh"))
    monkeypatch.setattr(
        service, "_encrypt", Mock(return_value={"ciphertext": "new", "iv": "iv", "tag": "tag"})
    )
    monkeypatch.setattr(service, "status", AsyncMock(return_value={"connected": True}))
    # These cases exercise publication against a synthetic connection store;
    # account presentation is covered separately with its own complete rows.
    monkeypatch.setattr(
        service,
        "calendar_accounts_status",
        AsyncMock(
            return_value={
                "connected": True,
                "status": "connected",
                "accounts": [{"account_id": "default", "connected": True}],
                "account_limit": 3,
            }
        ),
    )
    return service


async def _store(service, *, token=None, level="read"):
    return await service._store_authorized_connection(
        user_id="owner",
        token=token
        if token is not None
        else {
            "access_token": "synthetic-access",
            "refresh_token": "synthetic-refresh",
            "scope": " ".join(GoogleConnectionService.scopes("calendar", level)),
        },
        service="calendar",
        requested_scopes=GoogleConnectionService.scopes("calendar", level),
        oauth_started_at=datetime(2026, 9, 22, tzinfo=UTC),
        attempt_id="synthetic-attempt",
        expected_generation=connection_generation(service.db.existing),
    )
