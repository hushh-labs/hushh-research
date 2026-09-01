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


def test_provision_accepts_an_empty_body(monkeypatch):
    """The browser has no pod key, and this is the route it must be able to call.

    The pod generates its X25519 keypair inside its own runtime and publishes only
    the public half, so a caller asking for an agent that does not exist yet cannot
    supply one. Declaring the key fields required made this route uncallable from the
    product -- which is why the only path to a pod was a fire-and-forget hook off
    phone verification, and why dev has every flag on and zero pods.
    """
    client, calls = _build(monkeypatch)
    resp = client.post("/api/one/personal-agent/provision", json={})

    assert resp.status_code == 200
    assert resp.json()["success"] is True
    # The service's deferred-key branch is selected by BOTH being None. Sending ""
    # would take the half-supplied branch and raise instead.
    assert calls["provision"]["pod_public_key_b64"] is None
    assert calls["provision"]["pod_key_id"] is None


def test_provision_accepts_no_body_at_all(monkeypatch):
    """A caller with nothing to say should not have to send `{}` to say it."""
    client, _ = _build(monkeypatch)
    assert client.post("/api/one/personal-agent/provision").status_code == 200


@pytest.mark.parametrize("half", [{"podKeyId": "pod-1"}, {"podPublicKey": "k"}])
def test_provision_still_rejects_a_half_supplied_key_pair(monkeypatch, half):
    """Optional does not mean lenient.

    "No key yet" and "a key the caller believed it handed over" are different, and
    reading the second as the first would silently drop a real key. The rejection
    moved from Pydantic to the service, which is where the pair is validated -- so
    this asserts the pair still arrives intact rather than being normalised away.
    """
    client, calls = _build(monkeypatch)
    resp = client.post("/api/one/personal-agent/provision", json=half)

    assert resp.status_code == 200  # the fake service does not validate
    forwarded = calls["provision"]
    supplied = [
        forwarded["pod_public_key_b64"],
        forwarded["pod_key_id"],
    ]
    # Exactly one half present. The real service raises ValueError on this shape and
    # the route turns it into a 400 INVALID_PROVISION_INPUT.
    assert len([v for v in supplied if v]) == 1


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


def test_status_none_when_no_row_and_flag_off(monkeypatch):
    # Honest even while the feature is off: never 404, never silent -- and no
    # row means NOTHING was started. "reserved" claimed the positive ("held and
    # ready to activate") for an absence (audit finding, 2026-08-21).
    client = _status_client(monkeypatch, row=None, enabled=False)
    resp = client.get("/api/one/personal-agent/status")
    assert resp.status_code == 200
    body = resp.json()
    assert body["state"] == "none"
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


def test_status_fails_safe_to_none(monkeypatch):
    # A registry read failure claims NOTHING it did not read: "none" degrades
    # the surface to "no pod shown" rather than asserting a held reservation.
    client = _status_client(monkeypatch, raises=True)
    resp = client.get("/api/one/personal-agent/status")
    assert resp.status_code == 200
    assert resp.json()["state"] == "none"


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
        # Written by pod_wake on a CONFIRMED-gone host: renders as `failed` so the
        # presence chip shows its recovery affordance; the shared recovery classifier
        # then routes it to cloud-reconnect (reinit), not a rebuild into a dead project.
        ("needs_reinit", "failed"),
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


def test_status_names_the_pods_cloud_identity(monkeypatch):
    # WHERE the agent lives and AS WHOM it thinks: the pod's public coordinates
    # were invisible everywhere in the product (founder finding, 2026-08-21).
    client = _status_client(
        monkeypatch,
        row={
            "status": "provisioned",
            "hushh_id": "ha1_abc",
            "user_cloud_project": "hussh-one-kd8rb4",
            "user_cloud_region": "us-central1",
            "deployment_target": "user_gcp",
            "model_credential_mode": "user_adc",
        },
        enabled=True,
    )
    body = client.get("/api/one/personal-agent/status").json()
    assert body["cloudProject"] == "hussh-one-kd8rb4"
    assert body["cloudRegion"] == "us-central1"
    assert body["deploymentTarget"] == "user_gcp"
    assert body["credentialMode"] == "user_adc"


