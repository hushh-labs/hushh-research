from __future__ import annotations

from fastapi import FastAPI
from fastapi.testclient import TestClient

from api.middleware import require_firebase_auth
from api.routes.kai import support as support_routes
from hushh_mcp.services.support_email_service import SupportEmailSendError


def _build_client() -> TestClient:
    app = FastAPI()
    app.include_router(support_routes.router, prefix="/api/kai")
    app.dependency_overrides[require_firebase_auth] = lambda: "user_123"
    return TestClient(app)


def test_support_message_rejects_whitespace_only_content(monkeypatch):
    client = _build_client()
    monkeypatch.setattr(
        support_routes,
        "get_support_email_service",
        lambda: object(),
    )

    response = client.post(
        "/api/kai/support/message",
        json={
            "user_id": "user_123",
            "kind": "support_request",
            "subject": "   ",
            "message": "          ",
        },
    )

    assert response.status_code == 422


def test_support_message_route_sanitizes_backend_send_errors(monkeypatch):
    client = _build_client()

    class _FakeService:
        def send_message(self, **kwargs):
            raise SupportEmailSendError("Delegation denied for support@hushh.ai from 10.0.0.8")

    monkeypatch.setattr(
        support_routes,
        "get_support_email_service",
        lambda: _FakeService(),
    )

    response = client.post(
        "/api/kai/support/message",
        json={
            "user_id": "user_123",
            "kind": "support_request",
            "subject": "Need help",
            "message": "Please help me with my account.",
        },
    )

    assert response.status_code == 502
    payload = response.json()["detail"]
    assert payload["code"] == "SUPPORT_EMAIL_SEND_FAILED"
    assert "support@hushh.ai" not in payload["message"].lower()
    assert "10.0.0.8" not in payload["message"].lower()


def test_support_message_route_sanitizes_unexpected_errors(monkeypatch):
    client = _build_client()

    class _FakeService:
        def send_message(self, **kwargs):
            raise RuntimeError("postgres://readonly:secret@db.internal/support")

    monkeypatch.setattr(
        support_routes,
        "get_support_email_service",
        lambda: _FakeService(),
    )

    response = client.post(
        "/api/kai/support/message",
        json={
            "user_id": "user_123",
            "kind": "support_request",
            "subject": "Need help",
            "message": "Please help me with my account.",
        },
    )

    assert response.status_code == 500
    payload = response.json()["detail"]
    assert payload["code"] == "SUPPORT_MESSAGE_FAILED"
    assert "postgres://" not in payload["message"].lower()
    assert "db.internal" not in payload["message"].lower()
