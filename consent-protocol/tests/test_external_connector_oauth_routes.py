from __future__ import annotations

from types import SimpleNamespace
from unittest.mock import AsyncMock
from urllib.parse import parse_qs, urlparse

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from api.middleware import require_firebase_auth, require_vault_owner_token
from api.routes import external_connectors as routes
from hushh_mcp.services.external_connector_google_oauth import DriveOAuthError
from hushh_mcp.services.external_connector_oauth_service import ExternalConnectorOAuthError


@pytest.fixture
def route_client(monkeypatch):
    drive = SimpleNamespace(
        complete=AsyncMock(return_value={"connectorId": "google_drive", "status": "verifying"}),
        complete_native=AsyncMock(
            return_value={"attemptId": "synthetic-attempt", "outcome": "ready"}
        ),
        lifecycle=SimpleNamespace(cancel_native=AsyncMock(return_value=True)),
    )

    def verify(state):
        if state != "signed-synthetic-state":
            raise ExternalConnectorOAuthError("OAuth state is invalid")
        return "synthetic-attempt"

    service = SimpleNamespace(_verify_state=verify, drive=lambda: drive)
    monkeypatch.setattr(routes, "get_external_connector_oauth_service", lambda: service)
    app = FastAPI()
    app.include_router(routes.router)
    return TestClient(app), app, drive


@pytest.mark.parametrize(
    "path,body",
    [
        (
            "/api/connectors/google_drive/connect/oauth/start",
            {"redirectUri": "https://example.invalid/return"},
        ),
        ("/api/connectors/google_drive/disconnect", {}),
        ("/api/connectors/google_drive/picker/session", {"origin": "https://example.invalid"}),
        (
            "/api/connectors/google_drive/documents/select",
            {
                "sessionId": "550e8400-e29b-41d4-a716-446655440000",
                "fileIds": ["file-one"],
                "confirmed": True,
            },
        ),
        ("/api/connectors/oauth/native/finalize", {"attemptId": "synthetic-attempt"}),
        (
            "/api/connectors/oauth/complete",
            {"state": "signed-synthetic-state", "code": "synthetic-code"},
        ),
    ],
)
def test_owner_routes_stay_owner_protected(route_client, path, body):
    client, _, drive = route_client
    assert client.post(path, json=body).status_code == 401
    drive.complete.assert_not_called()


def test_selection_routes_derive_owner_reject_unknown_fields_and_do_not_cache_tokens(
    route_client, monkeypatch
):
    client, app, _ = route_client
    app.dependency_overrides[require_vault_owner_token] = lambda: {"user_id": "verified-owner"}
    service = SimpleNamespace(
        picker_session=AsyncMock(return_value={"accessToken": "synthetic-short-lived"}),
        select=AsyncMock(return_value=[]),
    )
    monkeypatch.setattr(routes, "DriveSelectionService", lambda: service)
    response = client.post(
        "/api/connectors/google_drive/picker/session", json={"origin": "https://example.invalid"}
    )
    assert response.status_code == 200 and response.headers["Cache-Control"] == "no-store"
    service.picker_session.assert_awaited_once_with(
        user_id="verified-owner", origin="https://example.invalid"
    )
    body = {
        "sessionId": "550e8400-e29b-41d4-a716-446655440000",
        "fileIds": ["file-one"],
        "confirmed": True,
    }
    for change in (
        {"ownerId": "attacker"},
        {"confirmed": False},
        {"endpoint": "https://attacker.invalid"},
    ):
        assert (
            client.post(
                "/api/connectors/google_drive/documents/select", json={**body, **change}
            ).status_code
            == 422
        )
    service.select.assert_not_called()
    assert (
        client.post("/api/connectors/google_drive/documents/select", json=body).status_code == 200
    )
    service.select.assert_awaited_once_with(
        user_id="verified-owner",
        session_id=body["sessionId"],
        file_ids=["file-one"],
        processing_consent=None,
    )


def test_processing_and_resync_are_owner_bound(route_client, monkeypatch):
    client, app, _ = route_client
    service = SimpleNamespace(set_processing=AsyncMock(), sync=AsyncMock())
    monkeypatch.setattr(routes, "DriveSelectionService", lambda: service)
    document = "550e8400-e29b-41d4-a716-446655440000"
    path = f"/api/connectors/google_drive/documents/{document}"
    assert (
        client.post(path + "/processing", json={"enabled": True, "confirmed": True}).status_code
        == 401
    )
    assert client.post(path + "/sync").status_code == 401
    app.dependency_overrides[require_vault_owner_token] = lambda: {"user_id": "verified-owner"}
    for extra in ({"ownerId": "wrong"}, {"confirmed": False}, {"disclosure": "wrong"}):
        assert (
            client.post(
                path + "/processing", json={"enabled": True, "confirmed": True, **extra}
            ).status_code
            == 422
        )
    body = {"enabled": True, "confirmed": True, "disclosure": "selected-files-background-v1"}
    response = client.post(path + "/processing", json=body)
    assert response.status_code == 200 and response.headers["Cache-Control"] == "no-store"
    service.set_processing.assert_awaited_once_with(
        user_id="verified-owner", document_id=document, enabled=True, disclosure=body["disclosure"]
    )
    assert client.post(path + "/sync").status_code == 200
    service.sync.assert_awaited_once_with(user_id="verified-owner", document_id=document)


