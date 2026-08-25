"""adopt_orphan reconnects a lost row to a pod that is ALREADY running, never rebuilds.

The recovery contract, pinned: a returning user whose registry row was lost but whose
deterministically-named pod still lives in their own project is RECONNECTED (identity +
memory preserved), not re-provisioned (duplicate) and not rebuilt (new identity). These
exercise the orchestration adopt_orphan adds -- reconstruct a `connecting` row from the
discovered handle, then hand off to the SAME key-collector provision finishes with -- and
stop at the seams the existing suites already cover (the key pull + grant mint live in
test_pod_key_custody.py, so refresh_pod_key is faked here -- but with a RECORDING fake, so
the one thing adopt_orphan owns, handing the reconstructed connecting row to the collector,
is still asserted).
"""

from __future__ import annotations

from types import SimpleNamespace

import pytest

import hushh_mcp.services.personal_agent_provisioning_service as pa_svc
from hushh_mcp.services.compute_backend import BackendHandle
from hushh_mcp.services.personal_agent_provisioning_service import (
    PersonalAgentProvisioningService,
)


class _FakeRegistry:
    def __init__(self, row):
        self._row = dict(row) if row else None
        self.upserts: list[dict] = []

    async def get(self, _user_id):
        return dict(self._row) if self._row is not None else None

    async def upsert(self, **kwargs):
        self.upserts.append(kwargs)
        # Reflect the write so a subsequent get() sees the reconstructed row.
        self._row = {**(self._row or {}), **{k: v for k, v in kwargs.items() if v is not None}}


class _DiscoverBackend:
    """A backend that finds a live user-owned pod for this identity."""

    def __init__(self, handle):
        self._handle = handle
        self.create_calls = 0

    async def discover(self, hushh_id):
        return self._handle


def _handle(hushh_id="ha1_abc", *, liveness_mode="economy"):
    return BackendHandle(
        external_agent_id=f"one-pod-{hushh_id}",
        a2a_route=f"a2a://{hushh_id}",
        status="live",
        backend="user_gcp",
        # `discover` reads the LIVE service and computes the mode from its rendered
        # minScale, so a discovered handle carries it exactly as a created one does.
        backend_metadata={
            "url": "https://one-pod.run.app",
            "tenancy": "user-owned",
            "livenessMode": liveness_mode,
        },
    )


def _cloud():
    """Mirrors the real `UserCloud` fields adopt_orphan reads.

    `model_credential_mode` is part of that dataclass and was missing here, so the
    fake was quietly narrower than the thing it stood in for -- which is how a fake
    stops testing the code and starts testing itself.
    """
    return SimpleNamespace(
        deployment_target="user_gcp",
        model_credential_mode="user_adc",
        is_user_owned=True,
        project="acme-user-proj",
        region="us-central1",
        bootstrap_sa="one-bootstrap@acme-user-proj.iam.gserviceaccount.com",
    )


@pytest.fixture(autouse=True)
def _enabled(monkeypatch):
    monkeypatch.setattr(pa_svc, "personal_agent_enabled", lambda: True)


def _service(monkeypatch, *, row, handle, cloud=None):
    registry = _FakeRegistry(row)
    backend = _DiscoverBackend(handle)
    svc = PersonalAgentProvisioningService(registry=registry, backend=backend)
    monkeypatch.setattr(
        pa_svc, "resolve_user_cloud", _AsyncReturn(cloud if cloud is not None else _cloud())
    )
    monkeypatch.setattr(svc, "_backend_for", lambda _spec: backend)
    # The key pull + grant mint are covered in test_pod_key_custody.py; fake the collector
    # to a terminal here -- but RECORD the row handed to it, because passing the freshly
    # reconstructed `connecting` row (not the stale needs_reinit row) is the one step
    # adopt_orphan itself owns.
    refresh = _RecordingRefresh("provisioned")
    monkeypatch.setattr("hushh_mcp.services.pod_key_collector.refresh_pod_key", refresh)
    return svc, registry, backend, refresh


class _AsyncReturn:
    """A callable returning a fixed value from an awaited call (records nothing)."""

    def __init__(self, value):
        self._value = value

    async def __call__(self, *args, **kwargs):
        return self._value


class _RecordingRefresh:
    """A refresh_pod_key stand-in that records the row it was handed."""

    def __init__(self, value):
        self._value = value
        self.rows: list = []

    async def __call__(self, row, **kwargs):
        self.rows.append(row)
        return self._value


