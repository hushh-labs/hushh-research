"""Authenticated recorded phone transport across legacy and bounded Dev lanes."""

from __future__ import annotations

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from api.middleware import require_firebase_auth
from api.routes import account
from hushh_mcp.services.actor_identity_service import ActorIdentityService


def _build_app() -> FastAPI:
    app = FastAPI()
    app.include_router(account.router)
    return app


def test_start_uat_test_phone_verification_requires_firebase_auth(monkeypatch):
    monkeypatch.setenv("ENVIRONMENT", "uat")
    monkeypatch.setenv("HUSHH_UAT_PHONE_TEST_NUMBERS", "+16505550101")
    monkeypatch.setenv("HUSHH_UAT_PHONE_TEST_CODE", "000000")

    client = TestClient(_build_app())
    response = client.post(
        "/api/account/phone/uat-test/start", json={"phone_number": "+16505550101"}
    )

    assert response.status_code == 401


@pytest.fixture
def dev_reviewer_phone(monkeypatch):
    import json
    import time
    from unittest.mock import AsyncMock

    from hushh_mcp.services.dev_reviewer_phone_transport import CONFIG_ENV

    config = {
        "enabled": True,
        "primary_user_id": "reviewer-primary",
        "phone_number": "+16505550102",
        "expires_at": int(time.time()) + 3600,
        "verification_code": "424242",
        "challenge_secret": "fixture-only-phone-pepper-32-characters",
        "platform_account_id": "acct_1UNyyyLsJU9ZDBZX",
    }
    policy = {
        "environment": "sandbox",
        "platform_account_id": "acct_1UNyyyLsJU9ZDBZX",
        "reviewer_user_ids": ["reviewer-primary", "reviewer-counterpart"],
        "reviewer_funding_cap_cents": 2000,
        "operating_capital_cap_cents": 2500,
    }
    for key, value in {
        "APP_RUNTIME_PROFILE": "dev",
        "ENVIRONMENT": "dev",
        "HUSHH_DEPLOY_ENV": "dev",
        "HUSHH_DEPLOY_SOURCE": "deploy-dev",
        "APP_REVIEW_MODE": "true",
        "APP_FRONTEND_ORIGIN": "https://dev.one.hushh.ai",
        "SCOPE_COMMERCE_STRIPE_LIVEMODE": "false",
        "SCOPE_COMMERCE_STRIPE_ACCOUNT_ID": "acct_1UNyyyLsJU9ZDBZX",
        "SCOPE_COMMERCE_SANDBOX_POLICY_REQUIRED": "true",
        "SCOPE_COMMERCE_SANDBOX_POLICY_JSON": json.dumps(policy),
        CONFIG_ENV: json.dumps(config),
    }.items():
        monkeypatch.setenv(key, value)
    app = _build_app()
    app.dependency_overrides[require_firebase_auth] = lambda: "reviewer-primary"
    claim = AsyncMock(return_value={"phone_verified": True})
    monkeypatch.setattr(ActorIdentityService, "claim_verified_phone", claim)
    return app, TestClient(app), claim, config


def test_dev_reviewer_phone_uses_authenticated_claim_without_global_phone_registration(
    dev_reviewer_phone,
):
    _, client, claim, config = dev_reviewer_phone
    start = client.post(
        "/api/account/phone/uat-test/start", json={"phone_number": config["phone_number"]}
    )
    assert start.status_code == 200 and start.json()["eligible"] is True
    response = client.post(
        "/api/account/phone/uat-test/confirm",
        json={
            "phone_number": config["phone_number"],
            "verification_code": config["verification_code"],
            "verification_id": start.json()["verification_id"],
        },
    )
    assert response.status_code == 200 and response.json()["phone_verified"] is True
    claim.assert_awaited_once_with(
        user_id="reviewer-primary",
        phone_number=config["phone_number"],
        source="dev_reviewer_test_phone_claim",
    )


