"""Final locked-vault deletion approval uses a read-only, proof-bound review."""

from unittest.mock import AsyncMock
from uuid import uuid4

from fastapi import FastAPI
from fastapi.testclient import TestClient

from api.middleware import require_firebase_auth_read_only
from api.routes import account, account_lost_vault
from hushh_mcp.services.account_service import AccountService


def _client(monkeypatch, *, phone=None):
    app = FastAPI()
    app.include_router(account.router)
    app.dependency_overrides[require_firebase_auth_read_only] = lambda: "owner-1"
    monkeypatch.setattr(
        account,
        "_recent_federated_claims",
        lambda *_args: {"firebase": {"sign_in_provider": "google.com"}},
    )

    async def options(_uid):
        return phone, ["google.com"]

    monkeypatch.setattr(account, "_lost_vault_deletion_options", options)
    phone_proof = AsyncMock()
    monkeypatch.setattr(account, "_verify_lost_vault_phone_proof", phone_proof)
    return TestClient(app), phone_proof


def test_review_requires_the_same_phone_proof_and_creates_no_deletion(monkeypatch):
    client, phone_proof = _client(monkeypatch, phone="+16505550100")
    review = AsyncMock(
        return_value={
            "inventory_sha256": "a" * 64,
            "credential_count": 1,
            "local_erasure_required": True,
        }
    )
    deletion = AsyncMock()
    monkeypatch.setattr(account_lost_vault, "review_lost_vault_deletion", review)
    monkeypatch.setattr(AccountService, "delete_account", deletion)

    refused = client.post("/api/account/delete-lost-vault/review", json={"method": "provider"})
    assert refused.status_code == 403
    review.assert_not_awaited()
    approved = client.post(
        "/api/account/delete-lost-vault/review",
        json={
            "method": "phone",
            "phone_id_token": "phone-proof",
        },
    )
    assert approved.status_code == 200
    assert approved.headers["cache-control"] == "private, no-store"
    assert approved.json() == review.return_value
    phone_proof.assert_awaited_once_with("phone-proof", "+16505550100")
    review.assert_awaited_once_with("owner-1")
    deletion.assert_not_awaited()


def test_final_click_binds_strict_consent_and_json_continuation(monkeypatch):
    client, _ = _client(monkeypatch)
    continuation = str(uuid4())
    digest = "b" * 64
    ready = AsyncMock()
    monkeypatch.setattr("hushh_mcp.services.phone_recovery_continuation.require_ready", ready)
    review = AsyncMock(
        return_value={
            "inventory_sha256": digest,
            "credential_count": 1,
            "local_erasure_required": True,
        }
    )
    monkeypatch.setattr(account_lost_vault, "review_lost_vault_deletion", review)
    deletion = AsyncMock(
        return_value={
            "success": True,
            "account_deleted": False,
            "cleanup_pending": True,
            "cleanup_operation": {"id": str(uuid4()), "owner_id": "owner-1"},
        }
    )
    monkeypatch.setattr(AccountService, "delete_account", deletion)
    proof = {"method": "provider", "continuation_id": continuation}

    assert client.post("/api/account/delete-lost-vault/review", json=proof).status_code == 200
    assert ready.await_count == 1
    malformed = client.post(
        "/api/account/delete-lost-vault",
        json={
            **proof,
            "reviewed_inventory_sha256": digest,
            "accept_local_erasure": "true",
        },
    )
    assert malformed.status_code == 422
    missing = client.post(
        "/api/account/delete-lost-vault",
        json={
            **proof,
            "accept_local_erasure": True,
        },
    )
    assert missing.status_code == 422
    deletion.assert_not_awaited()

    result = client.post(
        "/api/account/delete-lost-vault",
        json={
            **proof,
            "reviewed_inventory_sha256": digest,
            "accept_local_erasure": True,
        },
    )
    assert result.status_code == 202
    deletion.assert_awaited_once_with(
        "owner-1",
        target="both",
        reviewed_inventory_sha256=digest,
        accept_local_erasure=True,
    )


def test_changed_review_is_definite_precommit_conflict(monkeypatch):
    client, _ = _client(monkeypatch)
    deletion = AsyncMock(
        return_value={
            "success": False,
            "account_deleted": False,
            "error_code": "ACCOUNT_DELETE_CLEANUP_REVIEW_CHANGED",
        }
    )
    monkeypatch.setattr(AccountService, "delete_account", deletion)
    result = client.post(
        "/api/account/delete-lost-vault",
        json={
            "method": "provider",
            "reviewed_inventory_sha256": "c" * 64,
            "accept_local_erasure": True,
        },
    )
    assert result.status_code == 409
    assert result.json()["code"] == "ACCOUNT_DELETE_CLEANUP_REVIEW_CHANGED"
