"""Calendar OAuth scope selection and optional photo grant behavior."""

from __future__ import annotations

import asyncio
from datetime import UTC, datetime
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest

from hushh_mcp.services.google_connection_scope_policy import (
    require_previous_google_scopes,
    selected_grant_scopes,
)
from hushh_mcp.services.google_connection_service import (
    CALENDAR_GUEST_PHOTO_SCOPE,
    CALENDAR_LIST_READ_SCOPE,
    CALENDAR_MEET_DRIVE_READ_SCOPE,
    CALENDAR_MEET_READ_SCOPE,
    GoogleConnectionError,
    GoogleConnectionService,
)
from hushh_mcp.services.google_oauth_attempt import connection_generation
from tests.google_oauth_test_support import TransactionEngine


class _Db:
    def __init__(self) -> None:
        self.calls: list[tuple[str, dict | None]] = []
        self.engine = TransactionEngine(self)

    def execute_raw(self, sql: str, params: dict | None = None):  # noqa: ANN001
        self.calls.append((sql, params))
        return SimpleNamespace(data=[])


def test_primary_calendar_completion_includes_exact_account_and_scopes(monkeypatch):
    service = GoogleConnectionService(db=_Db())
    accounts = {
        "service": "calendar",
        "accounts": [{"account_id": "default", "scope_csv": "meet drive"}],
    }
    monkeypatch.setattr(service, "calendar_accounts_status", AsyncMock(return_value=accounts))
    monkeypatch.setattr(service, "status", AsyncMock(return_value={"service": "calendar"}))
    result = asyncio.run(service._primary_completion_status("owner", "calendar", False))
    assert result["completed_account_id"] == "default"
    assert result["accounts"] == accounts["accounts"]
    service.status.assert_not_awaited()


