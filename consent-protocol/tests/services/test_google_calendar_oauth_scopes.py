"""Calendar OAuth scope selection and optional photo grant behavior."""

from __future__ import annotations

import asyncio
from datetime import UTC, datetime
from types import SimpleNamespace

import pytest

from hushh_mcp.services.google_connection_service import (
    CALENDAR_GUEST_PHOTO_SCOPE,
    CALENDAR_LIST_READ_SCOPE,
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


def test_calendar_web_oauth_requests_incremental_list_scope_without_changing_native(
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
    assert CALENDAR_GUEST_PHOTO_SCOPE in web["scopes"]
    assert CALENDAR_GUEST_PHOTO_SCOPE in native["scopes"]


def test_historical_calendar_grant_does_not_request_guest_photo_scope(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    class _HistoricalGrantDb(_Db):
        def execute_raw(self, sql: str, params: dict | None = None):  # noqa: ANN001
            if "SELECT guest_photo_access FROM google_service_grants" in sql:
                return SimpleNamespace(data=[{"guest_photo_access": False}])
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
    assert exc_info.value.reason_code == "calendar_list_permission_required"
