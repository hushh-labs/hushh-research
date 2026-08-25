"""One CONTINUOUS pod lifecycle against shared state: provision -> serve ->
teardown -> re-provision, with nothing hand-seeded between the steps.

The two halves of phone-recycle safety are asserted today in isolation:
test_deprovision_tombstones_then_deletes stops after the delete, and
test_provision_rotates_generation_for_recycled_phone hand-injects the tombstone
it reacts to. Neither proves the chain: the tombstone the REAL deprovision path
writes (provisioning_service.deprovision) is the same record the next
provision's _next_free_generation reads via tombstone_exists, rotating to a new
generation / HusshID / pods/{hushh_id} storage prefix. The identity-PRESERVING
half (reap: host-only teardown, row kept, same HusshID on re-provision) is the
reconcile worker's contract, exercised here through the real sweep.

Same doubles as tests/test_personal_agent_provisioning_service.py; the registry
fake is subclassed ONLY because its upsert pins rows' external_agent_id to
None, which would make deprovision skip host teardown and gut the cycle.
"""

from __future__ import annotations

from datetime import datetime

import pytest

from hushh_mcp.runtime_settings import get_core_security_settings
from hushh_mcp.services import personal_agent_identity_service as ident
from hushh_mcp.services.compute_backend import BackendHandle, PodSpec
from hushh_mcp.services.personal_agent_provisioning_service import (
    PersonalAgentProvisioningService,
)
from hushh_mcp.services.personal_agent_reconcile_worker import (
    IdlePod,
    PersonalAgentReconcileWorker,
)
from hushh_mcp.services.pod_connector_keypair_service import generate_pod_keypair
from tests.test_personal_agent_provisioning_service import FakeGrant, FakeRegistry

_OWNER_A = "firebase_uid_cycle_A"
_OWNER_B = "firebase_uid_cycle_B"
_PHONE = "+14255550177"


class CycleRegistry(FakeRegistry):
    """FakeRegistry whose rows keep every non-None upserted field.

    Mirrors the real repo's upsert (None fields dropped, on_conflict keeps
    prior columns), so the row deprovision() reads back carries the
    external_agent_id the provision wrote. The base fake discards it, which
    would silently skip host teardown in the continuous flow.
    """

    async def upsert(self, **kw):
        self.upserts.append(kw)
        row = self.rows.setdefault(kw["user_id"], {})
        row.update({k: v for k, v in kw.items() if v is not None})


class CycleBackend:
    """Compute-host fake that tracks the live fleet across the whole cycle."""

    backend_id = "gcp"

    def __init__(self):
        self.provisioned: list[PodSpec] = []
        self.deprovisioned: list[str] = []
        self.live_hosts: set[str] = set()

    async def provision(self, spec):
        self.provisioned.append(spec)
        external_agent_id = f"one-pod-{spec.hushh_id}"
        self.live_hosts.add(external_agent_id)
        return BackendHandle(
            external_agent_id=external_agent_id,
            a2a_route=f"https://a2a.hushh.ai/u/{spec.hushh_id}",
            status="planned",
            backend="gcp",
            backend_metadata={},
        )

    async def deprovision(self, external_agent_id):
        self.deprovisioned.append(external_agent_id)
        self.live_hosts.discard(external_agent_id)

    async def get(self, external_agent_id):
        return None

    def render_deploy_config(self, spec):
        return {}

    async def health(self):
        return True


@pytest.fixture(autouse=True)
def _env(monkeypatch):
    # Autouse fixtures do not travel with an import; replicated from the
    # neighbouring module verbatim. The reconcile flag is additionally required
    # here: scan_and_reconcile() returns a skipped empty report unless BOTH
    # kill-switches are on, and the reap test walks the real sweep.
    monkeypatch.setenv("APP_SIGNING_KEY", "test_secret_key_for_ci_only_32chars_min")
    monkeypatch.setenv("VAULT_DATA_KEY", "0" * 64)
    monkeypatch.setenv("PERSONAL_AGENT_ENABLED", "1")
    monkeypatch.setenv("PERSONAL_AGENT_RECONCILE_ENABLED", "1")
    get_core_security_settings.cache_clear()
    yield
    get_core_security_settings.cache_clear()


@pytest.fixture()
def cycle():
    registry = CycleRegistry()
    backend = CycleBackend()
    svc = PersonalAgentProvisioningService(registry=registry, grant=FakeGrant(), backend=backend)
    return registry, backend, svc


