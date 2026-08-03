"""Route-contract tests for the owner-authorized personal-agent provisioning.

TestClient with the VAULT_OWNER dependency overridden and the identity +
provisioning services monkeypatched to fakes, so the route is exercised without
auth, DB, or token minting. Verifies the flag gate, the owner-token requirement,
the verified-phone precondition, and that the handler forwards the pod key.
"""

from __future__ import annotations

import json

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from api.middleware import require_firebase_auth, require_vault_owner_token
from api.routes.one import personal_agent as pa


def _build(monkeypatch, *, enabled=True, phone_verified=True):
    monkeypatch.setenv("PERSONAL_AGENT_ENABLED", "1" if enabled else "0")
    calls: dict = {}

    class FakeIdentity:
        async def get_many(self, ids):
            uid = ids[0]
            if phone_verified:
                return {uid: {"phone_verified": True, "phone_number": "+14255550133"}}
            return {uid: {"phone_verified": False}}

    class FakeProvisioning:
        def __init__(self, *args, **kwargs):
            pass

        async def provision(self, **kw):
            calls["provision"] = kw
            return {"hushhId": "ha1_x", "status": "provisioned", "standingReadExpiresAt": 123}

        async def deprovision(self, **kw):
            calls["deprovision"] = kw
            return {"status": "deprovisioned", "hushhId": "ha1_x"}

    monkeypatch.setattr(pa, "ActorIdentityService", lambda: FakeIdentity())
    monkeypatch.setattr(pa, "PersonalAgentProvisioningService", FakeProvisioning)
    monkeypatch.setattr(pa, "PersonalAgentRegistryRepo", lambda: object())

    app = FastAPI()
    app.include_router(pa.router)
    app.dependency_overrides[require_vault_owner_token] = lambda: {"user_id": "uid1"}
    return TestClient(app), calls


def test_provision_requires_flag(monkeypatch):
    client, _ = _build(monkeypatch, enabled=False)
    resp = client.post(
        "/api/one/personal-agent/provision", json={"podPublicKey": "k", "podKeyId": "pod-1"}
    )
    assert resp.status_code == 404


def test_provision_requires_verified_phone(monkeypatch):
    client, _ = _build(monkeypatch, phone_verified=False)
    resp = client.post(
        "/api/one/personal-agent/provision", json={"podPublicKey": "k", "podKeyId": "pod-1"}
    )
    assert resp.status_code == 409
    assert resp.json()["detail"]["code"] == "PHONE_NOT_VERIFIED"


def test_provision_forwards_pod_key(monkeypatch):
    client, calls = _build(monkeypatch)
    resp = client.post(
        "/api/one/personal-agent/provision",
        json={"podPublicKey": "cG9kcHVi", "podKeyId": "pod-1"},
    )
    assert resp.status_code == 200
    body = resp.json()
    assert body["success"] is True
    assert body["hushhId"] == "ha1_x"
    assert calls["provision"]["user_id"] == "uid1"
    assert calls["provision"]["phone_e164"] == "+14255550133"
    assert calls["provision"]["pod_public_key_b64"] == "cG9kcHVi"
    assert calls["provision"]["pod_key_id"] == "pod-1"


def test_deprovision_requires_flag(monkeypatch):
    client, _ = _build(monkeypatch, enabled=False)
    resp = client.post("/api/one/personal-agent/deprovision")
    assert resp.status_code == 404


def test_deprovision_calls_service(monkeypatch):
    client, calls = _build(monkeypatch)
    resp = client.post("/api/one/personal-agent/deprovision")
    assert resp.status_code == 200
    assert resp.json()["status"] == "deprovisioned"
    assert calls["deprovision"]["user_id"] == "uid1"


@pytest.mark.parametrize("missing", [{"podKeyId": "pod-1"}, {"podPublicKey": "k"}])
def test_provision_validates_body(monkeypatch, missing):
    client, _ = _build(monkeypatch)
    resp = client.post("/api/one/personal-agent/provision", json=missing)
    assert resp.status_code == 422


def _status_client(monkeypatch, *, row=None, raises=False, enabled=False):
    monkeypatch.setenv("PERSONAL_AGENT_ENABLED", "1" if enabled else "0")

    class FakeRepo:
        async def get(self, _user_id):
            if raises:
                raise RuntimeError("db down")
            return row

    monkeypatch.setattr(pa, "PersonalAgentRegistryRepo", lambda: FakeRepo())
    app = FastAPI()
    app.include_router(pa.router)
    app.dependency_overrides[require_firebase_auth] = lambda: "uid1"
    return TestClient(app)


