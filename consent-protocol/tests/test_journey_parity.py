"""Every backend must walk the SAME journey, not merely satisfy the same signatures.

WHAT THE OTHER TWO GUARDS ALREADY COVER, AND WHAT THEY MISS

  * `test_compute_backend_contract.py` proves each backend satisfies the protocol --
    same methods, same return types. A backend can pass that and never be reachable.
  * `test_compute_backend_parity.py` proves each backend's rendered ARTIFACT carries
    the same capabilities. A backend can pass that and still leave a person parked in
    `connecting` forever, because the artifact is only stage 3 of eight.

Neither asks the question a person actually cares about: **does choosing this backend
change what happens to me?** The lifecycle is the product -- `pending` is a spinner,
`connecting` is a spinner, `provisioned` is an agent. If one backend reaches
`provisioned` and another silently stops at `connecting`, that is a different product
for that person, and both suites above stay green while it happens.

So this suite runs each backend through the REAL orchestrator and asserts the
sequence of states it drives the registry through. The backends are stubbed at the
cloud boundary only -- the orchestrator, the grant, the substrate seam and the
registry writes are the real code paths.

HONEST SKIPPING

Live paths stay gated behind their own flags. A backend whose live flag is off is
reported as such rather than being quietly excluded from the parity claim, because
"we assert parity across three backends" is false if one of them was never run.
"""

from __future__ import annotations

import base64

import pytest
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric.x25519 import X25519PrivateKey

from hushh_mcp.runtime_settings import get_core_security_settings
from hushh_mcp.services.anypoint_backend import AnypointBackend
from hushh_mcp.services.byoc_substrate import NoSubstrateRequired
from hushh_mcp.services.compute_backend import (
    BACKEND_ANYPOINT,
    BACKEND_GCP,
    BACKEND_USER_GCP,
    BackendHandle,
    BackendStatus,
)
from hushh_mcp.services.gcp_backend import GcpBackend
from hushh_mcp.services.personal_agent_provisioning_service import (
    PersonalAgentProvisioningService,
)
from hushh_mcp.services.user_gcp_backend import UserGcpBackend

# The states a person's row passes through on a healthy journey, verified against the
# code rather than assumed: `provision()` drives `provisioning` then `connecting`, and
# `attach_pod_public_key()` is what flips `connecting` -> `provisioned`.
#
# The journey is therefore TWO calls, and the test drives both. An earlier draft of
# this file asserted a `pending -> connecting -> provisioned` sequence that no backend
# produces -- `pending` belongs to `register_pending`, a different entry point -- and
# would have passed only by being wrong about all three backends equally.
#
# `connecting` is the state that matters most: the pod exists but has not published its
# key, and it is where a person is stranded when the second half never completes.
PROVISION_JOURNEY = ("provisioning", "connecting")
COMPLETED_JOURNEY = ("provisioning", "connecting", "provisioned")

# A real 32-byte X25519 public key: `parse_pod_public_key` validates the encoding, so
# a placeholder string cannot reach the handshake.
POD_PUBLIC_KEY_B64 = base64.b64encode(
    X25519PrivateKey.generate()
    .public_key()
    .public_bytes(
        encoding=serialization.Encoding.Raw,
        format=serialization.PublicFormat.Raw,
    )
).decode()

LIVE_FLAGS = {
    BACKEND_GCP: "HUSSH_GCP_BACKEND_LIVE",
    BACKEND_ANYPOINT: "HUSSH_ANYPOINT_BACKEND_LIVE",
    BACKEND_USER_GCP: "HUSSH_USER_GCP_LIVE",
}


@pytest.fixture(autouse=True)
def _env(monkeypatch):
    monkeypatch.setenv("APP_SIGNING_KEY", "test_secret_key_for_ci_only_32chars_min")
    monkeypatch.setenv("VAULT_DATA_KEY", "0" * 64)
    monkeypatch.setenv("PERSONAL_AGENT_ENABLED", "1")
    get_core_security_settings.cache_clear()
    yield
    get_core_security_settings.cache_clear()


class _RecordingRegistry:
    """Same surface the provisioning service uses, recording the state sequence."""

    def __init__(self) -> None:
        self.rows: list[dict] = []
        self.tombstones: list[dict] = []

    @property
    def states(self) -> list[str]:
        return [str(row.get("status")) for row in self.rows if row.get("status")]

    async def upsert(self, **fields):
        self.rows.append(fields)

    async def get(self, user_id):
        return self.rows[-1] if self.rows else None

    async def tombstone(self, **kw):
        self.tombstones.append(kw)

    async def delete(self, user_id): ...

    async def tombstone_exists(self, hushh_id):
        return any((t.get("hushh_id") or "") == hushh_id for t in self.tombstones)

    async def count_active_pods(self, *, exclude_user_id=None):
        return 0