@pytest.mark.asyncio
async def test_adopt_reconstructs_a_connecting_row_and_reaches_provisioned(monkeypatch):
    row = {"status": "needs_reinit", "hushh_id": "ha1_abc", "phone_e164_hash": "deadbeef"}
    svc, registry, backend, refresh = _service(monkeypatch, row=row, handle=_handle())

    out = await svc.adopt_orphan(user_id="uid-1")

    assert out == {"hushhId": "ha1_abc", "status": "provisioned", "adopted": True}
    # A connecting row was reconstructed from the DISCOVERED handle -- identity preserved.
    assert len(registry.upserts) == 1
    up = registry.upserts[0]
    assert up["status"] == "connecting"
    assert up["hushh_id"] == "ha1_abc"  # SAME identity, never re-minted
    assert up["external_agent_id"] == "one-pod-ha1_abc"
    assert up["backend_metadata"]["url"] == "https://one-pod.run.app"
    # Adoption NEVER creates compute.
    assert backend.create_calls == 0
    # The collector was handed the RECONSTRUCTED connecting row (row2), never None or the
    # stale needs_reinit row -- attach_pod_public_key raises without an existing row.
    assert len(refresh.rows) == 1
    handed = refresh.rows[0]
    assert handed is not None
    assert handed["status"] == "connecting"
    assert handed["backend_metadata"]["url"] == "https://one-pod.run.app"


@pytest.mark.asyncio
async def test_adopt_returns_none_when_no_row(monkeypatch):
    svc, _r, _b, _f = _service(monkeypatch, row=None, handle=_handle())
    assert await svc.adopt_orphan(user_id="uid-1") is None


@pytest.mark.asyncio
async def test_adopt_returns_none_when_already_provisioned(monkeypatch):
    row = {"status": "provisioned", "hushh_id": "ha1_abc", "phone_e164_hash": "x"}
    svc, registry, _b, _f = _service(monkeypatch, row=row, handle=_handle())
    assert await svc.adopt_orphan(user_id="uid-1") is None
    assert registry.upserts == []  # a whole agent is left untouched


@pytest.mark.asyncio
async def test_adopt_returns_none_when_no_live_pod_to_adopt(monkeypatch):
    # discover() finds nothing -> caller falls through to reinit/rebuild, no row written.
    row = {"status": "needs_reinit", "hushh_id": "ha1_abc", "phone_e164_hash": "x"}
    svc, registry, _b, _f = _service(monkeypatch, row=row, handle=None)
    assert await svc.adopt_orphan(user_id="uid-1") is None
    assert registry.upserts == []


@pytest.mark.asyncio
async def test_adopt_returns_none_for_a_non_byoc_cloud(monkeypatch):
    # Adoption is a BYOC affordance: the deterministic pod is in the user's OWN project.
    managed = SimpleNamespace(
        deployment_target="gcp",
        is_user_owned=False,
        project=None,
        region=None,
        bootstrap_sa=None,
    )
    row = {"status": "needs_reinit", "hushh_id": "ha1_abc", "phone_e164_hash": "x"}
    svc, registry, _b, _f = _service(monkeypatch, row=row, handle=_handle(), cloud=managed)
    assert await svc.adopt_orphan(user_id="uid-1") is None
    assert registry.upserts == []


@pytest.mark.asyncio
async def test_adopt_carries_the_liveness_mode_it_discovered(monkeypatch):
    """An adopted pod's silence must be read by the rule the pod actually runs under.

    `discover` computes the mode from the live service, and until now adopt_orphan
    threw that answer away: the reconstructed row kept the column default of
    `warm`, so the liveness sweep read a healthy scaled-to-zero pod's silence as a
    fault and probed it awake -- billing a cold start on every pass, forever, for a
    pod that was working the whole time. The bill is the symptom; the row lying
    about what was bought is the defect.
    """
    row = {"status": "needs_reinit", "hushh_id": "ha1_abc", "phone_e164_hash": "x"}
    svc, registry, _b, _f = _service(monkeypatch, row=row, handle=_handle(liveness_mode="economy"))

    await svc.adopt_orphan(user_id="uid-1")

    assert registry.upserts, "adoption wrote no row"
    assert registry.upserts[0]["liveness_mode"] == "economy"


@pytest.mark.asyncio
async def test_adopt_records_where_the_pod_it_found_actually_lives(monkeypatch):
    """The deployment axes travel with the reconstructed row too.

    A row rebuilt without them reads as "the deployment default", which for a pod
    discovered in the person's OWN project is exactly the wrong answer -- and it is
    the answer the next provision, wake or migration would act on.
    """
    row = {"status": "needs_reinit", "hushh_id": "ha1_abc", "phone_e164_hash": "x"}
    svc, registry, _b, _f = _service(monkeypatch, row=row, handle=_handle())

    await svc.adopt_orphan(user_id="uid-1")

    written = registry.upserts[0]
    assert written["deployment_target"] == "user_gcp"
    assert written["model_credential_mode"] == "user_adc"
