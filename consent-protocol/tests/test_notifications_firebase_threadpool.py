"""
Tests that verify_firebase_bearer is wrapped in run_in_threadpool for notification endpoints.

Both register and unregister endpoints call the sync verify_firebase_bearer function,
which should be wrapped in run_in_threadpool so the event loop doesn't block on the
Firebase HTTP call.
"""

from __future__ import annotations

from fastapi import FastAPI
from fastapi.testclient import TestClient

import api.routes.notifications as notif_module
from api.routes.notifications import router


def _build_app(stubbed_uid: str = "user_abc") -> FastAPI:
    app = FastAPI()
    app.include_router(router)
    return app


class TestNotificationsFirebaseThreadpool:
    """Verifies register and unregister respond correctly with a stubbed Firebase verifier."""

    def test_register_calls_verify_firebase_bearer(self, monkeypatch):
        calls: list[str] = []

        def _fake_verify(auth_header):
            calls.append(auth_header or "")
            return "user_abc"

        class _FakePushService:
            def upsert_user_push_token(self, *, user_id, token, platform):
                return "tok_001"

        monkeypatch.setattr(notif_module, "verify_firebase_bearer", _fake_verify)
        monkeypatch.setattr(notif_module, "PushTokensService", _FakePushService)

        client = TestClient(_build_app(), raise_server_exceptions=True)
        resp = client.post(
            "/api/notifications/register",
            json={"user_id": "user_abc", "token": "fcm-device-token", "platform": "web"},
            headers={"Authorization": "Bearer fake-firebase-token"},
        )

        assert resp.status_code == 200
        assert resp.json()["ok"] is True
        assert len(calls) == 1

    def test_register_rejects_missing_auth(self, monkeypatch):
        def _fake_verify(auth_header):
            from fastapi import HTTPException

            raise HTTPException(status_code=401, detail="Unauthorized")

        monkeypatch.setattr(notif_module, "verify_firebase_bearer", _fake_verify)

        client = TestClient(_build_app(), raise_server_exceptions=False)
        resp = client.post(
            "/api/notifications/register",
            json={"user_id": "user_abc", "token": "fcm-device-token", "platform": "web"},
        )

        assert resp.status_code == 401

    def test_unregister_calls_verify_firebase_bearer(self, monkeypatch):
        calls: list[str] = []

        def _fake_verify(auth_header):
            calls.append(auth_header or "")
            return "user_abc"

        class _FakePushService:
            def delete_user_push_tokens(self, *, user_id, platform=None):
                return 1

        monkeypatch.setattr(notif_module, "verify_firebase_bearer", _fake_verify)
        monkeypatch.setattr(notif_module, "PushTokensService", _FakePushService)

        client = TestClient(_build_app(), raise_server_exceptions=True)
        resp = client.request(
            "DELETE",
            "/api/notifications/unregister",
            json={"user_id": "user_abc"},
            headers={"Authorization": "Bearer fake-firebase-token"},
        )

        assert resp.status_code == 200
        assert resp.json()["ok"] is True
        assert len(calls) == 1
