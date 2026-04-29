from __future__ import annotations

from fastapi import FastAPI
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


def test_delete_account_requires_vault_owner_token():
    client = TestClient(_build_app())
    response = client.delete("/api/account/delete")

    assert response.status_code == 401


def test_delete_account_defaults_target_to_both(monkeypatch):
    async def _mock_delete(self, user_id: str, target: str = "both"):
        assert user_id == "user_123"
        assert target == "both"
        return {"success": True, "deleted_target": "both", "account_deleted": True}

    app = _build_app()
    app.dependency_overrides[require_vault_owner_token] = lambda: {"user_id": "user_123"}
    monkeypatch.setattr(AccountService, "delete_account", _mock_delete)

    client = TestClient(app)
    response = client.delete("/api/account/delete")

    assert response.status_code == 200
    payload = response.json()
    assert payload["success"] is True
    assert payload["account_deleted"] is True


def test_delete_account_forwards_requested_target(monkeypatch):
    async def _mock_delete(self, user_id: str, target: str = "both"):
        assert user_id == "user_123"
        assert target == "investor"
        return {"success": True, "deleted_target": "investor", "remaining_personas": ["ria"]}

    app = _build_app()
    app.dependency_overrides[require_vault_owner_token] = lambda: {"user_id": "user_123"}
    monkeypatch.setattr(AccountService, "delete_account", _mock_delete)

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
    assert response.json()["detail"] == "Deletion failed: boom"


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