def test_new_calendar_web_and_native_oauth_do_not_request_photo_only_contacts(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    service = GoogleConnectionService(db=_Db())
    monkeypatch.setattr(service, "_signed_state", lambda _: "test-state")
    monkeypatch.setattr(
        service,
        "_encrypt",
        lambda *_args, **_kwargs: {"ciphertext": "test", "iv": "test", "tag": "aad-gcm-v1"},
    )
    web = asyncio.run(
        service._create_oauth_attempt(
            user_id="user-1",
            service="calendar",
            access_level="read",
            redirect_uri="https://example.com/callback",
            transport="web",
        )
    )
    native = asyncio.run(
        service._create_oauth_attempt(
            user_id="user-1",
            service="calendar",
            access_level="read",
            redirect_uri="hushh://callback",
            transport="native",
        )
    )
    assert CALENDAR_LIST_READ_SCOPE in web["scopes"]
    assert CALENDAR_LIST_READ_SCOPE not in native["scopes"]
    assert set(GoogleConnectionService.scopes("calendar", "read")) <= set(native["scopes"])
    assert CALENDAR_GUEST_PHOTO_SCOPE not in web["scopes"]
    assert CALENDAR_GUEST_PHOTO_SCOPE not in native["scopes"]


def test_historical_calendar_grant_does_not_request_guest_photo_scope(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    class _HistoricalGrantDb(_Db):
        def execute_raw(self, sql: str, params: dict | None = None):  # noqa: ANN001
            if "SELECT status, guest_photo_access FROM google_service_grants" in sql:
                return SimpleNamespace(data=[{"status": "connected", "guest_photo_access": False}])
            return super().execute_raw(sql, params)

    service = GoogleConnectionService(db=_HistoricalGrantDb())
    monkeypatch.setattr(service, "_signed_state", lambda _: "test-state")
    monkeypatch.setattr(
        service,
        "_encrypt",
        lambda *_args, **_kwargs: {
            "ciphertext": "test",
            "iv": "test",
            "tag": "aad-gcm-v1",
        },
    )
    attempt = asyncio.run(
        service._create_oauth_attempt(
            user_id="user-1",
            service="calendar",
            access_level="read",
            redirect_uri="https://example.com/callback",
            transport="web",
        )
    )
    assert CALENDAR_GUEST_PHOTO_SCOPE not in attempt["scopes"]


def test_existing_calendar_photo_grant_remains_reconnectable(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    class _ExistingGrantDb(_Db):
        def execute_raw(self, sql: str, params: dict | None = None):  # noqa: ANN001
            if "SELECT status, guest_photo_access FROM google_service_grants" in sql:
                return SimpleNamespace(data=[{"status": "connected", "guest_photo_access": True}])
            return super().execute_raw(sql, params)

    service = GoogleConnectionService(db=_ExistingGrantDb())
    monkeypatch.setattr(service, "_signed_state", lambda _: "test-state")
    monkeypatch.setattr(
        service,
        "_encrypt",
        lambda *_args, **_kwargs: {"ciphertext": "test", "iv": "test", "tag": "aad-gcm-v1"},
    )
    attempt = asyncio.run(
        service._create_oauth_attempt(
            user_id="user-1",
            service="calendar",
            access_level="read",
            redirect_uri="https://example.com/callback",
            transport="web",
        )
    )
    assert CALENDAR_GUEST_PHOTO_SCOPE in attempt["scopes"]


def test_new_additional_calendar_account_does_not_request_photo_scope(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    service = GoogleConnectionService(db=_Db())
    monkeypatch.setattr(service, "_signed_state", lambda _: "test-state")
    monkeypatch.setattr(
        service,
        "_encrypt",
        lambda *_args, **_kwargs: {"ciphertext": "test", "iv": "test", "tag": "aad-gcm-v1"},
    )
    attempt = asyncio.run(
        service._create_oauth_attempt(
            user_id="user-1",
            service="calendar",
            access_level="read",
            redirect_uri="https://example.com/callback",
            transport="web",
            calendar_additional=True,
        )
    )
    assert CALENDAR_GUEST_PHOTO_SCOPE not in attempt["scopes"]


def test_contacts_connector_scope_is_not_treated_as_calendar_photo_scope() -> None:
    requested = ("openid", CALENDAR_GUEST_PHOTO_SCOPE)
    scopes, granted, _ = selected_grant_scopes("", requested, "contacts")
    # Without a scope claim from Google, never infer Contacts authority from
    # the request; the mandatory-scope check must fail closed.
    assert CALENDAR_GUEST_PHOTO_SCOPE not in scopes.split()
    assert granted == set()

    class _GrantPort:
        async def _execute_raw_async(self, _sql, _params):  # noqa: ANN001
            return SimpleNamespace(
                data=[
                    {"service": "calendar", "scope_csv": CALENDAR_GUEST_PHOTO_SCOPE},
                    {"service": "contacts", "scope_csv": CALENDAR_GUEST_PHOTO_SCOPE},
                ]
            )

    returned_scopes = "openid"
    with pytest.raises(GoogleConnectionError):
        asyncio.run(
            require_previous_google_scopes(
                _GrantPort(),
                user_id="user-1",
                token_scope=returned_scopes,
                covers=lambda granted_scopes, required: required <= granted_scopes,
            )
        )


def test_contacts_oauth_without_provider_scope_claim_fails_closed(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    db = _Db()
    service = GoogleConnectionService(db=db)
    monkeypatch.setattr(
        service,
        "_userinfo",
        lambda *_args, **_kwargs: asyncio.sleep(0, result={"sub": "google-sub"}),
    )
    monkeypatch.setattr(
        service, "_connection", lambda *_args, **_kwargs: asyncio.sleep(0, result=None)
    )
    with pytest.raises(GoogleConnectionError) as error:
        asyncio.run(
            service._store_authorized_connection(
                user_id="user-1",
                token={"access_token": "access", "refresh_token": "refresh", "expires_in": 3600},
                service="contacts",
                requested_scopes=GoogleConnectionService.scopes("contacts", "read"),
                oauth_started_at=datetime(2026, 1, 1, tzinfo=UTC),
                attempt_id="synthetic-attempt",
                expected_generation=connection_generation(None),
            )
        )
    assert error.value.status_code == 403
    assert error.value.reason_code == "google_permission_required"
    assert not any("INSERT INTO google_service_grants" in sql for sql, _ in db.calls)


def test_declined_guest_photo_scope_does_not_block_calendar_connection(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    service = GoogleConnectionService(db=_Db())
    monkeypatch.setattr(
        service,
        "_userinfo",
        lambda *_args, **_kwargs: asyncio.sleep(
            0, result={"sub": "google-sub", "email": "owner@example.com"}
        ),
    )
    monkeypatch.setattr(
        service, "_connection", lambda *_args, **_kwargs: asyncio.sleep(0, result=None)
    )
    monkeypatch.setattr(
        service,
        "_encrypt",
        lambda *_args, **_kwargs: {
            "ciphertext": "sealed",
            "iv": "iv",
            "tag": "aad-gcm-v1",
        },
    )
    published: dict = {}
    monkeypatch.setattr(
        service, "_publish_authorization", lambda **kwargs: published.update(kwargs)
    )
    monkeypatch.setattr(
        service,
        "_primary_completion_status",
        lambda *_args: asyncio.sleep(0, result={"connected": True}),
    )
    granted = (*GoogleConnectionService.scopes("calendar", "read"), CALENDAR_LIST_READ_SCOPE)
    result = asyncio.run(
        service._store_authorized_connection(
            user_id="user-1",
            token={
                "access_token": "access",
                "refresh_token": "refresh",
                "scope": " ".join(granted),
                "expires_in": 3600,
            },
            service="calendar",
            requested_scopes=(*granted, CALENDAR_GUEST_PHOTO_SCOPE),
            oauth_started_at=datetime(2026, 1, 1, tzinfo=UTC),
            attempt_id="synthetic-attempt",
            expected_generation=connection_generation(None),
        )
    )
    assert result["connected"] is True
    assert published["grant_params"]["guest_photo_access"] is False


@pytest.mark.parametrize("meeting_grants", [(), (CALENDAR_MEET_READ_SCOPE,)])
def test_first_calendar_connection_keeps_base_grant_when_meeting_consent_is_partial(
    monkeypatch: pytest.MonkeyPatch, meeting_grants: tuple[str, ...]
) -> None:
    service = GoogleConnectionService(db=_Db())
    monkeypatch.setattr(
        service,
        "_userinfo",
        lambda *_args, **_kwargs: asyncio.sleep(
            0, result={"sub": "google-sub", "email": "owner@example.com"}
        ),
    )
    monkeypatch.setattr(
        service, "_connection", lambda *_args, **_kwargs: asyncio.sleep(0, result=None)
    )
    monkeypatch.setattr(
        service,
        "_encrypt",
        lambda *_args, **_kwargs: {"ciphertext": "sealed", "iv": "iv", "tag": "aad-gcm-v1"},
    )
    published: dict = {}
    monkeypatch.setattr(
        service, "_publish_authorization", lambda **kwargs: published.update(kwargs)
    )
    monkeypatch.setattr(
        service,
        "_primary_completion_status",
        lambda *_args: asyncio.sleep(0, result={"connected": True}),
    )
    base = (*service.scopes("calendar", "read"), CALENDAR_LIST_READ_SCOPE)
    result = asyncio.run(
        service._store_authorized_connection(
            user_id="user-1",
            token={
                "access_token": "access",
                "refresh_token": "refresh",
                "scope": " ".join((*base, *meeting_grants)),
            },
            service="calendar",
            requested_scopes=(*base, CALENDAR_MEET_READ_SCOPE, CALENDAR_MEET_DRIVE_READ_SCOPE),
            oauth_started_at=datetime(2026, 1, 1, tzinfo=UTC),
            attempt_id="synthetic-attempt",
            expected_generation=connection_generation(None),
        )
    )
    assert result["connected"] is True
    assert set(published["grant_params"]["scope_csv"].split()) == set((*base, *meeting_grants))


def test_first_calendar_after_mail_keeps_mail_and_partial_calendar_grants(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    mail_scope = "https://www.googleapis.com/auth/gmail.readonly"

    class _MailOnlyDb(_Db):
        def execute_raw(self, sql: str, params: dict | None = None):  # noqa: ANN001
            if "SELECT service, scope_csv FROM google_service_grants" in sql:
                self.calls.append((sql, params))
                return SimpleNamespace(data=[{"service": "gmail", "scope_csv": mail_scope}])
            return super().execute_raw(sql, params)

    db = _MailOnlyDb()
    service = GoogleConnectionService(db=db)
    existing = {
        "status": "connected",
        "provider_subject": "google-sub",
        "refresh_token_ciphertext": "old",
    }
    monkeypatch.setattr(service, "_connection", AsyncMock(return_value=existing))
    monkeypatch.setattr(
        service,
        "_userinfo",
        AsyncMock(return_value={"sub": "google-sub", "email": "owner@example.com"}),
    )
    monkeypatch.setattr(
        service,
        "_encrypt",
        lambda *_args, **_kwargs: {"ciphertext": "sealed", "iv": "iv", "tag": "aad-gcm-v1"},
    )
    published: dict = {}
    monkeypatch.setattr(
        service, "_publish_authorization", lambda **kwargs: published.update(kwargs)
    )
    monkeypatch.setattr(
        service, "_primary_completion_status", AsyncMock(return_value={"connected": True})
    )
    base = (*service.scopes("calendar", "read"), CALENDAR_LIST_READ_SCOPE)
    result = asyncio.run(
        service._store_authorized_connection(
            user_id="user-1",
            token={
                "access_token": "access",
                "refresh_token": "refresh",
                "scope": " ".join((*base, mail_scope)),
            },
            service="calendar",
            requested_scopes=(*base, CALENDAR_MEET_READ_SCOPE, CALENDAR_MEET_DRIVE_READ_SCOPE),
            oauth_started_at=datetime(2026, 1, 1, tzinfo=UTC),
            attempt_id="synthetic-attempt",
            expected_generation=connection_generation(existing),
        )
    )
    assert result["connected"] is True
    assert set(published["grant_params"]["scope_csv"].split()) == set((*base, mail_scope))
    assert any("SELECT status FROM google_service_grants" in sql for sql, _ in db.calls)


def test_calendar_web_oauth_does_not_assume_optional_scope_was_granted(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    service = GoogleConnectionService(db=_Db())
    monkeypatch.setattr(
        service,
        "_userinfo",
        lambda *_args, **_kwargs: asyncio.sleep(0, result={"sub": "google-sub"}),
    )
    monkeypatch.setattr(
        service, "_connection", lambda *_args, **_kwargs: asyncio.sleep(0, result=None)
    )
    with pytest.raises(GoogleConnectionError) as exc_info:
        asyncio.run(
            service._store_authorized_connection(
                user_id="user-1",
                token={"access_token": "access", "refresh_token": "refresh", "expires_in": 3600},
                service="calendar",
                requested_scopes=(
                    *GoogleConnectionService.scopes("calendar", "read"),
                    CALENDAR_LIST_READ_SCOPE,
                ),
                oauth_started_at=datetime(2026, 1, 1, tzinfo=UTC),
                attempt_id="synthetic-attempt",
                expected_generation=connection_generation(None),
            )
        )
    assert exc_info.value.status_code == 403
    assert exc_info.value.reason_code == "google_permission_required"
