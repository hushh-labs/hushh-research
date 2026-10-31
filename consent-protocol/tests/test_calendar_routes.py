from __future__ import annotations

from unittest.mock import AsyncMock

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from api.middleware import require_firebase_auth
from api.routes.one import calendar
from hushh_mcp.services.owner_placement_guard import hub_content_firebase, hub_content_owner


@pytest.fixture(autouse=True)
def shared_placement(monkeypatch):
    monkeypatch.setattr(
        "hushh_mcp.services.account_deletion_lifecycle_service.AccountDeletionLifecycleService.is_tombstoned",
        lambda _uid: False,
    )
    monkeypatch.setattr(
        "hushh_mcp.services.owner_placement_guard.get_owner_hosting_mode",
        AsyncMock(return_value="shared"),
    )


def _app() -> FastAPI:
    app = FastAPI()
    app.include_router(calendar.router)
    app.dependency_overrides[require_firebase_auth] = lambda: "calendar-user"
    return app


def test_calendar_native_connect_uses_the_authenticated_owner(monkeypatch) -> None:
    calls: list[tuple[str, dict[str, object]]] = []

    class _Connections:
        async def start_native(self, **kwargs):
            calls.append(("start", kwargs))
            return {
                "configured": True,
                "server_client_id": "calendar-client-id",
                "state": "synthetic-attempt-state",
                "service": "calendar",
                "access_level": "read",
            }

        async def complete_native(self, **kwargs):
            calls.append(("complete", kwargs))
            return {
                "configured": True,
                "connected": True,
                "status": "connected",
                "access_level": "read",
                "scope_csv": "calendar.events.readonly calendar.freebusy",
            }

    monkeypatch.setattr(calendar, "get_google_connection_service", lambda: _Connections())
    client = TestClient(_app())

    start = client.post("/api/one/calendar/connect/native/start", json={"access_level": "read"})
    complete = client.post(
        "/api/one/calendar/connect/native/complete",
        json={
            "user_id": "calendar-user",
            "access_level": "read",
            "server_auth_code": "one-time-code",
            "state": "synthetic-attempt-state",
        },
    )

    assert start.status_code == 200
    assert complete.status_code == 200
    assert calls == [
        ("start", {"user_id": "calendar-user", "service": "calendar", "access_level": "read"}),
        (
            "complete",
            {
                "user_id": "calendar-user",
                "service": "calendar",
                "access_level": "read",
                "server_auth_code": "one-time-code",
                "state": "synthetic-attempt-state",
            },
        ),
    ]


def test_calendar_web_connect_routes_additional_and_targeted_reconnect_through_existing_start(
    monkeypatch,
) -> None:
    calls: list[dict[str, object]] = []

    class _Connections:
        async def start(self, **kwargs):
            calls.append(kwargs)
            return {
                "authorize_url": "https://accounts.google.com/synthetic",
                "state": "synthetic-state",
            }

    monkeypatch.setattr(calendar, "get_google_connection_service", lambda: _Connections())
    client = TestClient(_app())
    default = client.post("/api/one/calendar/connect/start", json={"user_id": "calendar-user"})
    additional = client.post(
        "/api/one/calendar/connect/start",
        json={
            "user_id": "calendar-user",
            "additional": True,
            "account_id": "second",
        },
    )
    invalid = client.post(
        "/api/one/calendar/connect/start",
        json={
            "user_id": "calendar-user",
            "account_id": "second",
        },
    )

    assert default.status_code == additional.status_code == 200
    assert invalid.status_code == 422
    assert calls == [
        {
            "user_id": "calendar-user",
            "service": "calendar",
            "access_level": "read",
            "redirect_uri": None,
            "login_hint": None,
        },
        {
            "user_id": "calendar-user",
            "service": "calendar",
            "access_level": "read",
            "redirect_uri": None,
            "login_hint": None,
            "calendar_additional": True,
            "calendar_account_id": "second",
        },
    ]


def test_calendar_native_complete_rejects_another_users_code(monkeypatch) -> None:
    monkeypatch.setattr(calendar, "get_google_connection_service", lambda: object())

    response = TestClient(_app()).post(
        "/api/one/calendar/connect/native/complete",
        json={
            "user_id": "different-user",
            "access_level": "read",
            "server_auth_code": "one-time-code",
            "state": "synthetic-attempt-state",
        },
    )

    assert response.status_code == 403


def test_legacy_native_completion_without_bound_state_is_rejected(monkeypatch) -> None:
    monkeypatch.setattr(calendar, "get_google_connection_service", lambda: object())
    response = TestClient(_app()).post(
        "/api/one/calendar/connect/native/complete",
        json={
            "user_id": "calendar-user",
            "access_level": "read",
            "server_auth_code": "one-time-code",
        },
    )
    assert response.status_code == 422


def test_guest_photo_token_requires_vault_owner_and_matching_firebase_identity(monkeypatch) -> None:
    service = type(
        "PhotoService",
        (),
        {
            "calendar_guest_photo_token": AsyncMock(
                return_value={
                    "access_token": "photo-only",
                    "expires_in": 1800,
                }
            )
        },
    )()
    monkeypatch.setattr(calendar, "get_google_connection_service", lambda: service)
    app = _app()
    app.dependency_overrides[hub_content_firebase] = lambda: "calendar-user"
    payload = {
        "user_id": "calendar-user",
        "account_id": "default",
        "grant_generation": "a" * 64,
        "provider_subject_sha256": "b" * 64,
    }
    client = TestClient(app)
    assert client.post("/api/one/calendar/guest-photo-token", json=payload).status_code == 401
    app.dependency_overrides[hub_content_owner] = lambda: {"user_id": "another-user"}
    assert client.post("/api/one/calendar/guest-photo-token", json=payload).status_code == 403
    app.dependency_overrides[hub_content_owner] = lambda: {"user_id": "calendar-user"}
    authorized = client.post("/api/one/calendar/guest-photo-token", json=payload)
    assert authorized.status_code == 200
    assert authorized.headers["cache-control"] == "private, no-store"
    service.calendar_guest_photo_token.assert_awaited_once_with(
        user_id="calendar-user",
        account_id="default",
        expected_generation="a" * 64,
        expected_subject_sha256="b" * 64,
    )


def test_calendar_error_preserves_typed_recovery_reason() -> None:
    from hushh_mcp.services.google_connection_service import GoogleConnectionError

    error = calendar._http(
        GoogleConnectionError(
            "Google Calendar took too long to respond",
            status_code=504,
            reason_code="calendar_timeout",
        )
    )
    assert error.status_code == 504
    assert error.detail == {
        "code": "GOOGLE_CALENDAR_ERROR",
        "message": "Google Calendar took too long to respond",
        "reason_code": "calendar_timeout",
    }