def test_popup_completion_uses_firebase_owner_not_an_opener_token(route_client):
    client, app, drive = route_client
    body = {
        "state": "signed-synthetic-state",
        "code": "synthetic-code",
        "attemptId": "synthetic-attempt",
    }
    assert client.post("/api/connectors/oauth/complete/web", json=body).status_code == 401
    app.dependency_overrides[require_firebase_auth] = lambda: "verified-owner"
    response = client.post("/api/connectors/oauth/complete/web", json=body)
    assert response.status_code == 200
    drive.complete.assert_awaited_once_with(
        state=body["state"], code=body["code"], expected_user_id="verified-owner"
    )
    assert "token" not in response.text


def test_web_popup_rejects_another_attempt_before_exchange(route_client):
    client, app, drive = route_client
    app.dependency_overrides[require_firebase_auth] = lambda: "verified-owner"
    response = client.post(
        "/api/connectors/oauth/complete/web",
        json={
            "state": "signed-synthetic-state",
            "code": "synthetic-code",
            "attemptId": "different-attempt",
        },
    )
    assert response.status_code == 409
    drive.complete.assert_not_called()


def test_deactivation_does_not_hide_owner_disconnect_status(route_client, monkeypatch):
    client, app, _ = route_client
    app.dependency_overrides[require_vault_owner_token] = lambda: {"user_id": "verified-owner"}
    monkeypatch.setattr(
        routes,
        "get_external_connector_registry_service",
        lambda: SimpleNamespace(list_active_connectors=AsyncMock(return_value=[])),
    )
    credentials = SimpleNamespace(
        list_statuses=AsyncMock(
            return_value=[
                {
                    "connectorId": "google_drive",
                    "status": "needs_reauth",
                    "accountLabel": "owner@example.invalid",
                }
            ]
        )
    )
    monkeypatch.setattr(routes, "get_external_connector_credentials_service", lambda: credentials)
    response = client.get("/api/connectors")
    assert response.status_code == 200
    assert response.json()["connectors"][0]["available"] is False
    assert response.json()["connectors"][0]["status"] == "needs_reauth"
    credentials.list_statuses.assert_awaited_once_with(user_id="verified-owner")


@pytest.mark.parametrize("provider_error", [False, True])
def test_native_return_contains_no_code_state_identity_or_provider_error(
    route_client, provider_error
):
    client, _, drive = route_client
    if provider_error:
        drive.complete_native.side_effect = DriveOAuthError("provider_unavailable", status_code=503)
    response = client.get(
        "/api/connectors/oauth/native/callback",
        params={"state": "signed-synthetic-state", "code": "synthetic-code"},
        follow_redirects=False,
    )
    assert response.status_code == 303
    destination = urlparse(response.headers["location"])
    assert (destination.scheme, destination.netloc, destination.path) == (
        "hushh",
        "connectors",
        "/return",
    )
    assert parse_qs(destination.query) == {
        "attemptId": ["synthetic-attempt"],
        "outcome": ["failed" if provider_error else "ready"],
    }
    assert response.headers["cache-control"] == "no-store"
    assert response.headers["referrer-policy"] == "no-referrer"
    assert "synthetic-code" not in str(response.headers)
    assert "signed-synthetic-state" not in str(response.headers)


def test_native_bad_state_cannot_trigger_a_handoff_or_exchange(route_client):
    client, _, drive = route_client
    response = client.get(
        "/api/connectors/oauth/native/callback",
        params={"state": "forged", "code": "synthetic-code"},
        follow_redirects=False,
    )
    assert response.status_code == 400
    assert "location" not in response.headers
    drive.complete_native.assert_not_called()


def test_native_cancel_invalidates_attempt_without_a_token_exchange(route_client):
    client, _, drive = route_client
    response = client.get(
        "/api/connectors/oauth/native/callback",
        params={"state": "signed-synthetic-state", "error": "access_denied"},
        follow_redirects=False,
    )
    assert response.status_code == 303
    assert parse_qs(urlparse(response.headers["location"]).query)["outcome"] == ["cancelled"]
    drive.lifecycle.cancel_native.assert_awaited_once_with(attempt_id="synthetic-attempt")
    drive.complete_native.assert_not_called()


def test_status_requires_vault_owner(route_client):
    client, app, _ = route_client
    assert client.get("/api/connectors").status_code == 401
    # Keep the dependency contract explicit: ordinary Firebase login is not
    # sufficient for status, start, disconnect or native owner finalization.
    protected = [route for route in app.routes if getattr(route, "path", "") == "/api/connectors"]
    assert protected[0].dependant.dependencies[0].call is require_vault_owner_token
