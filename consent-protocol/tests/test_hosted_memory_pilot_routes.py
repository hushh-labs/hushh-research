"""Hosted pilot review cannot become a worker capability or accept secret input."""

from __future__ import annotations

from fastapi import FastAPI, HTTPException
from fastapi.testclient import TestClient

from api.middleware import require_vault_owner_token
from api.routes.one import hosted_memory_pilot
from hushh_mcp.services.hosted_memory_envelope_contract import (
    aad_sha256_hex,
    encode_base64url,
    owner_source_aad,
)
from hushh_mcp.services.hosted_memory_pilot_service import (
    HostedMemoryPilotConflict,
    HostedMemoryPilotUnavailable,
)

PENDING = {
    "status": "pending",
    "grantId": "00000000-0000-0000-0000-000000000001",
    "generation": "1",
    "sourceKind": "curated_oauth_connector",
    "sourceId": "hubspot",
    "reviewVersion": "hosted_memory_pilot.v1",
    "reviewedAt": "2026-10-15T00:00:00+00:00",
    "expiresAt": "2026-10-15T00:15:00+00:00",
    "revokedAt": None,
    "captureEnabled": False,
    "workerPaired": False,
}
REVIEW = {
    "sourceKind": "curated_oauth_connector",
    "sourceId": "hubspot",
    "reviewVersion": "hosted_memory_pilot.v1",
    "expectedGeneration": "0",
    "acknowledgeHostedCustody": True,
    "acknowledgeSourceScope": True,
}


def _client() -> tuple[TestClient, FastAPI]:
    app = FastAPI()
    app.include_router(hosted_memory_pilot.router)
    app.dependency_overrides[require_vault_owner_token] = lambda: {
        "user_id": "owner-one",
        "token": "must-not-persist",
    }
    return TestClient(app), app


def test_hosted_pilot_review_is_owner_only_pending_and_secret_free(monkeypatch):
    seen: list[tuple[str, str]] = []

    class FakeService:
        async def current(self, *, user_id: str):
            seen.append(("read", user_id))
            return {**PENDING, "internalSecret": "never-return-this"}

        async def request_pending(self, *, user_id: str, expected_generation: int, source_id: str):
            assert expected_generation == 0
            assert source_id == "hubspot"
            seen.append(("pending", user_id))
            return dict(PENDING)

        async def revoke(self, *, user_id: str):
            seen.append(("revoke", user_id))
            return {**PENDING, "status": "revoked", "generation": "2"}

    monkeypatch.setattr(hosted_memory_pilot, "HostedMemoryPilotService", FakeService)
    client, app = _client()
    route = "/api/one/hosted-memory/pilot"

    for response in (client.get(route), client.post(route, json=REVIEW), client.delete(route)):
        assert response.status_code == 200
        assert response.headers["cache-control"] == "private, no-store"
        assert response.json()["captureEnabled"] is False
        assert response.json()["workerPaired"] is False
        assert "owner-one" not in response.text
        assert "must-not-persist" not in response.text
        assert "never-return-this" not in response.text
    assert seen == [
        ("read", "owner-one"),
        ("pending", "owner-one"),
        ("revoke", "owner-one"),
    ]

    for unsafe in (
        {**REVIEW, "acknowledgeHostedCustody": False},
        {**REVIEW, "sourceKind": "payout_activity"},
        {**REVIEW, "vaultKey": "forbidden-secret"},
        {**REVIEW, "userId": "someone-else"},
    ):
        response = client.post(route, json=unsafe)
        assert response.status_code == 422
        assert response.headers["cache-control"] == "private, no-store"
        assert "forbidden-secret" not in response.text
    assert len(seen) == 3

    def reject_owner():
        raise HTTPException(status_code=401, detail="Unauthorized")

    app.dependency_overrides[require_vault_owner_token] = reject_owner
    response = client.post(route, json=REVIEW)
    assert response.status_code == 401
    assert response.headers["cache-control"] == "private, no-store"
    assert len(seen) == 3


def test_hosted_pilot_refuses_unavailable_or_activated_state(monkeypatch):
    class UnavailableService:
        async def current(self, *, user_id: str):
            raise HostedMemoryPilotUnavailable("sensitive diagnostic")

    monkeypatch.setattr(hosted_memory_pilot, "HostedMemoryPilotService", UnavailableService)
    client, _ = _client()
    route = "/api/one/hosted-memory/pilot"
    response = client.get(route)
    assert response.status_code == 503
    assert response.headers["cache-control"] == "private, no-store"
    assert "sensitive diagnostic" not in response.text

    class ChangedService:
        async def request_pending(self, *, user_id: str, expected_generation: int, source_id: str):
            raise HostedMemoryPilotConflict("stale pre-revocation request")

    monkeypatch.setattr(hosted_memory_pilot, "HostedMemoryPilotService", ChangedService)
    response = client.post(route, json=REVIEW)
    assert response.status_code == 409
    assert response.headers["cache-control"] == "private, no-store"
    assert "stale pre-revocation request" not in response.text

    class UnsafeService:
        async def current(self, *, user_id: str):
            return {**PENDING, "captureEnabled": True}

    monkeypatch.setattr(hosted_memory_pilot, "HostedMemoryPilotService", UnsafeService)
    response = client.get(route)
    assert response.status_code == 503
    assert response.headers["cache-control"] == "private, no-store"


