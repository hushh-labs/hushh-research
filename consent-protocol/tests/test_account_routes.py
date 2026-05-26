from __future__ import annotations

from fastapi import FastAPI, HTTPException
from fastapi.testclient import TestClient

from api.middleware import require_firebase_auth, require_vault_owner_token
from api.routes import account
from hushh_mcp.services.account_service import AccountService
from hushh_mcp.services.actor_identity_service import ActorIdentityService


def _build_app() -> FastAPI:
    app = FastAPI()
    app.include_router(account.router)
    return app


def test_refresh_account_identity_requires_firebase_auth():
    client = TestClient(_build_app())
    response = client.post("/api/account/identity/refresh")

    assert response.status_code == 401


def test_refresh_account_identity_returns_synced_identity(monkeypatch):
    async def _mock_sync(self, firebase_uid: str, force: bool = False):
        assert firebase_uid == "firebase_uid_123"
        assert force is True
        return {"personas": ["investor"], "last_active_persona": "investor"}

    app = _build_app()
    app.dependency_overrides[require_firebase_auth] = lambda: "firebase_uid_123"
    monkeypatch.setattr(ActorIdentityService, "sync_from_firebase", _mock_sync)

    client = TestClient(app)
    response = client.post("/api/account/identity/refresh")

    assert response.status_code == 200
    payload = response.json()
    assert payload["success"] is True
    assert payload["user_id"] == "firebase_uid_123"
    assert payload["identity"]["last_active_persona"] == "investor"


def test_claim_account_phone_requires_firebase_auth():
    client = TestClient(_build_app())
    response = client.post(
        "/api/account/phone/claim", json={"phone_id_token": "phone-claim-sample"}
    )

    assert response.status_code == 401


def test_claim_account_phone_persists_verified_phone(monkeypatch):
    async def _mock_verify(raw_claim: str):
        assert raw_claim == "phone-claim-sample"
        return "+16505550101", "phone-session-uid"

    async def _mock_claim(self, *, user_id: str, phone_number: str):
        assert user_id == "firebase_uid_123"
        assert phone_number == "+16505550101"
        return {
            "user_id": user_id,
            "phone_number": phone_number,
            "phone_verified": True,
            "source": "firebase_phone_claim",
        }

    app = _build_app()
    app.dependency_overrides[require_firebase_auth] = lambda: "firebase_uid_123"
    monkeypatch.setattr(account, "_verify_phone_claim_id_token", _mock_verify)
    monkeypatch.setattr(ActorIdentityService, "claim_verified_phone", _mock_claim)

    client = TestClient(app)
    response = client.post(
        "/api/account/phone/claim", json={"phone_id_token": "phone-claim-sample"}
    )

    assert response.status_code == 200
    payload = response.json()
    assert payload["success"] is True
    assert payload["phone_verified"] is True
    assert payload["identity"]["phone_number"] == "+16505550101"


def test_claim_account_phone_rejects_invalid_phone_token(monkeypatch):
    async def _mock_verify(raw_claim: str):
        raise HTTPException(
            status_code=401,
            detail={
                "code": "INVALID_PHONE_ID_TOKEN",
                "message": "The phone verification token is invalid or expired.",
            },
        )

    app = _build_app()
    app.dependency_overrides[require_firebase_auth] = lambda: "firebase_uid_123"
    monkeypatch.setattr(account, "_verify_phone_claim_id_token", _mock_verify)

    client = TestClient(app)
    response = client.post("/api/account/phone/claim", json={"phone_id_token": "bad-phone-claim"})

    assert response.status_code == 401
    assert response.json()["detail"]["code"] == "INVALID_PHONE_ID_TOKEN"


def test_claim_account_phone_rejects_phone_token_without_phone_number(monkeypatch):
    async def _mock_verify(raw_claim: str):
        raise HTTPException(
            status_code=422,
            detail={
                "code": "PHONE_ID_TOKEN_MISSING_PHONE_NUMBER",
                "message": "The phone verification token does not contain a phone number.",
            },
        )

    app = _build_app()
    app.dependency_overrides[require_firebase_auth] = lambda: "firebase_uid_123"
    monkeypatch.setattr(account, "_verify_phone_claim_id_token", _mock_verify)

    client = TestClient(app)
    response = client.post(
        "/api/account/phone/claim", json={"phone_id_token": "phone-claim-sample"}
    )

    assert response.status_code == 422
    assert response.json()["detail"]["code"] == "PHONE_ID_TOKEN_MISSING_PHONE_NUMBER"


