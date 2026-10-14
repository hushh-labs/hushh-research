"""Hosted pilot review cannot become a worker capability or accept secret input."""

from __future__ import annotations

from fastapi import FastAPI, HTTPException
from fastapi.testclient import TestClient

from api.middleware import require_vault_owner_token
from api.routes.one import hosted_memory_pilot
from hushh_mcp.services.hosted_memory_pilot_service import (
    HostedMemoryPilotConflict,
    HostedMemoryPilotUnavailable,
)

PENDING = {
    "status": "pending",
    "grantId": "00000000-0000-0000-0000-000000000001",
    "generation": "1",
    "sourceKind": "curated_oauth_connector",
    "reviewVersion": "hosted_memory_pilot.v1",
    "reviewedAt": "2026-10-15T00:00:00+00:00",
    "expiresAt": "2026-10-15T00:15:00+00:00",
    "revokedAt": None,
    "captureEnabled": False,
    "workerPaired": False,
}
REVIEW = {
    "sourceKind": "curated_oauth_connector",
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

        async def request_pending(self, *, user_id: str, expected_generation: int):
            assert expected_generation == 0
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
        async def request_pending(self, *, user_id: str, expected_generation: int):
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
