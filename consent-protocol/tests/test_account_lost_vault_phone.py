"""Full-number comparison is read-only and never substitutes for final proof."""

import pytest
from fastapi.testclient import TestClient

from api.routes import account
from tests.test_account_routes import _lost_vault_app


@pytest.mark.parametrize(
    ("candidate", "status", "code"),
    [
        ("+1 (415) 555-2671", 200, None),
        ("+12125552671", 403, "ACCOUNT_DELETE_PHONE_MISMATCH"),
        ("4155552671", 422, "ACCOUNT_DELETE_PHONE_INVALID"),
        ("+1415", 422, "ACCOUNT_DELETE_PHONE_INVALID"),
    ],
)
def test_lost_vault_phone_preflight_compares_complete_normalized_binding(
    monkeypatch, candidate, status, code
):
    from firebase_admin import auth as firebase_auth

    app = _lost_vault_app(monkeypatch, phone="+14155552671")
    monkeypatch.setattr(
        firebase_auth,
        "verify_id_token",
        lambda *_args, **_kwargs: {
            "uid": "user_123",
            "auth_time": account.time.time(),
            "firebase": {"sign_in_provider": "google.com"},
        },
    )

    async def unexpected_erasure(*_args, **_kwargs):
        pytest.fail("Phone comparison must never erase an account")

    monkeypatch.setattr(account, "_perform_account_deletion", unexpected_erasure)
    response = TestClient(app).post(
        "/api/account/delete-lost-vault/phone",
        headers={"Authorization": "Bearer provider-token"},
        json={"phone_number": candidate},
    )
    assert response.status_code == status
    assert response.headers["cache-control"] == "private, no-store"
    assert response.json() == ({"valid": True} if code is None else {"detail": {"code": code}})
    assert "+14155552671" not in response.text


@pytest.mark.parametrize(
    "change", ["stale", "wrong_owner", "phone_provider", "unenrolled_provider"]
)
def test_lost_vault_phone_preflight_requires_fresh_enrolled_provider_for_current_owner(
    monkeypatch, change
):
    from firebase_admin import auth as firebase_auth

    app = _lost_vault_app(monkeypatch, phone="+14155552671")
    claims = {
        "uid": "user_123",
        "auth_time": account.time.time(),
        "firebase": {"sign_in_provider": "google.com"},
    }
    if change == "stale":
        claims["auth_time"] -= 600
    elif change == "wrong_owner":
        claims["uid"] = "another-owner"
    else:
        claims["firebase"] = {
            "sign_in_provider": "phone" if change == "phone_provider" else "apple.com"
        }
    monkeypatch.setattr(firebase_auth, "verify_id_token", lambda *_args, **_kwargs: claims)
    response = TestClient(app).post(
        "/api/account/delete-lost-vault/phone",
        headers={"Authorization": "Bearer provider-token"},
        json={"phone_number": "+14155552671"},
    )
    assert response.status_code == 401
    assert response.json()["detail"]["code"] == "ACCOUNT_DELETE_REAUTH_REQUIRED"


@pytest.mark.parametrize(
    ("phone", "firebase_phone", "unavailable", "status", "code"),
    [
        (None, None, False, 409, "ACCOUNT_DELETE_METHOD_UNAVAILABLE"),
        ("+14155552671", "+12125552671", False, 409, "ACCOUNT_DELETE_PHONE_BINDING_CONFLICT"),
        ("+14155552671", None, True, 503, "ACCOUNT_DELETE_VERIFICATION_UNAVAILABLE"),
    ],
)
def test_lost_vault_phone_preflight_fails_closed_on_missing_conflicting_or_unavailable_binding(
    monkeypatch, phone, firebase_phone, unavailable, status, code
):
    from firebase_admin import auth as firebase_auth

    app = _lost_vault_app(monkeypatch, phone=phone, firebase_phone=firebase_phone)
    monkeypatch.setattr(
        firebase_auth,
        "verify_id_token",
        lambda *_args, **_kwargs: {
            "uid": "user_123",
            "auth_time": account.time.time(),
            "firebase": {"sign_in_provider": "google.com"},
        },
    )
    if unavailable:

        def unavailable_lookup(*_args, **_kwargs):
            raise RuntimeError("Unavailable")

        monkeypatch.setattr(firebase_auth, "get_user", unavailable_lookup)
    response = TestClient(app).post(
        "/api/account/delete-lost-vault/phone",
        headers={"Authorization": "Bearer provider-token"},
        json={"phone_number": "+14155552671"},
    )
    assert response.status_code == status
    assert response.json()["detail"]["code"] == code
    assert response.headers["cache-control"] == "private, no-store"


def test_lost_vault_phone_preflight_is_not_authority_after_binding_changes(monkeypatch):
    from firebase_admin import auth as firebase_auth

    app = _lost_vault_app(monkeypatch, phone="+14155552671")
    monkeypatch.setattr(
        firebase_auth,
        "verify_id_token",
        lambda token, **_kwargs: (
            {
                "uid": "user_123",
                "auth_time": account.time.time(),
                "firebase": {"sign_in_provider": "google.com"},
            }
            if token == "provider-token"
            else {
                "uid": "isolated-phone-owner",
                "phone_number": "+14155552671",
                "auth_time": account.time.time(),
                "firebase": {"sign_in_provider": "phone"},
            }
        ),
    )
    client = TestClient(app)
    headers = {"Authorization": "Bearer provider-token"}
    assert client.post(
        "/api/account/delete-lost-vault/phone",
        headers=headers,
        json={"phone_number": "+14155552671"},
    ).json() == {"valid": True}

    async def changed_binding(_uid):
        return "+12125552671", ["google.com"]

    async def unexpected_erasure(*_args, **_kwargs):
        pytest.fail("An earlier comparison cannot authorize deletion after rebinding")

    monkeypatch.setattr(account, "_lost_vault_deletion_options", changed_binding)
    monkeypatch.setattr(account, "_perform_account_deletion", unexpected_erasure)
    response = client.post(
        "/api/account/delete-lost-vault",
        headers=headers,
        json={"method": "phone", "phone_id_token": "old-phone-proof"},
    )
    assert response.status_code == 401
    assert response.json()["detail"]["code"] == "ACCOUNT_DELETE_PHONE_PROOF_INVALID"
