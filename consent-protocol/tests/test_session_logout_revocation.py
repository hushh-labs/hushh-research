"""
Tests for token revocation wired into POST /api/consent/logout.

Canonical attach point:
    api.routes.session.logout_session -> POST /api/consent/logout
"""

from __future__ import annotations

from fastapi import FastAPI
from fastapi.testclient import TestClient

import api.routes.session as session_module
from api.routes.session import router


def _build_app(firebase_uid: str = "user_abc") -> FastAPI:
    app = FastAPI()
    app.include_router(router)
    from api.middleware import require_firebase_auth

    app.dependency_overrides[require_firebase_auth] = lambda: firebase_uid
    return app


class TestLogoutRevokesTokens:
    """Verifies that logout calls ConsentDBService and inserts REVOKED events."""

    def test_logout_calls_get_active_tokens(self, monkeypatch):
        calls: dict = {"get_active": 0, "get_internal": 0, "insert": []}

        class _FakeService:
            async def get_active_tokens(self, uid):
                calls["get_active"] += 1
                return [
                    {
                        "token_id": "tok_ext_001",
                        "scope": "attr.financial.*",
                        "agent_id": "developer:some-app",
                        "request_id": "req_001",
                    }
                ]

            async def get_active_internal_tokens(self, uid):
                calls["get_internal"] += 1
                return []

            async def insert_event(self, **kwargs):
                calls["insert"].append(kwargs)
                return 1

        monkeypatch.setattr(session_module, "ConsentDBService", _FakeService)
        monkeypatch.setattr(session_module, "revoke_token" if hasattr(session_module, "revoke_token") else "revoke_token", lambda _t: None, raising=False)

        app = _build_app("user_abc")
        client = TestClient(app, raise_server_exceptions=False)

        resp = client.post(
            "/api/consent/logout",
            json={"userId": "user_abc"},
            headers={"Authorization": "Bearer fake-token"},
        )

        assert resp.status_code == 200
        assert calls["get_active"] == 1
        assert calls["get_internal"] == 1
        assert len(calls["insert"]) == 1
        inserted = calls["insert"][0]
        assert inserted["action"] == "REVOKED"
        assert inserted["user_id"] == "user_abc"

    def test_logout_returns_401_without_auth(self):
        app = FastAPI()
        app.include_router(router)
        client = TestClient(app, raise_server_exceptions=False)

        resp = client.post(
            "/api/consent/logout",
            json={"userId": "user_abc"},
        )

        assert resp.status_code == 401


class TestLogoutReturns200OnSuccess:
    """Verifies 200 and correct shape when auth is present and DB works."""

    def test_logout_200_with_valid_auth_and_db(self, monkeypatch):
        class _FakeService:
            async def get_active_tokens(self, uid):
                return [
                    {
                        "token_id": "tok_sess_001",
                        "scope": "vault.owner",
                        "agent_id": "self",
                        "request_id": None,
                    }
                ]

            async def get_active_internal_tokens(self, uid):
                return []

            async def insert_event(self, **kwargs):
                return 1

        monkeypatch.setattr(session_module, "ConsentDBService", _FakeService)

        app = _build_app("user_xyz")
        client = TestClient(app, raise_server_exceptions=False)

        resp = client.post(
            "/api/consent/logout",
            json={"userId": "user_xyz"},
            headers={"Authorization": "Bearer fake-token"},
        )

        assert resp.status_code == 200
        body = resp.json()
        assert body["status"] == "success"
        assert body["revoked"] == 1

    def test_logout_forbids_user_mismatch(self, monkeypatch):
        class _FakeService:
            async def get_active_tokens(self, uid):
                return []

            async def get_active_internal_tokens(self, uid):
                return []

            async def insert_event(self, **kwargs):
                return 1

        monkeypatch.setattr(session_module, "ConsentDBService", _FakeService)

        app = _build_app("real_user")
        client = TestClient(app, raise_server_exceptions=False)

        resp = client.post(
            "/api/consent/logout",
            json={"userId": "different_user"},
            headers={"Authorization": "Bearer fake-token"},
        )

        assert resp.status_code == 403