def test_claim_account_phone_maps_persistence_failure(monkeypatch):
    async def _mock_verify(raw_claim: str):
        return "+16505550101", "phone-session-uid"

    async def _mock_claim(self, *, user_id: str, phone_number: str):
        return None

    app = _build_app()
    app.dependency_overrides[require_firebase_auth] = lambda: "firebase_uid_123"
    monkeypatch.setattr(account, "_verify_phone_claim_id_token", _mock_verify)
    monkeypatch.setattr(ActorIdentityService, "claim_verified_phone", _mock_claim)

    client = TestClient(app)
    response = client.post(
        "/api/account/phone/claim", json={"phone_id_token": "phone-claim-sample"}
    )

    assert response.status_code == 503
    assert response.json()["detail"]["code"] == "PHONE_CLAIM_PERSISTENCE_UNAVAILABLE"


def test_start_uat_test_phone_verification_requires_firebase_auth(monkeypatch):
    monkeypatch.setenv("ENVIRONMENT", "uat")
    monkeypatch.setenv("HUSHH_UAT_PHONE_TEST_NUMBERS", "+16505550101")
    monkeypatch.setenv("HUSHH_UAT_PHONE_TEST_CODE", "000000")

    client = TestClient(_build_app())
    response = client.post(
        "/api/account/phone/uat-test/start", json={"phone_number": "+16505550101"}
    )

    assert response.status_code == 401


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


def test_start_uat_test_phone_verification_declines_when_not_uat(monkeypatch):
    monkeypatch.setenv("ENVIRONMENT", "production")
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


def test_list_email_aliases_requires_vault_owner_token():
    client = TestClient(_build_app())
    response = client.get("/api/account/email-aliases")

    assert response.status_code == 401


def test_email_alias_verification_flow_uses_vault_owner(monkeypatch):
    async def _mock_list(self, user_id: str):
        assert user_id == "user_123"
        return [{"email_normalized": "original@example.com", "verification_status": "verified"}]

    async def _mock_start(self, *, user_id: str, email: str):
        assert user_id == "user_123"
        assert email == "Original@Example.com"
        return {
            "alias": {"email_normalized": "original@example.com", "verification_status": "pending"},
            "already_verified": False,
            "review_verification_code": "123456",
        }

    async def _mock_confirm(self, *, user_id: str, email: str, verification_code: str):
        assert user_id == "user_123"
        assert email == "original@example.com"
        assert verification_code == "123456"
        return {"email_normalized": "original@example.com", "verification_status": "verified"}

    app = _build_app()
    app.dependency_overrides[require_vault_owner_token] = lambda: {"user_id": "user_123"}
    monkeypatch.setattr(ActorIdentityService, "list_verified_email_aliases", _mock_list)
    monkeypatch.setattr(ActorIdentityService, "request_email_alias_verification", _mock_start)
    monkeypatch.setattr(ActorIdentityService, "confirm_email_alias_verification", _mock_confirm)

    client = TestClient(app)

    list_response = client.get("/api/account/email-aliases")
    assert list_response.status_code == 200
    assert list_response.json()["aliases"][0]["verification_status"] == "verified"

    start_response = client.post(
        "/api/account/email-aliases/verification/start",
        json={"email": "Original@Example.com"},
    )
    assert start_response.status_code == 200
    assert start_response.json()["review_verification_code"] == "123456"

    confirm_response = client.post(
        "/api/account/email-aliases/verification/confirm",
        json={"email": "original@example.com", "verification_code": "123456"},
    )
    assert confirm_response.status_code == 200
    assert confirm_response.json()["alias"]["verification_status"] == "verified"


def test_delete_account_requires_vault_owner_token():
    client = TestClient(_build_app())
    response = client.delete("/api/account/delete")

    assert response.status_code == 401


