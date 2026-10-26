"""Owner-bound transfer and trusted-device authority regressions."""

import asyncio
from unittest.mock import AsyncMock

import pytest
from fastapi import FastAPI, HTTPException
from fastapi.testclient import TestClient

from api.middleware import require_firebase_auth
from api.routes import account
from api.utils import firebase_auth as firebase_auth_module
from api.utils.firebase_auth import verify_firebase_bearer
from hushh_mcp.services.account_deletion_lifecycle_service import AccountDeletionLifecycleService

pytestmark = pytest.mark.feature_auth_reliability


def _build_app():
    app = FastAPI()
    app.include_router(account.router)
    return app


@pytest.mark.asyncio
async def test_phone_proof_cannot_approve_a_device_and_gain_owner_authority(monkeypatch):
    from firebase_admin import auth as firebase_auth

    monkeypatch.setenv("ACCOUNT_GENERATION_ADMISSION_ENABLED", "false")
    monkeypatch.setattr(account, "get_firebase_auth_app", lambda: object())
    monkeypatch.setattr(
        firebase_auth,
        "verify_id_token",
        lambda *_args, **_kwargs: {
            "uid": "previous",
            "firebase": {"sign_in_provider": "phone"},
            "phone_number": "+16505550101",
        },
    )
    with pytest.raises(HTTPException) as error:
        await account._verify_browser_enrollment_identity("Bearer synthetic-phone-proof")
    assert error.value.status_code == 403
    assert error.value.detail["code"] == "AUTH_INDEPENDENT_SIGN_IN_REQUIRED"


def test_phone_proof_cannot_mint_owner_authority_but_social_signin_can(monkeypatch):
    monkeypatch.setattr(AccountDeletionLifecycleService, "is_tombstoned", lambda _uid: False)
    from firebase_admin import auth as firebase_auth

    monkeypatch.setenv("ACCOUNT_GENERATION_ADMISSION_ENABLED", "false")
    monkeypatch.setattr(firebase_auth_module, "ensure_firebase_auth_admin", lambda: (True, "test"))
    monkeypatch.setattr(firebase_auth_module, "get_firebase_auth_app", lambda: object())
    monkeypatch.setattr(
        firebase_auth,
        "verify_id_token",
        lambda *_args, **_kwargs: {"uid": "previous", "firebase": {"sign_in_provider": "phone"}},
    )
    with pytest.raises(HTTPException) as error:
        verify_firebase_bearer("Bearer synthetic-phone-proof", require_independent_signin=True)
    assert error.value.detail["code"] == "AUTH_INDEPENDENT_SIGN_IN_REQUIRED"
    monkeypatch.setattr(
        firebase_auth,
        "verify_id_token",
        lambda *_args, **_kwargs: {
            "uid": "previous",
            "firebase": {"sign_in_provider": "google.com"},
        },
    )
    assert (
        verify_firebase_bearer("Bearer synthetic-social-proof", require_independent_signin=True)
        == "previous"
    )


def test_transfer_routes_require_current_owner_and_explicit_confirmation(monkeypatch):
    from uuid import uuid4

    from hushh_mcp.services import phone_transfer_service

    app = _build_app()
    app.dependency_overrides[require_firebase_auth] = lambda: "receiving"
    verify = AsyncMock(return_value=("+16505550101", "previous"))
    confirm = AsyncMock()
    monkeypatch.setattr(account, "_verify_phone_claim_id_token", verify)
    monkeypatch.setattr(phone_transfer_service, "confirm", confirm)
    client = TestClient(app)
    base = {
        "phone_id_token": "synthetic-proof",
        "expected_user_id": "receiving",
        "transfer_id": str(uuid4()),
    }
    assert client.post("/api/account/phone/transfer/confirm", json=base).status_code == 422
    assert (
        client.post(
            "/api/account/phone/transfer/confirm", json={**base, "confirmed": False}
        ).status_code
        == 422
    )
    switched = client.post(
        "/api/account/phone/transfer/confirm",
        json={**base, "confirmed": True, "expected_user_id": "retired-owner"},
    )
    assert switched.status_code == 409
    verify.assert_not_called()
    confirm.assert_not_called()


@pytest.mark.asyncio
async def test_transfer_uses_authentication_event_not_refreshable_jwt_bytes(monkeypatch):
    import time

    from firebase_admin import auth as firebase_auth

    monkeypatch.setattr(account, "get_firebase_auth_app", lambda: object())
    stamp = int(time.time())
    monkeypatch.setattr(
        firebase_auth,
        "verify_id_token",
        lambda *_args, **_kwargs: {
            "uid": "previous",
            "phone_number": "+16505550101",
            "auth_time": stamp,
            "firebase": {"sign_in_provider": "phone"},
        },
    )
    first, refreshed = {}, {}
    assert await account._verify_phone_claim_id_token(
        "first-signed-jwt", transfer=True, proof_metadata=first
    ) == ("+16505550101", "previous")
    await account._verify_phone_claim_id_token(
        "refreshed-signed-jwt", transfer=True, proof_metadata=refreshed
    )
    assert first == refreshed
    assert first["valid_until"] == stamp + 300


def test_phone_session_cleanup_never_tombstones_an_existing_phone_only_account(monkeypatch):
    from firebase_admin import auth as firebase_auth

    monkeypatch.setattr(account, "get_firebase_auth_app", lambda: object())

    class _Provider:
        provider_id = "phone"

    class _User:
        phone_number = "+16505550101"
        email = None
        provider_data = [_Provider()]

    monkeypatch.setattr(firebase_auth, "get_user", lambda *_args, **_kwargs: _User())
    monkeypatch.setattr(
        AccountDeletionLifecycleService,
        "record_pending_if_account_state_absent",
        lambda *, user_id, expected_phone_digest: False,
    )

    status = asyncio.run(
        account._prepare_safe_phone_session_cleanup_intent(
            uid="established-phone-only-account",
            phone_number="+16505550101",
            protected_uid="different-primary-account",
        )
    )

    assert status == "protected_existing_account"
