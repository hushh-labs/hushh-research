from __future__ import annotations

from fastapi import FastAPI
from fastapi.testclient import TestClient

from api.routes import health


def _build_app() -> FastAPI:
    app = FastAPI()
    app.include_router(health.router)
    return app


def test_review_mode_session_requires_app_review_or_smoke_overlay(monkeypatch):
    monkeypatch.setenv("APP_RUNTIME_PROFILE", "uat")
    monkeypatch.delenv("APP_REVIEW_MODE", raising=False)
    monkeypatch.delenv("UAT_SMOKE_USER_ID", raising=False)
    monkeypatch.delenv("UAT_SMOKE_PASSPHRASE", raising=False)

    client = TestClient(_build_app())
    response = client.post("/api/app-config/review-mode/session", json={"subject": "reviewer"})

    assert response.status_code == 403
    assert response.json()["detail"] == "App review mode is disabled"


def test_review_mode_session_accepts_uat_smoke_overlay(monkeypatch):
    monkeypatch.setenv("APP_RUNTIME_PROFILE", "uat")
    monkeypatch.delenv("APP_REVIEW_MODE", raising=False)
    monkeypatch.setenv("UAT_SMOKE_USER_ID", "user_smoke_123")
    monkeypatch.setenv("UAT_SMOKE_PASSPHRASE", "secret-passphrase")

    monkeypatch.setattr(health, "ensure_firebase_auth_admin", lambda: (True, "demo-project"))
    monkeypatch.setattr(health, "get_firebase_auth_app", lambda: object())

    minted: dict[str, object] = {}

    class _FakeFirebaseAuth:
        @staticmethod
        def create_custom_token(uid: str, app: object | None = None):
            minted["uid"] = uid
            minted["app"] = app
            return b"custom-token"

    import sys
    import types

    firebase_admin_module = types.ModuleType("firebase_admin")
    firebase_admin_module.auth = _FakeFirebaseAuth
    monkeypatch.setitem(sys.modules, "firebase_admin", firebase_admin_module)

    client = TestClient(_build_app())
    response = client.post(
        "/api/app-config/review-mode/session",
        json={
            "subject": "reviewer",
            "smoke_passphrase": "secret-passphrase",
        },
    )

    assert response.status_code == 200
    assert response.json() == {"token": "custom-token"}
    assert minted["uid"] == "user_smoke_123"