def test_delete_account_defaults_target_to_both(monkeypatch):
    deleted_auth_users = []

    async def _mock_delete(self, user_id: str, target: str = "both"):
        assert user_id == "user_123"
        assert target == "both"
        return {"success": True, "deleted_target": "both", "account_deleted": True}

    async def _mock_delete_firebase_user(user_id: str):
        deleted_auth_users.append(user_id)
        return "deleted"

    app = _build_app()
    app.dependency_overrides[require_vault_owner_token] = lambda: {"user_id": "user_123"}
    monkeypatch.setattr(AccountService, "delete_account", _mock_delete)
    monkeypatch.setattr(account, "_delete_firebase_auth_user", _mock_delete_firebase_user)

    client = TestClient(app)
    response = client.delete("/api/account/delete")

    assert response.status_code == 200
    payload = response.json()
    assert payload["success"] is True
    assert payload["account_deleted"] is True
    assert payload["details"]["firebase_auth_user"] == "deleted"
    assert deleted_auth_users == ["user_123"]


def test_delete_account_forwards_requested_target(monkeypatch):
    deleted_auth_users = []

    async def _mock_delete(self, user_id: str, target: str = "both"):
        assert user_id == "user_123"
        assert target == "investor"
        return {"success": True, "deleted_target": "investor", "remaining_personas": ["ria"]}

    async def _mock_delete_firebase_user(user_id: str):
        deleted_auth_users.append(user_id)
        return "deleted"

    app = _build_app()
    app.dependency_overrides[require_vault_owner_token] = lambda: {"user_id": "user_123"}
    monkeypatch.setattr(AccountService, "delete_account", _mock_delete)
    monkeypatch.setattr(account, "_delete_firebase_auth_user", _mock_delete_firebase_user)

    client = TestClient(app)
    response = client.request(
        "DELETE",
        "/api/account/delete",
        json={"target": "investor"},
    )

    assert response.status_code == 200
    payload = response.json()
    assert payload["deleted_target"] == "investor"
    assert payload["remaining_personas"] == ["ria"]
    assert deleted_auth_users == []


def test_delete_account_maps_service_failure_to_500(monkeypatch):
    async def _mock_delete(self, user_id: str, target: str = "both"):
        assert user_id == "user_123"
        assert target == "both"
        return {"success": False, "error": "boom"}

    app = _build_app()
    app.dependency_overrides[require_vault_owner_token] = lambda: {"user_id": "user_123"}
    monkeypatch.setattr(AccountService, "delete_account", _mock_delete)

    client = TestClient(app)
    response = client.delete("/api/account/delete")

    assert response.status_code == 500
    assert response.json()["detail"] == "Account deletion failed"


def test_export_account_data_requires_vault_owner_token():
    client = TestClient(_build_app())
    response = client.get("/api/account/export")

    assert response.status_code == 401


def test_export_account_data_returns_service_payload(monkeypatch):
    async def _mock_export(self, user_id: str):
        assert user_id == "user_123"
        return {
            "success": True,
            "requested_target": "account",
            "data": {
                "actor_profile": {"user_id": "user_123"},
                "encrypted_vault_keys": [],
            },
        }

    app = _build_app()
    app.dependency_overrides[require_vault_owner_token] = lambda: {"user_id": "user_123"}
    monkeypatch.setattr(AccountService, "export_data", _mock_export)

    client = TestClient(app)
    response = client.get("/api/account/export")

    assert response.status_code == 200
    payload = response.json()
    assert payload["success"] is True
    assert payload["requested_target"] == "account"
    assert payload["data"]["actor_profile"]["user_id"] == "user_123"


def test_export_account_data_maps_failure_to_500(monkeypatch):
    async def _mock_export(self, user_id: str):
        assert user_id == "user_123"
        return {"success": False, "error": "boom"}

    app = _build_app()
    app.dependency_overrides[require_vault_owner_token] = lambda: {"user_id": "user_123"}
    monkeypatch.setattr(AccountService, "export_data", _mock_export)

    client = TestClient(app)
    response = client.get("/api/account/export")

    assert response.status_code == 500
    assert response.json()["detail"] == "Account export failed"
