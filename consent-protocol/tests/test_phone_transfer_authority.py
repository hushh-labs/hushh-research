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
@pytest.mark.parametrize(
    "server_allowlist",
    [
        None,
        "HUSHH_UAT_PHONE_TEST_NUMBERS",
        "UAT_PHONE_TEST_NUMBERS",
        "HUSHH_PROD_PHONE_TEST_NUMBERS",
    ],
)
async def test_transfer_uses_authentication_event_not_refreshable_jwt_bytes(
    monkeypatch, server_allowlist
):
    import time

    from firebase_admin import auth as firebase_auth

    monkeypatch.setattr(account, "get_firebase_auth_app", lambda: object())
    monkeypatch.delenv("FIREBASE_AUTH_EMULATOR_HOST", raising=False)
    if server_allowlist:
        monkeypatch.setenv(server_allowlist, "+16505550101")
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


@pytest.mark.parametrize(
    ("provider_body", "status", "expected_code"),
    [
        ({}, 200, None),
        (
            {"signIn": {"phoneNumber": {"testPhoneNumbers": {"+16505550101": "000000"}}}},
            200,
            "PHONE_TRANSFER_REAL_SMS_REQUIRED",
        ),
        ({}, 403, "PHONE_TRANSFER_PROVIDER_UNAVAILABLE"),
        (None, 200, "PHONE_TRANSFER_PROVIDER_UNAVAILABLE"),
        ("invalid-json", 200, "PHONE_TRANSFER_PROVIDER_UNAVAILABLE"),
    ],
    ids=[
        "real-sms",
        "firebase-fictional",
        "config-refused",
        "config-unreachable",
        "config-invalid",
    ],
)
def test_provider_configuration_remains_the_fictional_phone_authority(
    monkeypatch, provider_body, status, expected_code
):
    import json
    from types import SimpleNamespace
    from unittest.mock import MagicMock, Mock

    from firebase_admin import auth

    from api.utils import firebase_admin
    from hushh_mcp.services import phone_transfer_authority as authority

    phone = "+16505550101"
    monkeypatch.setenv("HUSHH_PROD_PHONE_TEST_NUMBERS", phone)
    app = SimpleNamespace(project_id="isolated-phone-test", credential=Mock())
    user = SimpleNamespace(
        phone_number=phone, provider_data=[SimpleNamespace(provider_id="google.com")]
    )
    monkeypatch.setattr(firebase_admin, "assert_firebase_identity_mutation_allowed", lambda _: None)
    monkeypatch.setattr(auth, "get_user", Mock(return_value=user))
    response = Mock(status_code=status)
    body = b"invalid-json" if isinstance(provider_body, str) else json.dumps(provider_body).encode()
    response.iter_content.return_value = [body]
    session = MagicMock()
    session.__enter__.return_value = session
    session.get.return_value = response
    if provider_body is None:
        session.get.side_effect = ConnectionError("synthetic-config-outage")
    monkeypatch.setattr(authority, "AuthorizedSession", Mock(return_value=session))

    if expected_code is None:
        assert authority.check_provider(app, phone, "existing-proof-identity") is True
    else:
        with pytest.raises(HTTPException) as refused:
            authority.check_provider(app, phone, "existing-proof-identity")
        assert refused.value.detail["code"] == expected_code
        assert refused.value.status_code == (403 if "REAL_SMS" in expected_code else 503)
    if provider_body is not None:
        response.close.assert_called_once()
    session.__exit__.assert_called_once()


@pytest.mark.parametrize(
    ("environment", "project", "status", "code"),
    [
        ("uat", "hushh-pda", 403, "PHONE_TRANSFER_SHARED_AUTH_UNAVAILABLE"),
        ("production", "isolated-wrong-authority", 503, "PHONE_TRANSFER_PROVIDER_UNAVAILABLE"),
    ],
)
def test_provider_authority_refusal_preserves_shared_identity(
    monkeypatch, environment, project, status, code
):
    from types import SimpleNamespace
    from unittest.mock import Mock

    from firebase_admin import auth

    from api.utils import firebase_admin
    from hushh_mcp.services import phone_transfer_authority as authority

    monkeypatch.setattr(
        firebase_admin,
        "get_app_runtime_settings",
        lambda: SimpleNamespace(environment=environment, runtime_profile=""),
    )
    provider_read, provider_config = Mock(), Mock()
    monkeypatch.setattr(auth, "get_user", provider_read)
    monkeypatch.setattr(authority, "AuthorizedSession", provider_config)
    with pytest.raises(HTTPException) as refused:
        authority.check_provider(SimpleNamespace(project_id=project), "+16505550101", "proof-owner")
    assert refused.value.status_code == status
    assert refused.value.detail["code"] == code
    if status == 403:
        assert refused.value.detail["message"] == (
            "Phone transfer is unavailable in this environment. "
            "Recover your previous account or use another number."
        )
    provider_read.assert_not_called()
    provider_config.assert_not_called()


@pytest.mark.asyncio
async def test_fixed_code_challenge_cannot_be_used_as_signed_sms_transfer_proof(monkeypatch):
    from unittest.mock import Mock

    from firebase_admin import auth

    from hushh_mcp.services import phone_test_transport

    monkeypatch.setattr(phone_test_transport, "_phone_test_challenge_key", lambda: "synthetic-key")
    challenge = phone_test_transport._create_uat_phone_test_verification_id("+16505550101")
    monkeypatch.setattr(account, "get_firebase_auth_app", lambda: object())
    verify = Mock(side_effect=ValueError("unsigned fixed-code challenge"))
    monkeypatch.setattr(auth, "verify_id_token", verify)
    with pytest.raises(HTTPException) as refused:
        await account._verify_phone_claim_id_token(challenge, transfer=True)
    assert refused.value.status_code == 401
    assert refused.value.detail["code"] == "INVALID_PHONE_ID_TOKEN"
    assert verify.call_args.args[0] == challenge
    assert verify.call_args.kwargs["check_revoked"] is True


@pytest.mark.parametrize("proof", ["reviewer", "trusted-device", "emulator", "stale"])
def test_non_sms_or_stale_transfer_proof_remains_refused(monkeypatch, proof):
    import time

    from hushh_mcp.services import phone_transfer_authority as authority

    monkeypatch.delenv("FIREBASE_AUTH_EMULATOR_HOST", raising=False)
    claims = {"auth_time": int(time.time())}
    if proof == "reviewer":
        claims["hushh_review_mint"] = "uat"
    elif proof == "trusted-device":
        claims["trusted_device_id"] = "synthetic-device"
    elif proof == "emulator":
        monkeypatch.setenv("FIREBASE_AUTH_EMULATOR_HOST", "localhost:9099")
    else:
        claims["auth_time"] -= 301
    with pytest.raises(HTTPException) as refused:
        authority.require_fresh_sms_claims(claims, "+16505550101")
    assert refused.value.detail["code"] == (
        "PHONE_TRANSFER_STALE" if proof == "stale" else "PHONE_TRANSFER_REAL_SMS_REQUIRED"
    )


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
