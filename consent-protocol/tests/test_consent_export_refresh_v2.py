from __future__ import annotations

import base64
from pathlib import Path
from types import SimpleNamespace

from fastapi import FastAPI
from fastapi.testclient import TestClient

from api.routes import consent
from hushh_mcp.consent.export_envelope import (
    ConsentExportAadV2,
    ConsentExportEnvelopeSubmissionV2,
    canonical_aad_bytes,
    ciphertext_digest_from_base64,
    digest_bytes,
)

_CLAIM_ID = "123e4567-e89b-12d3-a456-426614174111"
_EXPORT_ID = "123e4567-e89b-12d3-a456-426614174000"
_EXPIRY = 1_800_000_000_000


def _build_app(*, user_id: str = "user_123") -> FastAPI:
    app = FastAPI()
    app.include_router(consent.router)
    app.dependency_overrides[consent.require_vault_owner_token] = lambda: {"user_id": user_id}
    return app


def _upload_payload() -> dict:
    encrypted_data = base64.b64encode(b"new-ciphertext").decode()
    aad = ConsentExportAadV2(
        app_id="app_demo",
        grant_id="req_demo",
        export_id=_EXPORT_ID,
        revision=2,
        machine_scope="attr.financial.portfolio.*",
        scope_handle="s_portfolio_demo",
        recipient_key_fingerprint=f"sha256:{'a' * 64}",
        expires_at_ms=_EXPIRY,
    )
    ciphertext_sha256, ciphertext_bytes = ciphertext_digest_from_base64(encrypted_data)
    envelope = ConsentExportEnvelopeSubmissionV2(
        export_id=_EXPORT_ID,
        aad=aad,
        aad_sha256=digest_bytes(canonical_aad_bytes(aad)),
        ciphertext_sha256=ciphertext_sha256,
        ciphertext_bytes=ciphertext_bytes,
    )
    return {
        "userId": "user_123",
        "jobClaimId": _CLAIM_ID,
        "expectedPriorRevision": 1,
        "encryptedData": encrypted_data,
        "encryptedIv": "iv",
        "encryptedTag": "tag",
        "wrappedExportKey": "wrapped",
        "wrappedKeyIv": "wrapped_iv",
        "wrappedKeyTag": "wrapped_tag",
        "senderPublicKey": "sender_public",
        "wrappingAlg": "X25519-AES256-GCM",
        "connectorKeyId": "connector_demo",
        "sourceContentRevision": 2,
        "sourceManifestRevision": 2,
        "exportEnvelope": envelope.model_dump(mode="json"),
    }


def _active_token():
    return SimpleNamespace(
        user_id="user_123",
        agent_id="developer:app_demo",
        scope_str="attr.financial.portfolio.*",
        scope=SimpleNamespace(value="attr.financial.portfolio.*"),
        expires_at=_EXPIRY,
    )


def _existing_export(**overrides):
    row = {
        "scope": "attr.financial.portfolio.*",
        "refresh_policy": "continuous_until_expiry",
        "refresh_status": "refresh_pending",
        "export_revision": 1,
        "envelope_version": 2,
        "export_id": _EXPORT_ID,
        "grant_id": "req_demo",
        "app_id": "app_demo",
        "scope_handle": "s_portfolio_demo",
        "recipient_key_fingerprint": f"sha256:{'a' * 64}",
        "connector_key_id": "connector_demo",
        "connector_wrapping_alg": "X25519-AES256-GCM",
    }
    row.update(overrides)
    return row


