from unittest.mock import AsyncMock, create_autospec

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from api.middleware import require_firebase_auth
from api.routes.one import drive
from hushh_mcp.services.google_connection_service import (
    GoogleConnectionError,
    GoogleConnectionService,
)

OWNER = "synthetic-owner"
COMPLETE = {"user_id": OWNER, "code": "synthetic-code", "state": "synthetic-state"}
NATIVE = {"user_id": OWNER, "server_auth_code": "synthetic-code", "state": "synthetic-state"}


@pytest.fixture
def boundary(monkeypatch):
    service = create_autospec(GoogleConnectionService, instance=True)
    for name in (
        "start",
        "complete",
        "start_native",
        "complete_native",
        "status",
        "disconnect_service",
    ):
        getattr(service, name).return_value = {"connected": True}
    monkeypatch.setattr(drive, "get_google_connection_service", lambda: service)
    app = FastAPI()
    app.include_router(drive.router)
    app.dependency_overrides[require_firebase_auth] = lambda: OWNER
    return TestClient(app), service


@pytest.mark.parametrize(
    ("path", "payload", "method", "expected"),
    [
        (
            "connect/start",
            {"user_id": OWNER},
            "start",
            {
                "user_id": OWNER,
                "service": "drive",
                "access_level": "read",
                "redirect_uri": None,
                "login_hint": None,
            },
        ),
        (
            "connect/complete",
            COMPLETE,
            "complete",
            {**COMPLETE, "redirect_uri": None, "expected_service": "drive"},
        ),
        (
            "connect/native/start",
            {},
            "start_native",
            {"user_id": OWNER, "service": "drive", "access_level": "read"},
        ),
        (
            "connect/native/complete",
            NATIVE,
            "complete_native",
            {**NATIVE, "service": "drive", "access_level": "read"},
        ),
        (
            "disconnect",
            {"user_id": OWNER},
            "disconnect_service",
            {"user_id": OWNER, "service": "drive"},
        ),
    ],
)
def test_connection_routes_use_existing_owner_and_read_permission(
    boundary, path, payload, method, expected
):
    client, service = boundary
    response = client.post(f"/api/one/drive/{path}", json=payload)
    assert response.status_code == 200
    getattr(service, method).assert_awaited_once_with(**expected)


def test_status_is_owner_scoped(boundary):
    client, service = boundary
    assert client.get(f"/api/one/drive/status/{OWNER}").status_code == 200
    service.status.assert_awaited_once_with(user_id=OWNER, service="drive")
    assert client.get("/api/one/drive/status/another-owner").status_code == 403
    assert service.status.await_count == 1


@pytest.mark.parametrize(
    "path,payload",
    [
        ("connect/start", {"user_id": OWNER}),
        ("connect/complete", COMPLETE),
        ("connect/native/complete", NATIVE),
        ("disconnect", {"user_id": OWNER}),
    ],
)
def test_cross_owner_requests_never_reach_credentials(boundary, path, payload):
    client, service = boundary
    assert (
        client.post(
            f"/api/one/drive/{path}", json={**payload, "user_id": "another-owner"}
        ).status_code
        == 403
    )
    assert not service.mock_calls


@pytest.mark.parametrize(
    "path,payload",
    [
        ("connect/start", {"user_id": OWNER, "access_level": "manage"}),
        ("connect/native/start", {"access_level": "manage"}),
        ("connect/native/start", {"user_id": "another-owner"}),
        ("connect/native/complete", {**NATIVE, "access_level": "manage"}),
        ("connect/native/complete", {"user_id": OWNER, "server_auth_code": "synthetic-code"}),
        ("connect/start", {"user_id": OWNER, "scopes": ["drive"]}),
    ],
)
def test_invalid_permission_and_legacy_native_state_fail_closed(boundary, path, payload):
    client, service = boundary
    assert client.post(f"/api/one/drive/{path}", json=payload).status_code == 422
    assert not service.mock_calls


def test_unknown_error_never_logs_or_returns_private_details(boundary, caplog):
    client, service = boundary
    service.status.side_effect = RuntimeError("synthetic-sensitive-diagnostic")
    response = client.get(f"/api/one/drive/status/{OWNER}")
    assert response.status_code == 503
    assert "synthetic-sensitive-diagnostic" not in response.text + caplog.text


def test_authority_failure_is_not_replaced_with_success(boundary):
    client, service = boundary
    service.complete.side_effect = GoogleConnectionError(
        "Restart the Google connection.", status_code=409
    )
    assert client.post("/api/one/drive/connect/complete", json=COMPLETE).status_code == 409


def test_unauthenticated_request_has_no_credential_access(monkeypatch):
    service = create_autospec(GoogleConnectionService, instance=True)
    monkeypatch.setattr(drive, "get_google_connection_service", lambda: service)
    app = FastAPI()
    app.include_router(drive.router)
    assert TestClient(app).get(f"/api/one/drive/status/{OWNER}").status_code in {401, 403}
    assert not service.mock_calls


@pytest.mark.asyncio
async def test_web_completion_rejects_other_service_before_provider_exchange(monkeypatch):
    service = GoogleConnectionService(db=object())
    monkeypatch.setattr(
        service,
        "_consume_oauth_attempt",
        AsyncMock(return_value=("synthetic-attempt", {"service": "calendar"})),
    )
    exchange = AsyncMock()
    monkeypatch.setattr(service, "_post_form", exchange)
    with pytest.raises(GoogleConnectionError) as error:
        await service.complete(**COMPLETE, redirect_uri=None, expected_service="drive")
    assert error.value.status_code == 409
    exchange.assert_not_awaited()
