"""A freshly built pod is bound and keyed the moment it is Ready, not a heartbeat later.

Measured on the founder's user-owned pod, 2026-09-02: host Ready 18:57:00Z, the
pod's FIRST heartbeat refused 18:57:38Z (``email_not_bound``: the row did not yet
carry the identity the pod presents, because that was written only after
``provision`` returned), key attached 18:59:32Z on the next accepted beat. Two and
a half minutes of "connecting" for a pod that was already answering.

Two changes, both in the provisioning service and both provider-neutral:

* the backend is asked for the identity the pod WILL present (``runtime_identity_for``,
  optional) and it is written to the row BEFORE the host is created, so the first
  beat binds;
* once the row reaches ``connecting`` the key is pulled immediately through the
  same collector adoption uses, best-effort, so a person sees ``provisioned`` in
  seconds rather than on the next heartbeat.

Hermetic: no cloud, no database. The backend and the collector are doubles that
record ORDER, which is the whole point.
"""

from __future__ import annotations

import pytest

from hushh_mcp.runtime_settings import get_core_security_settings
from hushh_mcp.services import personal_agent_provisioning_service as pas
from hushh_mcp.services.compute_backend import BackendHandle, PodSpec

_UID = "firebase_uid_test_handshake"
_PHONE = "+15550100777"
IDENTITY = "one-pod-ha1-abc-def@acme-user-proj.iam.gserviceaccount.com"


class FakeRegistry:
    def __init__(self) -> None:
        self.upserts: list[dict] = []
        self.rows: dict[str, dict] = {}

    async def upsert(self, **kw) -> None:
        self.upserts.append(dict(kw))
        row = self.rows.setdefault(kw["user_id"], {})
        row.update({k: v for k, v in kw.items() if v is not None})

    async def get(self, user_id: str):
        return dict(self.rows[user_id]) if user_id in self.rows else None

    async def tombstone_exists(self, hushh_id: str) -> bool:
        return False


class FakeGrant:
    async def issue_standing_pkm_read(self, user_id, *, ledger=None):  # pragma: no cover
        raise AssertionError("a deferred-key provision must not mint")

    async def revoke_standing_pkm_read(self, user_id, *, ledger=None):  # pragma: no cover
        raise AssertionError


class IdentityAwareBackend:
    """Knows the pod's identity from the spec alone, like the user-owned backend."""

    backend_id = "fake-owned"

    def __init__(self, registry: FakeRegistry) -> None:
        self._registry = registry
        self.identity_seen_by_pod_at_boot: str | None = None
        self.provision_calls = 0

    def runtime_identity_for(self, spec: PodSpec) -> str:
        return IDENTITY

    async def provision(self, spec: PodSpec) -> BackendHandle:
        self.provision_calls += 1
        # What the pod's FIRST heartbeat would find on the row while the backend is
        # still inside provision (waiting for Ready): the identity must already be
        # there, or the beat is refused.
        row = self._registry.rows.get(_UID) or {}
        self.identity_seen_by_pod_at_boot = (row.get("backend_metadata") or {}).get(
            "runtime_service_account"
        )
        return BackendHandle(
            external_agent_id="one-pod-ha1-abc",
            a2a_route=f"https://a2a.hushh.ai/u/{spec.hushh_id}",
            status="live",
            backend=self.backend_id,
            backend_metadata={
                "url": "https://one-pod-ha1-abc.a.run.app",
                "runtime_service_account": IDENTITY,
                "livenessMode": "economy",
            },
        )

    async def deprovision(self, external_agent_id):  # pragma: no cover
        raise AssertionError

    async def get(self, external_agent_id):  # pragma: no cover
        raise AssertionError

    async def health(self):  # pragma: no cover
        return True


class PlainBackend(IdentityAwareBackend):
    """A backend WITHOUT the optional method: today's behaviour, byte for byte."""

    backend_id = "fake-plain"
    runtime_identity_for = None  # type: ignore[assignment]


@pytest.fixture(autouse=True)
def _env(monkeypatch):
    monkeypatch.setenv("APP_SIGNING_KEY", "test_secret_key_for_ci_only_32chars_min")
    monkeypatch.setenv("VAULT_DATA_KEY", "0" * 64)
    monkeypatch.setenv("PERSONAL_AGENT_ENABLED", "1")
    get_core_security_settings.cache_clear()

    async def _no_cloud(user_id, *, repo=None):
        return None

    monkeypatch.setattr(pas, "resolve_user_cloud", _no_cloud)
    yield
    get_core_security_settings.cache_clear()


