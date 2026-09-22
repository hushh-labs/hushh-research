"""Google service grants cannot silently move to another provider account."""

from datetime import UTC, datetime
from types import SimpleNamespace
from unittest.mock import AsyncMock, Mock

import pytest

from hushh_mcp.services.google_connection_service import (
    GoogleConnectionError,
    GoogleConnectionService,
)
from hushh_mcp.services.google_oauth_attempt import connection_generation
from tests.google_oauth_test_support import TransactionEngine


class _Db:
    def __init__(self, existing=None, *, accept_connection=True, accept_grant=True):
        self.existing = existing
        self.accept_connection = accept_connection
        self.accept_grant = accept_grant
        self.calls = []
        self.engine = TransactionEngine(self)

    def execute_raw(self, sql, params=None):
        self.calls.append((sql, params))
        if "SELECT * FROM google_provider_connections" in sql:
            return SimpleNamespace(data=[self.existing] if self.existing else [])
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
    return service


async def _store(service, *, token=None, level="read"):
    return await service._store_authorized_connection(
        user_id="owner",
        token=token
        if token is not None
        else {"access_token": "synthetic-access", "refresh_token": "synthetic-refresh"},
        service="calendar",
        requested_scopes=GoogleConnectionService.scopes("calendar", level),
        oauth_started_at=datetime(2026, 9, 22, tzinfo=UTC),
        attempt_id="synthetic-attempt",
        expected_generation=connection_generation(service.db.existing),
    )


@pytest.mark.asyncio
@pytest.mark.parametrize("with_refresh", [True, False])
async def test_different_provider_account_never_reuses_or_replaces_existing_connection(
    monkeypatch, with_refresh
):
    db = _Db({"status": "connected", "provider_subject": "google-a"})
    service = _service(monkeypatch, db, subject="google-b")
    token = {"access_token": "synthetic-new-access"}
    if with_refresh:
        token["refresh_token"] = "synthetic-new-refresh"
    with pytest.raises(GoogleConnectionError) as error:
        await _store(service, token=token)
    assert error.value.status_code == 409
    service._decrypt.assert_not_called()
    service._encrypt.assert_not_called()
    assert not any("INSERT" in sql for sql, _ in db.calls)


@pytest.mark.asyncio
async def test_verified_same_account_can_reuse_its_refresh_token(monkeypatch):
    db = _Db(
        {
            "status": "connected",
            "provider_subject": "google-a",
            "refresh_token_ciphertext": "old",
            "refresh_token_iv": "iv",
        }
    )
    service = _service(monkeypatch, db)
    await _store(service, token={"access_token": "synthetic-access"})
    service._decrypt.assert_called_once()
    assert service._encrypt.call_args_list[0].args == ("synthetic-old-refresh",)


@pytest.mark.asyncio
@pytest.mark.parametrize("subject", ["google-a", "google-b"])
async def test_disconnected_account_requires_fresh_refresh_token(monkeypatch, subject):
    db = _Db({"status": "disconnected", "provider_subject": "google-a"})
    service = _service(monkeypatch, db, subject=subject)
    with pytest.raises(GoogleConnectionError, match="refresh token"):
        await _store(service, token={"access_token": "synthetic-access"})
    service._decrypt.assert_not_called()
    assert not any("INSERT" in sql for sql, _ in db.calls)


@pytest.mark.asyncio
async def test_explicitly_disconnected_account_can_connect_a_new_subject(monkeypatch):
    db = _Db({"status": "disconnected", "provider_subject": "google-a"})
    service = _service(monkeypatch, db, subject="google-b")
    assert await _store(service) == {"connected": True}
    service._decrypt.assert_not_called()
    writes = [(sql, params) for sql, params in db.calls if "INSERT" in sql]
    assert all(params["subject"] == "google-b" for _, params in writes)
    assert "provider_subject = EXCLUDED.provider_subject" in writes[0][0]
    assert "access_token_ciphertext = :access_ciphertext" in writes[1][0]