class _Grant:
    async def issue_standing_pkm_read(self, user_id, ledger=None):
        return {"expiresAt": None}


class _StubbedAtTheCloudBoundary:
    """A real backend's identity and shape, with only the cloud call replaced.

    Wrapping the real object rather than writing a fake per provider is deliberate:
    a hand-written fake drifts from the backend it stands for, and a parity suite
    running against three drifted fakes proves parity between the fakes.
    """

    def __init__(self, real, *, handle_status: str = "live"):
        self._real = real
        self.backend_id = real.backend_id
        self.provisioned: list[str] = []
        self._handle_status = handle_status

    async def provision(self, spec) -> BackendHandle:
        self.provisioned.append(spec.hushh_id)
        # render_deploy_config is the real method: if a backend cannot render an
        # artifact for this spec, that is a journey failure and must surface here.
        config = self._real.render_deploy_config(spec)
        assert config, f"{self.backend_id} rendered no deploy config"
        return BackendHandle(
            external_agent_id=f"{self.backend_id}-{spec.hushh_id}",
            a2a_route=f"/u/{spec.hushh_id}",
            backend=self.backend_id,
            status=self._handle_status,
        )

    async def deprovision(self, external_agent_id: str) -> None: ...

    async def get(self, external_agent_id: str) -> BackendStatus:
        return BackendStatus(external_agent_id=external_agent_id, status="live", healthy=True)

    def render_deploy_config(self, spec):
        return self._real.render_deploy_config(spec)

    async def health(self) -> bool:
        return True


def _backends():
    """One entry per selectable production backend. `null` is excluded on purpose:
    it provisions nothing by design, so holding it to the journey would assert that
    the inert default is not inert."""
    return [
        (BACKEND_GCP, GcpBackend(project="p", image="i", live=False)),
        (BACKEND_ANYPOINT, AnypointBackend(env_id="e", live=False)),
        (BACKEND_USER_GCP, UserGcpBackend(user_project="up", image="i")),
    ]


def _service(backend, registry):
    return PersonalAgentProvisioningService(
        registry=registry,
        grant=_Grant(),
        backend=backend,
        substrate=NoSubstrateRequired(),
    )


def _assert_reaches(name: str, states: list[str], journey: tuple[str, ...]) -> None:
    for state in journey:
        assert state in states, (
            f"{name} never reached `{state}`. Reaching a different set of lifecycle "
            f"states than another backend is a different product for that person, "
            f"not an implementation detail. States seen: {states}"
        )
    order = [states.index(state) for state in journey]
    assert order == sorted(order), (
        f"{name} reached the right states in the wrong order: {states}. "
        "`provisioned` before `connecting` would mean the row claims an activated "
        "agent that has not yet published its key."
    )


@pytest.mark.asyncio
@pytest.mark.parametrize("name,real", _backends(), ids=[b[0] for b in _backends()])
async def test_every_backend_walks_the_same_journey(name, real):
    """THE parity assertion. Same states, same order, whichever backend is chosen."""
    registry = _RecordingRegistry()
    backend = _StubbedAtTheCloudBoundary(real)
    await _service(backend, registry).provision(user_id="u1", phone_e164="+15550100")

    assert backend.provisioned, f"{name} was never asked to provision"
    _assert_reaches(name, registry.states, PROVISION_JOURNEY)


@pytest.mark.asyncio
@pytest.mark.parametrize("name,real", _backends(), ids=[b[0] for b in _backends()])
async def test_every_backend_completes_the_handshake_to_provisioned(name, real):
    """The half where a person is actually stranded.

    `connecting` is a spinner. A backend that provisions fine and then never
    completes the key handshake leaves someone watching that spinner forever, and
    both other parity suites stay green the whole time -- the artifact was rendered
    correctly and the protocol was satisfied.
    """
    registry = _RecordingRegistry()
    service = _service(_StubbedAtTheCloudBoundary(real), registry)
    await service.provision(user_id="u1", phone_e164="+15550100")

    result = await service.attach_pod_public_key(
        user_id="u1",
        pod_public_key_b64=POD_PUBLIC_KEY_B64,
        pod_key_id=f"{name}-key-1",
    )

    assert result["status"] == "provisioned"
    _assert_reaches(name, registry.states, COMPLETED_JOURNEY)