def test_job_claim_response_never_returns_consent_token(monkeypatch):
    class _FakeService:
        async def claim_consent_export_refresh_jobs(self, _user_id: str):
            return [
                {
                    "claim_id": _CLAIM_ID,
                    "consent_token": "must_not_leave_backend",
                    "granted_scope": "attr.financial.portfolio.*",
                    "status": "processing",
                    "expected_export_revision": 1,
                }
            ]

        async def get_active_tokens(self, _user_id: str):
            return [
                {
                    "token_id": "must_not_leave_backend",
                    "scope": "attr.financial.portfolio.*",
                    "expires_at": _EXPIRY,
                    "metadata": {"connector_public_key": "public_key"},
                }
            ]

        async def get_consent_export_metadata(self, _token: str):
            return {
                **_existing_export(refresh_status="refresh_pending"),
                "is_strict_zero_knowledge": True,
            }

    monkeypatch.setattr(consent, "ConsentDBService", _FakeService)
    response = TestClient(_build_app()).get("/api/consent/export-refresh/jobs?userId=user_123")

    assert response.status_code == 200
    job = response.json()["jobs"][0]
    assert job["jobClaimId"] == _CLAIM_ID
    assert "consentToken" not in job
    assert "must_not_leave_backend" not in response.text


def test_refresh_upload_rejects_snapshot_before_commit(monkeypatch):
    class _FakeService:
        async def get_claimed_consent_export_refresh_job(self, **_kwargs):
            return {
                "consent_token": "consent_demo",
                "expected_export_revision": 1,
            }

        async def get_consent_export(self, _token: str):
            return _existing_export(refresh_policy="snapshot")

    async def _validate(_token: str):
        return True, None, _active_token()

    monkeypatch.setattr(consent, "ConsentDBService", _FakeService)
    monkeypatch.setattr(consent, "validate_token_with_db", _validate)
    response = TestClient(_build_app()).post(
        "/api/consent/export-refresh/upload", json=_upload_payload()
    )

    assert response.status_code == 409
    assert response.json()["detail"]["error_code"] == "SNAPSHOT_EXPORT_IMMUTABLE"


def test_refresh_revision_cas_conflict_fails_closed(monkeypatch):
    captured = {}

    class _FakeService:
        async def get_claimed_consent_export_refresh_job(self, **_kwargs):
            return {
                "consent_token": "consent_demo",
                "expected_export_revision": 1,
            }

        async def get_consent_export(self, _token: str):
            return _existing_export()

        async def complete_claimed_consent_export_refresh(self, **kwargs):
            captured.update(kwargs)
            return False

    async def _validate(_token: str):
        return True, None, _active_token()

    monkeypatch.setattr(consent, "ConsentDBService", _FakeService)
    monkeypatch.setattr(consent, "validate_token_with_db", _validate)
    response = TestClient(_build_app()).post(
        "/api/consent/export-refresh/upload", json=_upload_payload()
    )

    assert response.status_code == 409
    assert response.json()["detail"]["error_code"] == "EXPORT_REFRESH_CONFLICT"
    assert captured["expected_export_revision"] == 1
    assert captured["claim_id"] == _CLAIM_ID


def test_refresh_failure_is_bound_to_authenticated_user_and_claim(monkeypatch):
    captured = {}

    class _FakeService:
        async def fail_consent_export_refresh_job(self, **kwargs):
            captured.update(kwargs)
            return True

    monkeypatch.setattr(consent, "ConsentDBService", _FakeService)
    client = TestClient(_build_app())
    response = client.post(
        "/api/consent/export-refresh/fail",
        json={"userId": "user_123", "jobClaimId": _CLAIM_ID, "lastError": "redacted"},
    )
    assert response.status_code == 200
    assert captured == {
        "user_id": "user_123",
        "claim_id": _CLAIM_ID,
        "last_error": "redacted",
    }

    cross_user = TestClient(_build_app(user_id="different_user")).post(
        "/api/consent/export-refresh/fail",
        json={"userId": "user_123", "jobClaimId": _CLAIM_ID},
    )
    assert cross_user.status_code == 403


def test_migration_contains_claim_lease_and_atomic_revision_cas() -> None:
    sql = (
        Path(__file__).parents[1] / "db/migrations/088_consent_export_envelope_v2.sql"
    ).read_text()
    assert "FOR UPDATE OF jobs SKIP LOCKED" in sql
    assert "claim_consent_export_refresh_jobs_v2" in sql
    assert "complete_consent_export_refresh_v2" in sql
    assert "export_revision = p_expected_export_revision" in sql