def test_status_reserved_when_no_row_and_flag_off(monkeypatch):
    # Honest even while the feature is off: never 404, never silent.
    client = _status_client(monkeypatch, row=None, enabled=False)
    resp = client.get("/api/one/personal-agent/status")
    assert resp.status_code == 200
    body = resp.json()
    assert body["state"] == "reserved"
    assert body["featureEnabled"] is False
    assert "hushhId" not in body


def test_status_active_when_provisioned(monkeypatch):
    client = _status_client(
        monkeypatch, row={"status": "provisioned", "hushh_id": "ha1_abc"}, enabled=True
    )
    resp = client.get("/api/one/personal-agent/status")
    assert resp.status_code == 200
    body = resp.json()
    assert body["state"] == "active"
    assert body["hushhId"] == "ha1_abc"


def test_status_reserved_when_pending(monkeypatch):
    client = _status_client(monkeypatch, row={"status": "pending", "hushh_id": "ha1_abc"})
    resp = client.get("/api/one/personal-agent/status")
    assert resp.json()["state"] == "reserved"


def test_status_fails_safe_to_reserved(monkeypatch):
    client = _status_client(monkeypatch, raises=True)
    resp = client.get("/api/one/personal-agent/status")
    assert resp.status_code == 200
    assert resp.json()["state"] == "reserved"


# --- state vocabulary -------------------------------------------------------
# Provisioning has real intermediate states, so collapsing everything that is not
# "provisioned" into "reserved" told the customer something false while their agent
# was mid-flight. These pin the whole map, both directions.


@pytest.mark.parametrize(
    "registry_status,expected_state",
    [
        # Written by the schema DEFAULT (migration 900) and register_pending().
        ("unprovisioned", "reserved"),
        ("pending", "reserved"),
        # Written by PersonalAgentProvisioningService.provision().
        ("provisioning", "provisioning"),
        ("provisioned", "active"),
        # Declared ahead of their writer (Workstreams B/C); unreachable today.
        ("connecting", "connecting"),
        ("provisioning_failed", "failed"),
    ],
)
def test_status_maps_every_registry_status(monkeypatch, registry_status, expected_state):
    client = _status_client(monkeypatch, row={"status": registry_status})
    assert client.get("/api/one/personal-agent/status").json()["state"] == expected_state


@pytest.mark.parametrize(
    "registry_status",
    [
        "",
        "  ",
        # Tombstone-only value: it belongs to personal_agent_deletion_tombstones,
        # never to the registry, so the registry seeing it is already a defect.
        "deprovision_requested",
        # A status a newer backend might write that this build has never heard of.
        "some_future_status",
        "PROVISIONED",  # case matters: the writers are all lowercase
    ],
)
def test_status_degrades_unknown_status_to_reserved(monkeypatch, registry_status):
    client = _status_client(monkeypatch, row={"status": registry_status})
    body = client.get("/api/one/personal-agent/status").json()
    assert body["state"] == "reserved"
    # The contract that matters most here: a raw DB value never reaches the client.
    assert registry_status.strip() not in json.dumps(body) or not registry_status.strip()


def test_status_never_leaks_a_raw_db_value(monkeypatch):
    # A status carrying something that must not be echoed (an internal id, a hint of
    # an exception) still renders exactly one of the closed state vocabulary.
    client = _status_client(monkeypatch, row={"status": "error: connect ECONNREFUSED 10.0.0.4"})
    body = client.get("/api/one/personal-agent/status").json()
    assert body["state"] == "reserved"
    assert "ECONNREFUSED" not in json.dumps(body)


def test_status_intermediate_states_are_honest_while_flag_off(monkeypatch):
    # The endpoint is deliberately NOT flag-gated: it reports the row it can see
    # even with PERSONAL_AGENT_ENABLED off, and says so in featureEnabled.
    client = _status_client(
        monkeypatch, row={"status": "provisioning", "hushh_id": "ha1_abc"}, enabled=False
    )
    body = client.get("/api/one/personal-agent/status").json()
    assert body["state"] == "provisioning"
    assert body["featureEnabled"] is False
    assert body["hushhId"] == "ha1_abc"


def test_status_state_vocabulary_is_closed():
    # Guards the client contract: every value the map can emit is one the frontend
    # (hushh-webapp/components/dashboard/one-agent-presence.tsx) renders.
    assert set(pa._STATE_BY_REGISTRY_STATUS.values()) <= {
        "reserved",
        "provisioning",
        "connecting",
        "active",
        "failed",
    }
    assert pa._DEFAULT_STATE == "reserved"
