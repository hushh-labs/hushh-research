from __future__ import annotations

from unittest.mock import AsyncMock

from fastapi import FastAPI
from fastapi.testclient import TestClient

from api.middleware import require_firebase_auth, require_vault_owner_token
from api.routes.one import profile_discovery as routes


def _client():
    app = FastAPI()
    app.include_router(routes.router)
    app.dependency_overrides[require_firebase_auth] = lambda: "owner-a"
    app.dependency_overrides[require_vault_owner_token] = lambda: {"user_id": "owner-a"}
    return TestClient(app)


def test_status_is_scoped_to_authenticated_firebase_owner(monkeypatch):
    status = AsyncMock(return_value={"job_id": "opaque", "status": "queued"})

    class Service:
        def status(self, **kwargs):
            return status(**kwargs)

    monkeypatch.setattr(routes, "_service", Service)
    response = _client().get(routes.router.prefix)
    assert response.status_code == 200
    assert response.json()["job"]["job_id"] == "opaque"
    status.assert_awaited_once_with(user_id="owner-a")


def test_public_scan_requires_explicit_versioned_consent(monkeypatch):
    start = AsyncMock()

    class Service:
        def start(self, **kwargs):
            return start(**kwargs)

    monkeypatch.setattr(routes, "_service", Service)
    response = _client().post(
        routes.router.prefix + "/start",
        json={"consent": False, "consentVersion": "public_profile_discovery_v1"},
    )
    assert response.status_code == 422
    assert response.json()["detail"]["code"] == "CONSENT_REQUIRED"
    start.assert_not_awaited()


def test_claim_uses_vault_owner_identity_and_revision(monkeypatch):
    complete_claim = AsyncMock(return_value={"job_id": "opaque", "status": "claimed"})

    class Service:
        def complete_claim(self, **kwargs):
            return complete_claim(**kwargs)

    monkeypatch.setattr(routes, "_service", Service)
    response = _client().post(
        routes.router.prefix + "/claim",
        headers={"Authorization": "Bearer vault-owner"},
        json={
            "profileRevision": 4,
            "idempotencyKey": "00000000-0000-0000-0000-000000000001",
            "rejectAll": True,
            "acceptedCount": 0,
        },
    )
    assert response.status_code == 200
    assert response.json()["job"]["status"] == "claimed"
    kwargs = complete_claim.await_args.kwargs
    assert kwargs["user_id"] == "owner-a"
    assert kwargs["revision"] == 4
    assert kwargs["reject_all"] is True


def test_status_does_not_expose_review_or_encrypted_draft(monkeypatch):
    service = type(
        "Service",
        (),
        {
            "status": AsyncMock(
                return_value={
                    "status": "ready",
                    "profile": {"facts": ["private"]},
                    "encrypted_draft": {"ciphertext": "sealed"},
                }
            )
        },
    )
    monkeypatch.setattr(routes, "_service", service)
    payload = _client().get(routes.router.prefix).json()["job"]
    assert payload == {"status": "ready"}
    review = _client().get(routes.router.prefix + "/review").json()["job"]
    assert review["encrypted_draft"]["ciphertext"] == "sealed"