def test_owner_envelope_route_is_private_exact_and_never_accepts_key_material(monkeypatch):
    grant_id = "e35460f9-f31c-4513-b172-8fc6d633f932"
    key_id = "57a222e6-3b5a-4d3c-95aa-bc501965002f"
    nonce = bytes(range(12))
    ciphertext = b"synthetic-ciphertext-with-tag"
    aad = owner_source_aad(
        user_id="owner-one", grant_id=grant_id, generation=4, source_id="hubspot", revision=1
    )
    body = {
        "grantId": grant_id,
        "expectedGeneration": "4",
        "sourceKind": "curated_oauth_connector",
        "sourceId": "hubspot",
        "scope": "connector_status.v1",
        "envelopeVersion": "aes256gcm.pilot.v1",
        "expectedRevision": "0",
        "keyId": key_id,
        "nonceBase64Url": encode_base64url(nonce),
        "ciphertextBase64Url": encode_base64url(ciphertext),
        "aadSha256": aad_sha256_hex(aad),
    }
    readback = {
        "grantId": grant_id,
        "generation": "4",
        "sourceKind": "curated_oauth_connector",
        "sourceId": "hubspot",
        "scope": "connector_status.v1",
        "envelopeVersion": "aes256gcm.pilot.v1",
        "keyId": key_id,
        "revision": "1",
        "nonceBase64Url": body["nonceBase64Url"],
        "ciphertextBase64Url": body["ciphertextBase64Url"],
        "ciphertextSha256": "0" * 64,
        "aadSha256": body["aadSha256"],
        "captureEnabled": False,
        "workerPaired": False,
    }
    seen: list[str] = []

    class FakeStore:
        async def stage_owner_envelope(self, **kwargs):
            assert kwargs["user_id"] == "owner-one"
            assert kwargs["source_id"] == "hubspot"
            assert kwargs["expected_revision"] == 0
            assert kwargs["nonce"] == nonce
            assert kwargs["ciphertext"] == ciphertext
            seen.append("stage")
            return {**readback, "internalOwnerId": "owner-one", "secret": "must-not-return"}

        async def owner_readback(self, *, user_id: str):
            assert user_id == "owner-one"
            seen.append("read")
            return readback

    monkeypatch.setattr(hosted_memory_pilot, "HostedMemoryEnvelopeService", FakeStore)
    client, app = _client()
    route = "/api/one/hosted-memory/pilot/envelope"
    staged = client.put(route, json=body)
    assert staged.status_code == 200
    assert staged.headers["cache-control"] == "private, no-store"
    assert staged.json() == readback
    assert "owner-one" not in staged.text
    assert "must-not-return" not in staged.text
    assert client.get(route).json() == readback
    assert seen == ["stage", "read"]

    for invalid in (
        {**body, "wrappedPilotDek": "forbidden"},
        {**body, "vaultKey": "forbidden"},
        {**body, "nonceBase64Url": "A"},
        {**body, "sourceId": "../../hubspot"},
    ):
        response = client.put(route, json=invalid)
        assert response.status_code == 422
        assert response.headers["cache-control"] == "private, no-store"
        assert "forbidden" not in response.text
    assert seen == ["stage", "read"]

    class FailingStore:
        async def stage_owner_envelope(self, **kwargs):
            raise RuntimeError("synthetic ciphertext diagnostic")

        async def owner_readback(self, *, user_id: str):
            raise RuntimeError("synthetic ciphertext diagnostic")

    monkeypatch.setattr(hosted_memory_pilot, "HostedMemoryEnvelopeService", FailingStore)
    for response in (client.put(route, json=body), client.get(route)):
        assert response.status_code == 503
        assert response.headers["cache-control"] == "private, no-store"
        assert "synthetic ciphertext diagnostic" not in response.text

    app.dependency_overrides[require_vault_owner_token] = lambda: (_ for _ in ()).throw(
        HTTPException(status_code=401, detail="Unauthorized")
    )
    assert client.put(route, json=body).status_code == 401
    assert seen == ["stage", "read"]
