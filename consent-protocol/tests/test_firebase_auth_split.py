from __future__ import annotations

import json

import pytest
from fastapi import HTTPException

from api.utils.firebase_admin import (
    ensure_firebase_admin,
    ensure_firebase_auth_admin,
    get_firebase_auth_app,
)
from api.utils.firebase_auth import verify_firebase_bearer


def test_verify_firebase_bearer_uses_auth_admin_app(monkeypatch):
    import firebase_admin.auth as firebase_auth

    fake_app = object()
    bearer_value = "abc123"

    monkeypatch.setattr(
        "api.utils.firebase_auth.ensure_firebase_auth_admin",
        lambda: (True, "hushh-pda"),
    )
    monkeypatch.setattr("api.utils.firebase_auth.get_firebase_auth_app", lambda: fake_app)

    def fake_verify(token: str, app=None, check_revoked: bool = False):
        assert token == bearer_value
        assert app is fake_app
        assert check_revoked is True
        return {"uid": "user_123"}

    monkeypatch.setattr(firebase_auth, "verify_id_token", fake_verify)

    assert verify_firebase_bearer(f"Bearer {bearer_value}") == "user_123"


def test_verify_firebase_bearer_accepts_active_trusted_device(monkeypatch):
    import firebase_admin.auth as firebase_auth

    class _TrustedDevices:
        def is_active_device(self, *, user_id: str, device_id: str) -> bool:
            assert user_id == "user_123"
            assert device_id == "tdv_active"
            return True

    monkeypatch.setattr(
        "api.utils.firebase_auth.ensure_firebase_auth_admin",
        lambda: (True, "test-project"),
    )
    monkeypatch.setattr("api.utils.firebase_auth.get_firebase_auth_app", lambda: object())
    monkeypatch.setattr(
        firebase_auth,
        "verify_id_token",
        lambda *_args, **_kwargs: {
            "uid": "user_123",
            "trusted_device_id": "tdv_active",
        },
    )
    monkeypatch.setattr(
        "hushh_mcp.services.trusted_device_service.TrustedDeviceService",
        _TrustedDevices,
    )

    assert verify_firebase_bearer("Bearer device-token") == "user_123"


def test_verify_firebase_bearer_rejects_inactive_trusted_device(monkeypatch):
    import firebase_admin.auth as firebase_auth

    class _TrustedDevices:
        def is_active_device(self, **_kwargs) -> bool:
            return False

    monkeypatch.setattr(
        "api.utils.firebase_auth.ensure_firebase_auth_admin",
        lambda: (True, "test-project"),
    )
    monkeypatch.setattr("api.utils.firebase_auth.get_firebase_auth_app", lambda: object())
    monkeypatch.setattr(
        firebase_auth,
        "verify_id_token",
        lambda *_args, **_kwargs: {
            "uid": "user_123",
            "trusted_device_id": "tdv_revoked",
        },
    )
    monkeypatch.setattr(
        "hushh_mcp.services.trusted_device_service.TrustedDeviceService",
        _TrustedDevices,
    )

    with pytest.raises(HTTPException) as exc:
        verify_firebase_bearer("Bearer device-token")

    assert exc.value.status_code == 401
    assert exc.value.detail == "Trusted-device session is no longer active"


def test_verify_firebase_bearer_fails_closed_when_device_status_unavailable(monkeypatch):
    import firebase_admin.auth as firebase_auth

    class _TrustedDevices:
        def is_active_device(self, **_kwargs) -> bool:
            raise RuntimeError("database unavailable")

    monkeypatch.setattr(
        "api.utils.firebase_auth.ensure_firebase_auth_admin",
        lambda: (True, "test-project"),
    )
    monkeypatch.setattr("api.utils.firebase_auth.get_firebase_auth_app", lambda: object())
    monkeypatch.setattr(
        firebase_auth,
        "verify_id_token",
        lambda *_args, **_kwargs: {
            "uid": "user_123",
            "trusted_device_id": "tdv_active",
        },
    )
    monkeypatch.setattr(
        "hushh_mcp.services.trusted_device_service.TrustedDeviceService",
        _TrustedDevices,
    )

    with pytest.raises(HTTPException) as exc:
        verify_firebase_bearer("Bearer device-token")

    assert exc.value.status_code == 503
    assert exc.value.detail == "Trusted-device status temporarily unavailable"


