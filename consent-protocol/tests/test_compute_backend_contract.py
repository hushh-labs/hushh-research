"""Contract test: every ComputeBackend is interchangeable behind one interface.

Runs NullBackend, GcpBackend, and AnypointBackend through the identical contract,
so a change to one that breaks the shared shape fails here. This is the anti-drift
guard for "one logical architecture, N deployment backends" -- deploy to GCP or to
Anypoint through the same interchangeable interface.
"""

from __future__ import annotations

import pytest

from hushh_mcp.services.anypoint_backend import AnypointBackend
from hushh_mcp.services.compute_backend import (
    BackendHandle,
    BackendStatus,
    ComputeBackend,
    NullBackend,
    PodSpec,
)
from hushh_mcp.services.gcp_backend import A2A_ADDRESS_BASE, GcpBackend

_BACKENDS = [
    ("null", lambda: NullBackend()),
    ("gcp", lambda: GcpBackend(project="p", image="i", live=False)),
    ("anypoint", lambda: AnypointBackend(env_id="e", live=False)),
]
_IDS = [b[0] for b in _BACKENDS]


def _spec() -> PodSpec:
    return PodSpec(hushh_id="HA1ABC", phone_e164_hash="h", pod_pubkey="pub", space_id="sp1")


@pytest.mark.parametrize("name,make", _BACKENDS, ids=_IDS)
def test_backend_satisfies_protocol(name, make):
    b = make()
    assert isinstance(b, ComputeBackend)
    assert isinstance(b.backend_id, str) and b.backend_id


@pytest.mark.parametrize("name,make", _BACKENDS, ids=_IDS)
async def test_backend_contract_shapes(name, make):
    b = make()
    handle = await b.provision(_spec())
    assert isinstance(handle, BackendHandle)
    assert isinstance(b.render_deploy_config(_spec()), dict)
    assert await b.deprovision("x") is None
    assert isinstance(await b.get("x"), BackendStatus)
    assert isinstance(await b.health(), bool)


async def test_real_backends_are_interchangeable():
    """Same spec, different hosts -> identical backend-neutral A2A address + handle shape."""
    spec = _spec()
    gcp = await GcpBackend(project="p", image="i", live=False).provision(spec)
    anypoint = await AnypointBackend(env_id="e", live=False).provision(spec)
    # The user-facing address is identical regardless of host (Layer A indirection).
    expected_route = f"{A2A_ADDRESS_BASE}/{spec.hushh_id}"
    assert gcp.a2a_route == anypoint.a2a_route == expected_route
    # Each records its own host; both fill the same handle fields the brain reads.
    assert gcp.backend == "gcp" and anypoint.backend == "anypoint"
    assert gcp.external_agent_id and anypoint.external_agent_id
    assert gcp.status == anypoint.status == "planned"
    assert gcp.backend_metadata and anypoint.backend_metadata