async def _provision(svc, *, user_id):
    pod = generate_pod_keypair().public()
    return await svc.provision(
        user_id=user_id,
        phone_e164=_PHONE,
        pod_public_key_b64=pod.public_key_b64,
        pod_key_id=pod.key_id,
    )


async def test_full_deprovision_then_same_phone_provision_rotates_identity(cycle):
    registry, backend, svc = cycle

    # 1. Provision: owner A stands up a pod at generation 0.
    first = await _provision(svc, user_id=_OWNER_A)
    gen0 = ident.mint_hushh_id(_PHONE, 0)
    assert first["hushhId"] == gen0
    assert backend.live_hosts == {f"one-pod-{gen0}"}

    # 2. Teardown through the REAL deprovision path. No fixture seeds the
    #    tombstone; everything step 3 reads was written here.
    down = await svc.deprovision(user_id=_OWNER_A)
    assert down["status"] == "deprovisioned"
    assert down["teardownReachedHost"] is True
    assert down["unreclaimed"] is False
    assert backend.deprovisioned == [f"one-pod-{gen0}"]
    assert backend.live_hosts == set()
    assert registry.deleted == [_OWNER_A]
    assert len(registry.tombstones) == 1
    assert registry.tombstones[0]["hushh_id"] == gen0
    assert registry.tombstones[0]["status"] == "deprovision_requested"

    # 3. Owner B receives the recycled phone. _next_free_generation reads the
    #    tombstone step 2 wrote and rotates: new HusshID, and with it a fresh
    #    pods/{hushh_id} storage prefix (SECURITY-REVIEW.md L1) -- the prior
    #    owner's identity is never resurrected.
    second = await _provision(svc, user_id=_OWNER_B)
    gen1 = ident.mint_hushh_id(_PHONE, 1)
    assert second["hushhId"] == gen1
    assert second["hushhId"] != first["hushhId"]

    # The PodSpec is what keys pod storage: distinct hushh_ids, distinct prefixes.
    assert [s.hushh_id for s in backend.provisioned] == [gen0, gen1]
    assert backend.live_hosts == {f"one-pod-{gen1}"}
    # Shared state ends consistent: B carries the rotated identity, A is gone.
    assert _OWNER_A not in registry.rows
    assert registry.rows[_OWNER_B]["hushh_id"] == gen1


async def test_reap_then_reprovision_preserves_identity(cycle):
    registry, backend, svc = cycle

    # 1. Provision: generation 0, host live.
    first = await _provision(svc, user_id=_OWNER_A)
    gen0 = ident.mint_hushh_id(_PHONE, 0)
    host = registry.rows[_OWNER_A]["external_agent_id"]
    assert first["hushhId"] == gen0

    # 2. Reap through the REAL reconcile sweep: host-only teardown. "No revoke,
    #    no tombstone, no row delete" is the worker's stated contract, exercised
    #    here rather than restated. fetch_idle reads the row provision wrote.
    async def fetch_idle(idle_since: datetime):
        row = registry.rows[_OWNER_A]
        return [
            IdlePod(
                user_id=_OWNER_A,
                hushh_id=row["hushh_id"],
                external_agent_id=row["external_agent_id"],
            )
        ]

    async def fetch_stalled():
        return []

    async def retry(user_id: str):
        raise AssertionError("nothing is stalled; retry must not run")

    worker = PersonalAgentReconcileWorker(
        fetch_stalled=fetch_stalled,
        retry=retry,
        fetch_idle=fetch_idle,
        reap=backend.deprovision,
    )
    report = await worker.scan_and_reconcile()
    assert report.reaped_count == 1
    assert backend.deprovisioned == [host]
    assert backend.live_hosts == set()
    # Identity intact: no tombstone written, row kept.
    assert registry.tombstones == []
    assert registry.deleted == []
    assert registry.rows[_OWNER_A]["hushh_id"] == gen0

    # 3. Re-provision the SAME owner and phone. No tombstone exists, so
    #    _next_free_generation lands back on 0: the SAME HusshID, so the new
    #    host addresses the same pods/{hushh_id} prefix and the person's
    #    records are still theirs.
    second = await _provision(svc, user_id=_OWNER_A)
    assert second["hushhId"] == first["hushhId"] == gen0
    assert [s.hushh_id for s in backend.provisioned] == [gen0, gen0]
    assert backend.live_hosts == {f"one-pod-{gen0}"}
    assert registry.rows[_OWNER_A]["hushh_id"] == gen0
