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
    monkeypatch.delenv("REVIEWER_UID", raising=False)
    monkeypatch.delenv("REVIEWER_VAULT_PASSPHRASE", raising=False)
    monkeypatch.delenv("UAT_SMOKE_USER_ID", raising=False)
    monkeypatch.delenv("UAT_SMOKE_PASSPHRASE", raising=False)
    monkeypatch.delenv("KAI_TEST_USER_ID", raising=False)
    monkeypatch.delenv("KAI_TEST_PASSPHRASE", raising=False)

    client = TestClient(_build_app())
    response = client.post("/api/app-config/review-mode/session", json={"subject": "reviewer"})

    assert response.status_code == 403
    assert response.json()["detail"] == "App review mode is disabled"


def test_review_mode_session_uses_reviewer_uid_when_app_review_enabled(monkeypatch):
    monkeypatch.setenv("APP_RUNTIME_PROFILE", "uat")
    monkeypatch.setenv("APP_REVIEW_MODE", "true")
    monkeypatch.setenv("REVIEWER_UID", "reviewer_uid_123")
    monkeypatch.delenv("REVIEWER_VAULT_PASSPHRASE", raising=False)
    monkeypatch.delenv("UAT_SMOKE_USER_ID", raising=False)
    monkeypatch.delenv("UAT_SMOKE_PASSPHRASE", raising=False)
    monkeypatch.delenv("KAI_TEST_USER_ID", raising=False)
    monkeypatch.delenv("KAI_TEST_PASSPHRASE", raising=False)

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
    response = client.post("/api/app-config/review-mode/session", json={"subject": "reviewer"})

    assert response.status_code == 200
    assert response.json() == {"token": "custom-token"}
    assert minted["uid"] == "reviewer_uid_123"


def test_review_mode_session_accepts_reviewer_vault_passphrase_overlay(monkeypatch):
    monkeypatch.setenv("APP_RUNTIME_PROFILE", "uat")
    monkeypatch.delenv("APP_REVIEW_MODE", raising=False)
    monkeypatch.setenv("REVIEWER_UID", "reviewer_uid_123")
    monkeypatch.setenv("REVIEWER_VAULT_PASSPHRASE", "secret-passphrase")
    monkeypatch.delenv("UAT_SMOKE_USER_ID", raising=False)
    monkeypatch.delenv("UAT_SMOKE_PASSPHRASE", raising=False)
    monkeypatch.delenv("KAI_TEST_USER_ID", raising=False)
    monkeypatch.delenv("KAI_TEST_PASSPHRASE", raising=False)

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
    assert minted["uid"] == "reviewer_uid_123"


def test_review_mode_session_rejects_passphrase_overlay_in_production(monkeypatch):
    monkeypatch.setenv("APP_RUNTIME_PROFILE", "production")
    monkeypatch.delenv("APP_REVIEW_MODE", raising=False)
    monkeypatch.setenv("REVIEWER_UID", "reviewer_uid_123")
    monkeypatch.setenv("REVIEWER_VAULT_PASSPHRASE", "secret-passphrase")
    monkeypatch.delenv("UAT_SMOKE_USER_ID", raising=False)
    monkeypatch.delenv("UAT_SMOKE_PASSPHRASE", raising=False)
    monkeypatch.delenv("KAI_TEST_USER_ID", raising=False)
    monkeypatch.delenv("KAI_TEST_PASSPHRASE", raising=False)

    client = TestClient(_build_app())
    response = client.post(
        "/api/app-config/review-mode/session",
        json={
            "subject": "reviewer",
            "smoke_passphrase": "secret-passphrase",
        },
    )

    assert response.status_code == 403
    assert response.json()["detail"] == "App review mode is disabled"


def test_review_mode_session_accepts_deprecated_uat_smoke_overlay(monkeypatch):
    monkeypatch.setenv("APP_RUNTIME_PROFILE", "uat")
    monkeypatch.delenv("APP_REVIEW_MODE", raising=False)
    monkeypatch.delenv("REVIEWER_UID", raising=False)
    monkeypatch.delenv("REVIEWER_VAULT_PASSPHRASE", raising=False)
    monkeypatch.setenv("UAT_SMOKE_USER_ID", "legacy_smoke_user")
    monkeypatch.setenv("UAT_SMOKE_PASSPHRASE", "legacy-passphrase")
    monkeypatch.delenv("KAI_TEST_USER_ID", raising=False)
    monkeypatch.delenv("KAI_TEST_PASSPHRASE", raising=False)

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
            "smoke_passphrase": "legacy-passphrase",
        },
    )

    assert response.status_code == 200
    assert response.json() == {"token": "custom-token"}
    assert minted["uid"] == "legacy_smoke_user"
