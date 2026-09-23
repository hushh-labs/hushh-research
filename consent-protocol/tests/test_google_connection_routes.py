from unittest.mock import AsyncMock, create_autospec

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from api.middleware import require_firebase_auth
from api.routes.one import calendar, google
from hushh_mcp.services.google_connection_service import (
    GoogleConnectionError,
    GoogleConnectionService,
)

PAYLOAD = {"user_id": "synthetic-owner", "code": "synthetic-code", "state": "synthetic-state"}


@pytest.fixture
def boundary(monkeypatch):
    service = create_autospec(GoogleConnectionService, instance=True)
    service.complete.return_value = {"connected": True, "service": "calendar"}
    service.complete_native.return_value = {"connected": True, "service": "calendar"}
    monkeypatch.setattr(google, "get_google_connection_service", lambda: service)
    monkeypatch.setattr(calendar, "get_google_connection_service", lambda: service)
    app = FastAPI()
    app.include_router(google.router)
    app.include_router(calendar.router)
    app.dependency_overrides[require_firebase_auth] = lambda: PAYLOAD["user_id"]
    return TestClient(app), service


@pytest.mark.parametrize("route", ["google", "calendar"])
def test_common_completion_and_calendar_compatibility(boundary, route):
    client, service = boundary
    response = client.post(f"/api/one/{route}/connect/complete", json=PAYLOAD)
    assert response.status_code == 200
    assert response.json() == {"connected": True, "service": "calendar"}
    service.complete.assert_awaited_once_with(
        **PAYLOAD, redirect_uri=None, expected_service="calendar"
    )


def test_shared_callback_does_not_accept_browser_service_authority(boundary):
    client, service = boundary
    response = client.post("/api/one/google/connect/complete", json={**PAYLOAD, "service": "drive"})
    assert response.status_code == 422
    service.complete.assert_not_awaited()


def test_callback_rejects_another_owner(boundary):
    client, service = boundary
    response = client.post(
        "/api/one/google/connect/complete", json={**PAYLOAD, "user_id": "another-owner"}
    )
    assert response.status_code == 403
    service.complete.assert_not_awaited()


def test_common_callback_sanitizes_unknown_errors(boundary, caplog):
    client, service = boundary
    service.complete.side_effect = RuntimeError("synthetic-sensitive-diagnostic")
    response = client.post("/api/one/google/connect/complete", json=PAYLOAD)
    assert response.status_code == 503
    assert "synthetic-sensitive-diagnostic" not in response.text + caplog.text


def test_calendar_native_completion_binds_calendar_service(boundary):
    client, service = boundary
    response = client.post(
        "/api/one/calendar/connect/native/complete",
        json={
            "user_id": "synthetic-owner",
            "state": "synthetic-state",
            "server_auth_code": "synthetic-native-code",
            "access_level": "read",
        },
    )
    assert response.status_code == 200
    service.complete_native.assert_awaited_once_with(
        user_id="synthetic-owner",
        service="calendar",
        access_level="read",
        server_auth_code="synthetic-native-code",
        state="synthetic-state",
    )


@pytest.mark.asyncio
async def test_calendar_completion_rejects_a_retired_drive_attempt_before_exchange(monkeypatch):
    service = GoogleConnectionService(db=object())
    monkeypatch.setattr(
        service,
        "_consume_oauth_attempt",
        AsyncMock(return_value=("synthetic-attempt", {"service": "drive"})),
    )
    exchange = AsyncMock()
    monkeypatch.setattr(service, "_post_form", exchange)

    with pytest.raises(GoogleConnectionError) as error:
        await service.complete(
            **PAYLOAD,
            redirect_uri=None,
            expected_service="calendar",
        )

    assert error.value.status_code == 409
    exchange.assert_not_awaited()


@pytest.mark.asyncio
async def test_calendar_native_completion_rejects_a_retired_drive_attempt_before_exchange(
    monkeypatch,
):
    service = GoogleConnectionService(db=object())
    monkeypatch.setattr(service, "is_configured", lambda: True)
    monkeypatch.setattr(
        service,
        "_consume_oauth_attempt",
        AsyncMock(
            return_value=(
                "synthetic-attempt",
                {
                    "service": "drive",
                    "requested_scope_csv": "openid email profile https://www.googleapis.com/auth/drive.readonly",
                },
            )
        ),
    )
    exchange = AsyncMock()
    monkeypatch.setattr(service, "_post_form", exchange)

    with pytest.raises(GoogleConnectionError) as error:
        await service.complete_native(
            user_id="synthetic-owner",
            service="calendar",
            access_level="read",
            server_auth_code="synthetic-native-code",
            state="synthetic-state",
        )

    assert error.value.status_code == 400
    exchange.assert_not_awaited()
