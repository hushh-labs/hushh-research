from __future__ import annotations

from fastapi import FastAPI
from fastapi.testclient import TestClient

from api.routes import notifications


def test_proxy_path_parameter_boundary_rejects_extra_segment(monkeypatch):
    def _unexpected_auth(_auth_header: str | None):
        raise AssertionError("extra proxy path segment should not reach auth")

    monkeypatch.setattr(notifications, "verify_firebase_bearer", _unexpected_auth)

    app = FastAPI()
    app.include_router(notifications.router)
    client = TestClient(app, raise_server_exceptions=False)

    oversized_segment = "x" * 1025
    response = client.post(f"/api/notifications/register/{oversized_segment}")

    assert response.status_code == 404