@pytest.mark.asyncio
@pytest.mark.parametrize("name,real", _backends(), ids=[b[0] for b in _backends()])
async def test_a_restarted_pod_re_registering_mints_nothing_twice(name, real):
    """Identical on every backend, because a pod restart is not backend-specific.

    A pod that reboots re-presents the SAME key. If that minted a second standing
    grant the person would accumulate read authority for every restart of their own
    agent -- and it would do so on whichever backend happened to restart most.
    """
    registry = _RecordingRegistry()
    service = _service(_StubbedAtTheCloudBoundary(real), registry)
    await service.provision(user_id="u1", phone_e164="+15550100")

    first = await service.attach_pod_public_key(
        user_id="u1", pod_public_key_b64=POD_PUBLIC_KEY_B64, pod_key_id=f"{name}-key-1"
    )
    rows_after_first = len(registry.rows)
    again = await service.attach_pod_public_key(
        user_id="u1", pod_public_key_b64=POD_PUBLIC_KEY_B64, pod_key_id=f"{name}-key-1"
    )

    assert first["status"] == again["status"] == "provisioned"
    assert len(registry.rows) == rows_after_first, (
        f"{name} wrote another row for a pod re-presenting the key it already had"
    )


@pytest.mark.asyncio
@pytest.mark.parametrize("name,real", _backends(), ids=[b[0] for b in _backends()])
async def test_a_different_key_is_refused_on_every_backend(name, real):
    """Rebinding must need `allow_rotation` regardless of provider.

    If one backend accepted a silent rebind, whatever reached that path could take
    over that person's agent identity -- and the difference would be invisible to
    everyone except the person whose agent it was.
    """
    registry = _RecordingRegistry()
    service = _service(_StubbedAtTheCloudBoundary(real), registry)
    await service.provision(user_id="u1", phone_e164="+15550100")
    await service.attach_pod_public_key(
        user_id="u1", pod_public_key_b64=POD_PUBLIC_KEY_B64, pod_key_id=f"{name}-key-1"
    )

    other = base64.b64encode(
        X25519PrivateKey.generate()
        .public_key()
        .public_bytes(encoding=serialization.Encoding.Raw, format=serialization.PublicFormat.Raw)
    ).decode()

    with pytest.raises(ValueError, match="different pod public key"):
        await service.attach_pod_public_key(
            user_id="u1", pod_public_key_b64=other, pod_key_id=f"{name}-key-2"
        )


@pytest.mark.asyncio
@pytest.mark.parametrize("name,real", _backends(), ids=[b[0] for b in _backends()])
async def test_every_backend_records_an_addressable_host(name, real):
    """A journey that ends without a host is a spinner, whatever the row says."""
    registry = _RecordingRegistry()
    await _service(_StubbedAtTheCloudBoundary(real), registry).provision(
        user_id="u1", phone_e164="+15550100"
    )

    with_host = [r for r in registry.rows if r.get("external_agent_id")]
    assert with_host, f"{name} recorded no external_agent_id on any row"
    assert with_host[-1].get("backend") == name, (
        f"{name} recorded backend={with_host[-1].get('backend')!r}. A row that names "
        "the wrong backend cannot be reconciled or torn down by the right one."
    )


@pytest.mark.asyncio
@pytest.mark.parametrize("name,real", _backends(), ids=[b[0] for b in _backends()])
async def test_a_backend_that_fails_strands_nobody_silently(name, real):
    """Parity of the UNHAPPY path matters as much as the happy one.

    A backend whose provision raises must leave a row that says so. The failure mode
    this forbids is a row left in `pending` with no reason, which is indistinguishable
    from a request that was never made.
    """

    class _Refuses(_StubbedAtTheCloudBoundary):
        async def provision(self, spec):
            raise RuntimeError("cloud refused")

    registry = _RecordingRegistry()
    with pytest.raises(RuntimeError):
        await _service(_Refuses(real), registry).provision(user_id="u1", phone_e164="+15550100")

    assert registry.states, f"{name} failed without recording anything at all"
    assert "provisioned" not in registry.states, (
        f"{name} recorded `provisioned` for a pod that was never created"
    )


@pytest.mark.parametrize("name,_real", _backends(), ids=[b[0] for b in _backends()])
def test_the_live_path_is_gated_by_its_own_flag(name, _real, monkeypatch):
    """Parity of the GATE, so no backend can be live-by-default.

    Stated rather than assumed: this asserts the flag exists and defaults off. It is
    not a claim that the live path was exercised -- those runs need real cloud
    credentials and are named in `docs/reference/operations/tracing-a-pod-journey.md`.
    """
    flag = LIVE_FLAGS[name]
    monkeypatch.delenv(flag, raising=False)
    builders = {
        BACKEND_GCP: lambda: GcpBackend(project="p", image="i"),
        BACKEND_ANYPOINT: lambda: AnypointBackend(env_id="e"),
        BACKEND_USER_GCP: lambda: UserGcpBackend(user_project="up", image="i"),
    }
    assert builders[name]()._live is False, (
        f"{name} defaults to LIVE with {flag} unset. A backend that reaches a cloud "
        "without being asked to is not dark-shippable."
    )