@pytest.mark.parametrize("mutation", ["owner", "phone", "code", "challenge", "expired", "rotation"])
def test_dev_reviewer_phone_rejects_changed_or_expired_authority(
    dev_reviewer_phone,
    monkeypatch,
    mutation,
):
    import json
    import time

    from hushh_mcp.services.dev_reviewer_phone_transport import CONFIG_ENV

    app, client, claim, config = dev_reviewer_phone
    start = client.post(
        "/api/account/phone/uat-test/start", json={"phone_number": config["phone_number"]}
    )
    body = {
        "phone_number": config["phone_number"],
        "verification_code": config["verification_code"],
        "verification_id": start.json()["verification_id"],
    }
    if mutation == "owner":
        app.dependency_overrides[require_firebase_auth] = lambda: "reviewer-counterpart"
        assert (
            client.post(
                "/api/account/phone/uat-test/start", json={"phone_number": body["phone_number"]}
            ).json()["eligible"]
            is False
        )
    elif mutation == "phone":
        body["phone_number"] = "+16505550103"
    elif mutation == "code":
        body["verification_code"] = "123123"
    elif mutation == "challenge":
        body["verification_id"] += "x"
    elif mutation == "expired":
        monkeypatch.setattr(time, "time", lambda: config["expires_at"])
    elif mutation == "rotation":
        config["challenge_secret"] += "rotated"
        monkeypatch.setenv(CONFIG_ENV, json.dumps(config))
    response = client.post("/api/account/phone/uat-test/confirm", json=body)
    assert response.status_code in {401, 403}
    claim.assert_not_awaited()


@pytest.mark.parametrize(
    "name,value",
    [
        ("ENVIRONMENT", "production"),
        ("APP_RUNTIME_PROFILE", "production"),
        ("HUSHH_DEPLOY_ENV", "uat"),
        ("HUSHH_DEPLOY_SOURCE", "other"),
        ("APP_REVIEW_MODE", "false"),
        ("APP_FRONTEND_ORIGIN", "https://one.hushh.ai"),
        ("SCOPE_COMMERCE_STRIPE_LIVEMODE", "true"),
        ("SCOPE_COMMERCE_STRIPE_ACCOUNT_ID", "acct_other"),
        ("SCOPE_COMMERCE_SANDBOX_POLICY_REQUIRED", "false"),
        ("SCOPE_COMMERCE_SANDBOX_POLICY_JSON", "{}"),
        ("HUSHH_DEV_REVIEWER_PHONE_TEST_CONFIG_JSON", ""),
    ],
)
def test_dev_reviewer_phone_requires_all_deployment_and_sandbox_fences(
    dev_reviewer_phone,
    monkeypatch,
    name,
    value,
):
    _, client, claim, config = dev_reviewer_phone
    monkeypatch.setenv(name, value)
    response = client.post(
        "/api/account/phone/uat-test/start", json={"phone_number": config["phone_number"]}
    )
    assert response.status_code == 200 and response.json()["eligible"] is False
    claim.assert_not_awaited()


def test_start_uat_test_phone_verification_returns_challenge_for_allowlisted_number(
    monkeypatch,
):
    monkeypatch.setenv("ENVIRONMENT", "uat")
    monkeypatch.setenv("HUSHH_UAT_PHONE_TEST_NUMBERS", "+16505550101,+918080469407")
    monkeypatch.setenv("HUSHH_UAT_PHONE_TEST_CODE", "000000")
    monkeypatch.setenv("HUSHH_UAT_PHONE_TEST_CHALLENGE_SECRET", "challenge-secret")

    app = _build_app()
    app.dependency_overrides[require_firebase_auth] = lambda: "firebase_uid_123"

    client = TestClient(app)
    response = client.post(
        "/api/account/phone/uat-test/start", json={"phone_number": "+1 (650) 555-0101"}
    )

    assert response.status_code == 200
    payload = response.json()
    assert payload["eligible"] is True
    assert payload["verification_id"].startswith("uat-test-phone:")


def test_start_uat_test_phone_verification_declines_in_prod_without_prod_flag(monkeypatch):
    monkeypatch.setenv("ENVIRONMENT", "production")
    monkeypatch.setenv("HUSHH_PROD_PHONE_TEST_NUMBERS", "+16505550101")
    monkeypatch.setenv("HUSHH_PROD_PHONE_TEST_CODE", "000000")

    app = _build_app()
    app.dependency_overrides[require_firebase_auth] = lambda: "firebase_uid_123"

    client = TestClient(app)
    response = client.post(
        "/api/account/phone/uat-test/start", json={"phone_number": "+16505550101"}
    )

    assert response.status_code == 200
    assert response.json()["eligible"] is False


