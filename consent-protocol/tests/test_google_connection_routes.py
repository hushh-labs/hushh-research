from unittest.mock import create_autospec

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from api.middleware import require_firebase_auth
from api.routes.one import calendar, google
from hushh_mcp.services.google_connection_service import GoogleConnectionService

PAYLOAD = {"user_id": "synthetic-owner", "code": "synthetic-code", "state": "synthetic-state"}


@pytest.fixture
def boundary(monkeypatch):
    service = create_autospec(GoogleConnectionService, instance=True)
    service.complete.return_value = {"connected": True, "service": "drive"}
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
    assert response.json() == {"connected": True, "service": "drive"}
    service.complete.assert_awaited_once_with(**PAYLOAD, redirect_uri=None)


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
