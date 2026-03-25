from __future__ import annotations

import json

import pytest
from fastapi import HTTPException

from api.utils.firebase_admin import ensure_firebase_admin
from api.utils.firebase_auth import verify_firebase_bearer


def test_verify_firebase_bearer_uses_auth_specific_admin_app(monkeypatch):
    import firebase_admin.auth as firebase_auth

    fake_app = object()
    bearer_value = "abc123"

    monkeypatch.setattr(
        "api.utils.firebase_auth.ensure_firebase_auth_admin",
        lambda: (True, "hushh-pda"),
    )
    monkeypatch.setattr("api.utils.firebase_auth.get_firebase_auth_app", lambda: fake_app)

    def fake_verify(token: str, app=None):
        assert token == bearer_value
        assert app is fake_app
        return {"uid": "user_123"}

    monkeypatch.setattr(firebase_auth, "verify_id_token", fake_verify)

    assert verify_firebase_bearer(f"Bearer {bearer_value}") == "user_123"


def test_verify_firebase_bearer_returns_500_when_auth_admin_missing(monkeypatch):
    monkeypatch.setattr(
        "api.utils.firebase_auth.ensure_firebase_auth_admin",
        lambda: (False, None),
    )

    with pytest.raises(HTTPException) as exc:
        verify_firebase_bearer("Bearer abc123")

    assert exc.value.status_code == 500
    assert exc.value.detail == "Firebase Admin not configured"


def test_ensure_firebase_admin_keeps_default_project_for_default_app(monkeypatch):
    import firebase_admin
    from firebase_admin import credentials

    default_sa = {
        "type": "service_account",
        "project_id": "hushh-pda-uat",
        "client_email": "default@example.com",
        "private_key": "test-default-private-key-material",
    }
    auth_sa = {
        "type": "service_account",
        "project_id": "hushh-pda",
        "client_email": "auth@example.com",
        "private_key": "test-auth-private-key-material",
    }

    monkeypatch.setenv("FIREBASE_SERVICE_ACCOUNT_JSON", json.dumps(default_sa))
    monkeypatch.setenv("FIREBASE_AUTH_SERVICE_ACCOUNT_JSON", json.dumps(auth_sa))
    monkeypatch.setattr(
        firebase_admin,
        "get_app",
        lambda *args, **kwargs: (_ for _ in ()).throw(ValueError("missing")),
    )

    captured: dict[str, object] = {}

    def fake_certificate(service_account):
        captured["service_account"] = service_account
        return {"service_account": service_account}

    def fake_initialize_app(cred, name=None):
        captured["cred"] = cred
        captured["name"] = name

        class FakeApp:
            project_id = cred["service_account"]["project_id"]

        return FakeApp()

    monkeypatch.setattr(credentials, "Certificate", fake_certificate)
    monkeypatch.setattr(firebase_admin, "initialize_app", fake_initialize_app)

    configured, project_id = ensure_firebase_admin()

    assert configured is True
    assert project_id == "hushh-pda-uat"
    assert captured["service_account"] == default_sa
    assert captured["name"] is None