def test_start_uat_test_phone_verification_does_not_use_uat_secrets_in_prod(monkeypatch):
    monkeypatch.setenv("ENVIRONMENT", "production")
    monkeypatch.setenv("HUSHH_PROD_PHONE_TEST_ENABLED", "true")
    monkeypatch.setenv("HUSHH_UAT_PHONE_TEST_NUMBERS", "+16505550101")
    monkeypatch.setenv("HUSHH_UAT_PHONE_TEST_CODE", "000000")

    app = _build_app()
    app.dependency_overrides[require_firebase_auth] = lambda: "firebase_uid_123"

    client = TestClient(app)
    response = client.post(
        "/api/account/phone/uat-test/start", json={"phone_number": "+16505550101"}
    )

    assert response.status_code == 200
    assert response.json()["eligible"] is False


def test_start_uat_test_phone_verification_returns_challenge_in_enabled_prod(monkeypatch):
    monkeypatch.setenv("ENVIRONMENT", "production")
    monkeypatch.setenv("HUSHH_PROD_PHONE_TEST_ENABLED", "true")
    monkeypatch.setenv("HUSHH_PROD_PHONE_TEST_NUMBERS", "+19898989879,+19898989918")
    monkeypatch.setenv("HUSHH_PROD_PHONE_TEST_CODE", "000000")
    monkeypatch.setenv("HUSHH_PROD_PHONE_TEST_CHALLENGE_SECRET", "prod-challenge-secret")

    app = _build_app()
    app.dependency_overrides[require_firebase_auth] = lambda: "firebase_uid_123"

    client = TestClient(app)
    response = client.post(
        "/api/account/phone/uat-test/start", json={"phone_number": "+1 989 898 9879"}
    )

    assert response.status_code == 200
    payload = response.json()
    assert payload["eligible"] is True
    assert payload["verification_id"].startswith("uat-test-phone:")


def test_start_uat_test_phone_verification_requires_prod_challenge_secret(monkeypatch):
    monkeypatch.setenv("ENVIRONMENT", "production")
    monkeypatch.setenv("APP_SIGNING_KEY", "app-signing-key-fallback")
    monkeypatch.setenv("HUSHH_PROD_PHONE_TEST_ENABLED", "true")
    monkeypatch.setenv("HUSHH_PROD_PHONE_TEST_NUMBERS", "+19898989879")
    monkeypatch.setenv("HUSHH_PROD_PHONE_TEST_CODE", "000000")
    monkeypatch.delenv("HUSHH_PROD_PHONE_TEST_CHALLENGE_SECRET", raising=False)

    app = _build_app()
    app.dependency_overrides[require_firebase_auth] = lambda: "firebase_uid_123"

    client = TestClient(app)
    response = client.post(
        "/api/account/phone/uat-test/start", json={"phone_number": "+19898989879"}
    )

    assert response.status_code == 200
    assert response.json()["eligible"] is False


def test_confirm_uat_test_phone_verification_persists_verified_phone(monkeypatch):
    monkeypatch.setenv("ENVIRONMENT", "uat")
    monkeypatch.setenv("HUSHH_UAT_PHONE_TEST_NUMBERS", "+16505550101")
    monkeypatch.setenv("HUSHH_UAT_PHONE_TEST_CODE", "000000")
    monkeypatch.setenv("HUSHH_UAT_PHONE_TEST_CHALLENGE_SECRET", "challenge-secret")

    async def _mock_claim(self, *, user_id: str, phone_number: str, source: str):
        assert user_id == "firebase_uid_123"
        assert phone_number == "+16505550101"
        assert source == "uat_test_phone_claim"
        return {
            "user_id": user_id,
            "phone_number": phone_number,
            "phone_verified": True,
            "source": source,
        }

    app = _build_app()
    app.dependency_overrides[require_firebase_auth] = lambda: "firebase_uid_123"
    monkeypatch.setattr(ActorIdentityService, "claim_verified_phone", _mock_claim)

    client = TestClient(app)
    start_response = client.post(
        "/api/account/phone/uat-test/start", json={"phone_number": "+16505550101"}
    )
    verification_id = start_response.json()["verification_id"]
    response = client.post(
        "/api/account/phone/uat-test/confirm",
        json={
            "phone_number": "+16505550101",
            "verification_code": "000000",
            "verification_id": verification_id,
        },
    )

    assert response.status_code == 200
    payload = response.json()
    assert payload["phone_verified"] is True
    assert payload["identity"]["source"] == "uat_test_phone_claim"