def test_verify_firebase_bearer_returns_500_when_auth_admin_missing(monkeypatch):
    monkeypatch.setattr(
        "api.utils.firebase_auth.ensure_firebase_auth_admin",
        lambda: (False, None),
    )

    with pytest.raises(HTTPException) as exc:
        verify_firebase_bearer("Bearer abc123")

    assert exc.value.status_code == 500
    assert exc.value.detail == "Firebase Admin not configured"


def test_verify_firebase_bearer_certificate_fetch_returns_503(monkeypatch):
    import firebase_admin.auth as firebase_auth

    monkeypatch.setattr(
        "api.utils.firebase_auth.ensure_firebase_auth_admin",
        lambda: (True, "test-project"),
    )
    monkeypatch.setattr("api.utils.firebase_auth.get_firebase_auth_app", lambda: object())

    def _raise_cert(*_args, **_kwargs):
        raise firebase_auth.CertificateFetchError("fetch failed", cause=RuntimeError("network"))

    monkeypatch.setattr(firebase_auth, "verify_id_token", _raise_cert)

    with pytest.raises(HTTPException) as exc:
        verify_firebase_bearer("Bearer some-token")

    assert exc.value.status_code == 503
    assert "temporarily unavailable" in exc.value.detail.lower()


def test_verify_firebase_bearer_invalid_id_token_returns_401(monkeypatch):
    import firebase_admin.auth as firebase_auth

    monkeypatch.setattr(
        "api.utils.firebase_auth.ensure_firebase_auth_admin",
        lambda: (True, "test-project"),
    )
    monkeypatch.setattr("api.utils.firebase_auth.get_firebase_auth_app", lambda: object())

    def _raise_invalid(*_args, **_kwargs):
        raise firebase_auth.InvalidIdTokenError("bad token")

    monkeypatch.setattr(firebase_auth, "verify_id_token", _raise_invalid)

    with pytest.raises(HTTPException) as exc:
        verify_firebase_bearer("Bearer some-token")

    assert exc.value.status_code == 401
    assert exc.value.detail == "Invalid Firebase ID token"


def test_verify_firebase_bearer_unexpected_error_returns_500(monkeypatch):
    import firebase_admin.auth as firebase_auth

    monkeypatch.setattr(
        "api.utils.firebase_auth.ensure_firebase_auth_admin",
        lambda: (True, "test-project"),
    )
    monkeypatch.setattr("api.utils.firebase_auth.get_firebase_auth_app", lambda: object())

    def _raise_runtime(*_args, **_kwargs):
        raise RuntimeError("surprise")

    monkeypatch.setattr(firebase_auth, "verify_id_token", _raise_runtime)

    with pytest.raises(HTTPException) as exc:
        verify_firebase_bearer("Bearer some-token")

    assert exc.value.status_code == 500
    assert exc.value.detail == "Internal server error"


def test_ensure_firebase_admin_uses_default_service_account(monkeypatch):
    import firebase_admin
    from firebase_admin import credentials

    default_sa = {
        "type": "service_account",
        "project_id": "hushh-pda-uat",
        "client_email": "default@example.com",
        "private_key": "test-default-private-key-material",
    }

    monkeypatch.setenv("FIREBASE_ADMIN_CREDENTIALS_JSON", json.dumps(default_sa))
    monkeypatch.setattr("api.utils.firebase_admin._get_existing_app", lambda name=None: None)

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


def test_ensure_firebase_auth_admin_falls_back_to_default_admin(monkeypatch):
    monkeypatch.setattr(
        "api.utils.firebase_admin.ensure_firebase_admin",
        lambda: (True, "hushh-pda-uat"),
    )

    assert ensure_firebase_auth_admin() == (True, "hushh-pda-uat")


def test_get_firebase_auth_app_falls_back_to_default_app(monkeypatch):
    default_app = object()

    monkeypatch.setattr(
        "api.utils.firebase_admin.ensure_firebase_auth_admin", lambda: (True, "hushh-pda")
    )
    monkeypatch.setattr(
        "api.utils.firebase_admin._get_existing_app",
        lambda name=None: default_app if name is None else None,
    )

    assert get_firebase_auth_app() is default_app
