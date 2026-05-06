from __future__ import annotations

from fastapi import FastAPI
from fastapi.testclient import TestClient

from api.routes.one import email as one_email


def _build_app(user_id: str = "user_123") -> TestClient:
    app = FastAPI()
    app.include_router(one_email.router)
    app.dependency_overrides[one_email.require_vault_owner_token] = lambda: {
        "user_id": user_id,
        "scope": "vault.owner",
        "token": "vault-token",
    }
    return TestClient(app)


def test_one_kyc_route_rejects_user_mismatch():
    client = _build_app(user_id="user_123")

    response = client.get("/api/one/kyc/workflows?user_id=other_user")

    assert response.status_code == 403


def test_one_watch_renew_rejects_missing_maintenance_token(monkeypatch):
    monkeypatch.setenv("ONE_EMAIL_WATCH_RENEW_AUTH_ENABLED", "true")
    monkeypatch.setenv("ONE_EMAIL_WATCH_RENEW_TOKEN", "expected-token")
    client = _build_app()

    response = client.post("/api/one/email/watch/renew")

    assert response.status_code == 401
    assert response.json()["detail"]["code"] == "ONE_EMAIL_WATCH_RENEW_UNAUTHORIZED"


def test_one_watch_renew_auth_follows_deploy_environment(monkeypatch):
    monkeypatch.delenv("ENVIRONMENT", raising=False)
    monkeypatch.delenv("ONE_EMAIL_WATCH_RENEW_AUTH_ENABLED", raising=False)
    monkeypatch.setenv("HUSHH_DEPLOY_ENV", "uat")
    monkeypatch.setenv("ONE_EMAIL_WATCH_RENEW_TOKEN", "expected-token")
    client = _build_app()

    response = client.post("/api/one/email/watch/renew")

    assert response.status_code == 401
    assert response.json()["detail"]["code"] == "ONE_EMAIL_WATCH_RENEW_UNAUTHORIZED"


def test_one_kyc_reject_route_uses_authenticated_user(monkeypatch):
    calls: list[dict] = []

    class _Service:
        async def reject_draft(self, *, user_id: str, workflow_id: str, reason: str | None = None):
            calls.append({"user_id": user_id, "workflow_id": workflow_id, "reason": reason})
            return {"workflow_id": workflow_id, "user_id": user_id, "status": "blocked"}

    monkeypatch.setattr(one_email, "_service", lambda: _Service())
    client = _build_app(user_id="user_123")

    response = client.post(
        "/api/one/kyc/workflows/workflow_123/reject-draft",
        json={"user_id": "user_123", "reason": "No"},
    )

    assert response.status_code == 200
    assert response.json()["status"] == "blocked"
    assert calls == [{"user_id": "user_123", "workflow_id": "workflow_123", "reason": "No"}]


def test_one_kyc_send_approved_reply_forwards_transient_body(monkeypatch):
    calls: list[dict] = []
    artifact_hash = "a" * 64

    class _Service:
        async def send_approved_reply(self, **kwargs):
            calls.append(kwargs)
            return {
                "workflow_id": kwargs["workflow_id"],
                "user_id": kwargs["user_id"],
                "status": "waiting_on_counterparty",
                "draft_status": "sent",
            }

    monkeypatch.setattr(one_email, "_service", lambda: _Service())
    client = _build_app(user_id="user_123")

    response = client.post(
        "/api/one/kyc/workflows/workflow_123/send-approved-reply",
        json={
            "user_id": "user_123",
            "approved_subject": "Re: KYC",
            "approved_body": "Approved body",
            "client_draft_hash": "hash_1",
            "consent_export_revision": 1,
            "pkm_writeback_artifact_hash": artifact_hash,
        },
    )

    assert response.status_code == 200
    assert response.json()["draft_status"] == "sent"
    assert calls == [
        {
            "user_id": "user_123",
            "workflow_id": "workflow_123",
            "approved_subject": "Re: KYC",
            "approved_body": "Approved body",
            "client_draft_hash": "hash_1",
            "consent_export_revision": 1,
            "pkm_writeback_artifact_hash": artifact_hash,
        }
    ]


def test_one_kyc_client_connector_registration_uses_vault_user(monkeypatch):
    calls: list[dict] = []

    class _Service:
        async def register_client_connector(self, **kwargs):
            calls.append(kwargs)
            return {
                "configured": True,
                "connector": {"connector_key_id": kwargs["connector_key_id"]},
            }

    monkeypatch.setattr(one_email, "_service", lambda: _Service())
    client = _build_app(user_id="user_123")

    response = client.post(
        "/api/one/kyc/client-connector",
        json={
            "user_id": "user_123",
            "connector_public_key": "x" * 44,
            "connector_key_id": "one-kyc-test",
            "connector_wrapping_alg": "X25519-AES256-GCM",
            "public_key_fingerprint": "fp",
        },
    )

    assert response.status_code == 200
    assert response.json()["configured"] is True
    assert calls == [
        {
            "user_id": "user_123",
            "connector_public_key": "x" * 44,
            "connector_key_id": "one-kyc-test",
            "connector_wrapping_alg": "X25519-AES256-GCM",
            "public_key_fingerprint": "fp",
        }
    ]


def test_one_kyc_workflow_consent_export_uses_vault_user_without_consent_token(monkeypatch):
    calls: list[dict] = []

    class _Service:
        async def get_workflow_consent_export(self, **kwargs):
            calls.append(kwargs)
            return {
                "status": "success",
                "encrypted_data": "ciphertext",
                "iv": "iv",
                "tag": "tag",
                "wrapped_key_bundle": {"connector_key_id": "one-kyc-test"},
            }

    monkeypatch.setattr(one_email, "_service", lambda: _Service())
    client = _build_app(user_id="user_123")

    response = client.get("/api/one/kyc/workflows/workflow_123/consent-export?user_id=user_123")

    assert response.status_code == 200
    assert response.json()["encrypted_data"] == "ciphertext"
    assert "consent_token" not in response.text
    assert calls == [{"user_id": "user_123", "workflow_id": "workflow_123"}]