def test_confirm_uat_test_phone_verification_persists_verified_phone_in_enabled_prod(
    monkeypatch,
):
    monkeypatch.setenv("ENVIRONMENT", "production")
    monkeypatch.setenv("HUSHH_PROD_PHONE_TEST_ENABLED", "true")
    monkeypatch.setenv("HUSHH_PROD_PHONE_TEST_NUMBERS", "+19898989918")
    monkeypatch.setenv("HUSHH_PROD_PHONE_TEST_CODE", "000000")
    monkeypatch.setenv("HUSHH_PROD_PHONE_TEST_CHALLENGE_SECRET", "prod-challenge-secret")

    async def _mock_claim(self, *, user_id: str, phone_number: str, source: str):
        assert user_id == "firebase_uid_123"
        assert phone_number == "+19898989918"
        assert source == "uat_test_phone_claim"
        return {
            "user_id": user_id,
            "phone_number": phone_number,
            "phone_verified": True,
            "source": source,
        }

    app = _build_app()
    app.dependency_overrides[require_firebase_auth] = lambda: "firebase_uid_123"
    monkeypatch.setattr(ActorIdentityService, "claim_verified_phone", _mock_claim)

    client = TestClient(app)
    start_response = client.post(
        "/api/account/phone/uat-test/start", json={"phone_number": "+19898989918"}
    )
    verification_id = start_response.json()["verification_id"]
    response = client.post(
        "/api/account/phone/uat-test/confirm",
        json={
            "phone_number": "+19898989918",
            "verification_code": "000000",
            "verification_id": verification_id,
        },
    )

    assert response.status_code == 200
    payload = response.json()
    assert payload["phone_verified"] is True
    assert payload["identity"]["source"] == "uat_test_phone_claim"


def test_confirm_uat_test_phone_verification_rejects_cross_environment_challenge(
    monkeypatch,
):
    monkeypatch.setenv("ENVIRONMENT", "uat")
    monkeypatch.setenv("HUSHH_UAT_PHONE_TEST_NUMBERS", "+19898989918")
    monkeypatch.setenv("HUSHH_UAT_PHONE_TEST_CODE", "000000")
    monkeypatch.setenv("HUSHH_UAT_PHONE_TEST_CHALLENGE_SECRET", "uat-challenge-secret")

    app = _build_app()
    app.dependency_overrides[require_firebase_auth] = lambda: "firebase_uid_123"

    client = TestClient(app)
    start_response = client.post(
        "/api/account/phone/uat-test/start", json={"phone_number": "+19898989918"}
    )
    uat_env_verification_id = start_response.json()["verification_id"]

    monkeypatch.setenv("ENVIRONMENT", "production")
    monkeypatch.setenv("HUSHH_PROD_PHONE_TEST_ENABLED", "true")
    monkeypatch.setenv("HUSHH_PROD_PHONE_TEST_NUMBERS", "+19898989918")
    monkeypatch.setenv("HUSHH_PROD_PHONE_TEST_CODE", "000000")
    monkeypatch.setenv("HUSHH_PROD_PHONE_TEST_CHALLENGE_SECRET", "prod-challenge-secret")

    response = client.post(
        "/api/account/phone/uat-test/confirm",
        json={
            "phone_number": "+19898989918",
            "verification_code": "000000",
            "verification_id": uat_env_verification_id,
        },
    )

    assert response.status_code == 401
    assert response.json()["detail"]["code"] == "UAT_PHONE_TEST_INVALID_CHALLENGE"


def test_confirm_uat_test_phone_verification_rejects_wrong_code(monkeypatch):
    monkeypatch.setenv("ENVIRONMENT", "uat")
    monkeypatch.setenv("HUSHH_UAT_PHONE_TEST_NUMBERS", "+16505550101")
    monkeypatch.setenv("HUSHH_UAT_PHONE_TEST_CODE", "000000")
    monkeypatch.setenv("HUSHH_UAT_PHONE_TEST_CHALLENGE_SECRET", "challenge-secret")

    app = _build_app()
    app.dependency_overrides[require_firebase_auth] = lambda: "firebase_uid_123"

    client = TestClient(app)
    start_response = client.post(
        "/api/account/phone/uat-test/start", json={"phone_number": "+16505550101"}
    )
    response = client.post(
        "/api/account/phone/uat-test/confirm",
        json={
            "phone_number": "+16505550101",
            "verification_code": "123456",
            "verification_id": start_response.json()["verification_id"],
        },
    )

    assert response.status_code == 401
    assert response.json()["detail"]["code"] == "UAT_PHONE_TEST_INVALID_CODE"