@pytest.fixture
def collector(monkeypatch):
    """The key collector as a recorder. ``outcome`` is what it returns; an
    Exception instance is raised instead."""
    state: dict = {"calls": [], "outcome": "provisioned"}

    async def _refresh(row, *, service=None, session=None):
        state["calls"].append({"row": dict(row or {}), "service": service})
        if isinstance(state["outcome"], Exception):
            raise state["outcome"]
        return state["outcome"]

    monkeypatch.setattr("hushh_mcp.services.pod_key_collector.refresh_pod_key", _refresh)
    return state


def _statuses(registry: FakeRegistry) -> list[str]:
    return [u["status"] for u in registry.upserts]


@pytest.mark.asyncio
async def test_the_identity_is_on_the_row_before_the_host_is_created(collector):
    registry = FakeRegistry()
    backend = IdentityAwareBackend(registry)
    svc = pas.PersonalAgentProvisioningService(
        registry=registry, grant=FakeGrant(), backend=backend
    )

    result = await svc.provision(user_id=_UID, phone_e164=_PHONE)

    assert backend.provision_calls == 1
    assert backend.identity_seen_by_pod_at_boot == IDENTITY, (
        "the first heartbeat must find the identity already bound"
    )
    # row -> identity pre-bind -> host handle -> connecting; then the immediate pull.
    assert _statuses(registry) == ["provisioning", "provisioning", "provisioning", "connecting"]
    pre_bind = registry.upserts[1]
    assert pre_bind["backend_metadata"] == {"runtime_service_account": IDENTITY}
    assert pre_bind.get("external_agent_id") is None, "no host yet, nothing invented"
    assert result["status"] == "provisioned", "the collector's answer is the person's answer"


@pytest.mark.asyncio
async def test_the_key_is_pulled_from_the_connecting_row_immediately(collector):
    registry = FakeRegistry()
    svc = pas.PersonalAgentProvisioningService(
        registry=registry, grant=FakeGrant(), backend=IdentityAwareBackend(registry)
    )

    await svc.provision(user_id=_UID, phone_e164=_PHONE)

    assert len(collector["calls"]) == 1
    call = collector["calls"][0]
    assert call["service"] is svc, "the collector attaches through THIS service"
    assert call["row"]["status"] == "connecting"
    assert call["row"]["external_agent_id"] == "one-pod-ha1-abc"
    assert call["row"]["backend_metadata"]["url"].startswith("https://one-pod-ha1-abc")


@pytest.mark.asyncio
async def test_a_missed_pull_leaves_connecting_for_the_heartbeat_path(collector):
    collector["outcome"] = RuntimeError("pod not answering yet: url=https://secret")
    registry = FakeRegistry()
    svc = pas.PersonalAgentProvisioningService(
        registry=registry, grant=FakeGrant(), backend=IdentityAwareBackend(registry)
    )

    result = await svc.provision(user_id=_UID, phone_e164=_PHONE)

    assert result["status"] == "connecting"
    assert _statuses(registry)[-1] == "connecting"


@pytest.mark.asyncio
async def test_a_pull_that_finds_nothing_yet_reports_connecting(collector):
    collector["outcome"] = None
    registry = FakeRegistry()
    svc = pas.PersonalAgentProvisioningService(
        registry=registry, grant=FakeGrant(), backend=IdentityAwareBackend(registry)
    )
    result = await svc.provision(user_id=_UID, phone_e164=_PHONE)
    assert result["status"] == "connecting"


@pytest.mark.asyncio
async def test_a_backend_without_the_method_behaves_exactly_as_before(collector):
    registry = FakeRegistry()
    backend = PlainBackend(registry)
    svc = pas.PersonalAgentProvisioningService(
        registry=registry, grant=FakeGrant(), backend=backend
    )

    await svc.provision(user_id=_UID, phone_e164=_PHONE)

    assert backend.identity_seen_by_pod_at_boot is None
    assert _statuses(registry) == ["provisioning", "provisioning", "connecting"]
    assert len(collector["calls"]) == 1, "the immediate pull does not depend on pre-binding"


def test_the_user_owned_backend_names_the_identity_it_will_bind():
    from hushh_mcp.services.user_gcp_backend import UserGcpBackend, pod_service_account_id

    backend = UserGcpBackend(user_project="acme-user-proj", image="gcr.io/x/pod:t", live=False)
    spec = PodSpec(
        hushh_id="ha1_27mqrdirlc56t4p2inqkthnwfrohj62o", phone_e164_hash="h", pod_pubkey=""
    )
    identity = backend.runtime_identity_for(spec)
    assert (
        identity
        == f"{pod_service_account_id(spec.hushh_id)}@acme-user-proj.iam.gserviceaccount.com"
    )
    # The same string the bootstrap plan creates and the live handle records.
    plan = backend.render_bootstrap_plan(spec)
    assert identity in repr(plan)
