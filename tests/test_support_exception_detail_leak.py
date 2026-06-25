"""
Tests: CWE-209 -- support route must not leak internal exception detail.

Both the SupportEmailNotConfiguredError path (503) and the generic
Exception path (500) must return opaque messages to the client while
logging the real cause server-side.
"""

from __future__ import annotations

from fastapi import FastAPI
from fastapi.testclient import TestClient

from api.middleware import require_firebase_auth
from api.routes.kai.support import router
from hushh_mcp.services.support_email_service import SupportEmailNotConfiguredError


def _build_client(overrides: dict) -> TestClient:
    app = FastAPI()
    app.include_router(router)
    app.dependency_overrides.update(overrides)
    return TestClient(app, raise_server_exceptions=False)


def _auth_override(uid: str):
    async def _dep():
        return uid

    return _dep


_VALID_PAYLOAD = {
    "user_id": "user123",
    "kind": "bug_report",
    "subject": "Something broke",
    "message": "This feature is completely broken and needs urgent attention from the team.",
}


class TestSupportNotConfiguredDoesNotLeak:
    """503 path: SupportEmailNotConfiguredError detail must be opaque."""

    def test_503_returns_opaque_message(self, monkeypatch):
        def _bad_service():
            raise SupportEmailNotConfiguredError("FIREBASE_ADMIN_CREDENTIALS_JSON not set")

        monkeypatch.setattr(
            "api.routes.kai.support.get_support_email_service",
            _bad_service,
        )
        client = _build_client({require_firebase_auth: _auth_override("user123")})
        resp = client.post("/support/message", json=_VALID_PAYLOAD)
        assert resp.status_code == 503
        body = resp.json()
        assert body["detail"]["code"] == "SUPPORT_EMAIL_NOT_CONFIGURED"
        # Must not reveal internal env var names or service configuration
        msg = body["detail"]["message"]
        assert "FIREBASE" not in msg
        assert "ADMIN" not in msg
        assert "not set" not in msg.lower()
        assert "credential" not in msg.lower()

    def test_503_message_is_generic(self, monkeypatch):
        def _bad_service():
            raise SupportEmailNotConfiguredError("SECRET_API_KEY=abc123 missing")

        monkeypatch.setattr(
            "api.routes.kai.support.get_support_email_service",
            _bad_service,
        )
        client = _build_client({require_firebase_auth: _auth_override("user123")})
        resp = client.post("/support/message", json=_VALID_PAYLOAD)
        body = resp.json()
        msg = body["detail"]["message"]
        assert "abc123" not in msg
        assert "SECRET" not in msg


class TestSupportGenericExceptionDoesNotLeak:
    """500 path: unexpected exceptions must not expose internal details."""

    def test_500_does_not_leak_exception_message(self, monkeypatch):
        def _bad_service():
            raise RuntimeError("DB connection string: postgres://admin:pass@internal-host/db")

        monkeypatch.setattr(
            "api.routes.kai.support.get_support_email_service",
            _bad_service,
        )
        client = _build_client({require_firebase_auth: _auth_override("user123")})
        resp = client.post("/support/message", json=_VALID_PAYLOAD)
        assert resp.status_code == 500
        body = resp.json()
        assert body["detail"]["code"] == "SUPPORT_MESSAGE_FAILED"
        msg = body["detail"]["message"]
        assert "postgres" not in msg
        assert "admin" not in msg
        assert "internal-host" not in msg
        assert "pass" not in msg

    def test_500_message_is_generic(self, monkeypatch):
        def _bad_service():
            raise ValueError("Token: sk-proj-verysecrettoken123")

        monkeypatch.setattr(
            "api.routes.kai.support.get_support_email_service",
            _bad_service,
        )
        client = _build_client({require_firebase_auth: _auth_override("user123")})
        resp = client.post("/support/message", json=_VALID_PAYLOAD)
        assert resp.status_code == 500
        body = resp.json()
        msg = body["detail"]["message"]
        assert "sk-proj" not in msg
        assert "verysecrettoken" not in msg

    def test_500_code_is_present(self, monkeypatch):
        def _bad_service():
            raise OSError("file not found")

        monkeypatch.setattr(
            "api.routes.kai.support.get_support_email_service",
            _bad_service,
        )
        client = _build_client({require_firebase_auth: _auth_override("user123")})
        resp = client.post("/support/message", json=_VALID_PAYLOAD)
        body = resp.json()
        assert body["detail"]["code"] == "SUPPORT_MESSAGE_FAILED"