@pytest.mark.asyncio
async def test_missing_verified_subject_fails_before_credential_read(monkeypatch):
    db = _Db()
    service = _service(monkeypatch, db, subject="")
    with pytest.raises(GoogleConnectionError, match="could not be verified"):
        await _store(service)
    assert db.calls == []


@pytest.mark.asyncio
async def test_active_legacy_row_without_subject_requires_reconnection(monkeypatch):
    db = _Db({"status": "connected", "provider_subject": None})
    service = _service(monkeypatch, db)
    with pytest.raises(GoogleConnectionError) as error:
        await _store(service)
    assert error.value.status_code == 409
    service._encrypt.assert_not_called()


@pytest.mark.asyncio
@pytest.mark.parametrize("level", ["read", "manage"])
async def test_complete_read_and_manage_permissions_remain_supported(monkeypatch, level):
    service = _service(monkeypatch, _Db())
    assert await _store(service, level=level) == {"connected": True}


@pytest.mark.asyncio
async def test_declined_service_scopes_do_not_create_connection_or_grant(monkeypatch):
    db = _Db()
    service = _service(monkeypatch, db)
    with pytest.raises(GoogleConnectionError) as error:
        await _store(
            service,
            token={
                "access_token": "synthetic-access",
                "refresh_token": "synthetic-refresh",
                "scope": "openid email",
            },
        )
    assert error.value.status_code == 403
    assert not any("INSERT" in sql for sql, _ in db.calls)


@pytest.mark.asyncio
@pytest.mark.parametrize("boundary", ["connection", "grant"])
async def test_concurrent_replacement_refuses_stale_callback(monkeypatch, boundary):
    db = _Db(accept_connection=boundary != "connection", accept_grant=boundary != "grant")
    service = _service(monkeypatch, db)
    with pytest.raises(GoogleConnectionError) as error:
        await _store(service)
    assert error.value.status_code == 409
    service.status.assert_not_called()
    if boundary == "connection":
        assert not any("INSERT INTO google_service_grants" in sql for sql, _ in db.calls)


@pytest.mark.asyncio
@pytest.mark.parametrize("admitted", [True, False])
async def test_cached_bearer_is_admitted_against_one_provider_grant_snapshot(monkeypatch, admitted):
    class SnapshotDb:
        def __init__(self):
            self.calls = []

        def execute_raw(self, sql, params):
            self.calls.append((sql, params))
            if "google_provider_connections" in sql:
                return SimpleNamespace(
                    data=[
                        {
                            "status": "connected",
                            "provider_subject": "google-a",
                            "access_token_expires_at": "2999-01-01T00:00:00+00:00",
                            "access_token_ciphertext": "account-a-ciphertext",
                            "access_token_iv": "iv",
                            "service_status": "connected" if admitted else "disconnected",
                            "service_access_level": "read",
                            "service_scope_csv": " ".join(
                                GoogleConnectionService.scopes("calendar", "read")
                            ),
                        }
                    ]
                )
            # A separate read would see a replacement account's valid grant.
            # The old two-query implementation would wrongly admit A's token.
            return SimpleNamespace(
                data=[
                    {
                        "status": "connected",
                        "access_level": "read",
                        "scope_csv": " ".join(GoogleConnectionService.scopes("calendar", "read")),
                    }
                ]
            )

    db = SnapshotDb()
    service = _service(monkeypatch, db)
    if admitted:
        assert (
            await service.access_token(user_id="owner", service="calendar", access_level="read")
            == "synthetic-old-refresh"
        )
        service._decrypt.assert_called_once_with(
            {"ciphertext": "account-a-ciphertext", "iv": "iv"}, aad="google-connection:owner"
        )
    else:
        with pytest.raises(GoogleConnectionError) as error:
            await service.access_token(user_id="owner", service="calendar", access_level="read")
        assert error.value.status_code == 403
        service._decrypt.assert_not_called()
    assert len(db.calls) == 1
    assert "LEFT JOIN google_service_grants" in db.calls[0][0]
    assert db.calls[0][1] == {"user_id": "owner", "service": "calendar"}