def test_status_omits_cloud_identity_when_unrecorded(monkeypatch):
    client = _status_client(
        monkeypatch, row={"status": "pending", "hushh_id": "ha1_abc"}, enabled=True
    )
    body = client.get("/api/one/personal-agent/status").json()
    assert "cloudProject" not in body
    assert "credentialMode" not in body


# --------------------------------------------------------------------------- #
# The space-name (spaceID handle) write path
# --------------------------------------------------------------------------- #
#
# The handle is the owner's product-facing name for their space. This is its ONLY
# write path -- provisioning never sets it -- so these pin that a name is
# validated, that it cannot be set before an agent exists, and that it is written
# to `space_id` (the handle) and NEVER conflated with `billing_space_id`.


class _FakeRepo:
    def __init__(self, row):
        self._row = row
        self.upserts: list[dict] = []

    async def get(self, user_id):
        return self._row

    async def upsert(self, **kwargs):
        self.upserts.append(kwargs)


def _build_space(monkeypatch, *, row, enabled=True):
    from fastapi import FastAPI
    from fastapi.testclient import TestClient

    monkeypatch.setenv("PERSONAL_AGENT_ENABLED", "1" if enabled else "0")
    repo = _FakeRepo(row)
    monkeypatch.setattr(pa, "PersonalAgentRegistryRepo", lambda: repo)
    app = FastAPI()
    app.include_router(pa.router)
    app.dependency_overrides[require_firebase_auth] = lambda: "uid1"
    return TestClient(app), repo


def test_set_space_name_rejects_an_unsafe_name(monkeypatch):
    client, repo = _build_space(monkeypatch, row={"hushh_id": "ha1_x", "status": "provisioned"})
    r = client.put("/api/one/personal-agent/space-name", json={"spaceName": "a/b\nc"})
    assert r.status_code == 400
    assert r.json()["detail"]["code"] == "INVALID_SPACE_NAME"
    assert repo.upserts == []


def test_set_space_name_refuses_when_no_agent_exists(monkeypatch):
    client, repo = _build_space(monkeypatch, row=None)
    r = client.put("/api/one/personal-agent/space-name", json={"spaceName": "Home"})
    assert r.status_code == 409
    assert r.json()["detail"]["code"] == "NO_AGENT"
    assert repo.upserts == []


def test_set_space_name_writes_the_handle_not_the_billing_id(monkeypatch):
    client, repo = _build_space(monkeypatch, row={"hushh_id": "ha1_x", "status": "provisioned"})
    r = client.put("/api/one/personal-agent/space-name", json={"spaceName": "Kushal's Space"})
    assert r.status_code == 200
    assert r.json() == {"success": True, "spaceName": "Kushal's Space"}
    assert len(repo.upserts) == 1
    written = repo.upserts[0]
    assert written["space_id"] == "Kushal's Space"
    # The write must NOT touch billing_space_id -- the two columns stay independent.
    assert "billing_space_id" not in written or written["billing_space_id"] is None


def test_get_space_name_returns_the_handle(monkeypatch):
    client, _ = _build_space(monkeypatch, row={"space_id": "Home", "hushh_id": "ha1_x"})
    r = client.get("/api/one/personal-agent/space-name")
    assert r.status_code == 200
    assert r.json() == {"spaceName": "Home"}


def test_space_name_is_flag_gated(monkeypatch):
    client, _ = _build_space(monkeypatch, row={"hushh_id": "ha1_x"}, enabled=False)
    r = client.put("/api/one/personal-agent/space-name", json={"spaceName": "Home"})
    assert r.status_code in (403, 404, 503)
