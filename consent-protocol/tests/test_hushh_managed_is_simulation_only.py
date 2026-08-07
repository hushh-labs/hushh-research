"""The hussh-managed backend is the simulation tier, and refuses to be anything else.

Per `docs/reference/architecture/private-agent-north-star.md`, a pod that hussh
operates on hussh's infrastructure exists to prove the machinery — lifecycle,
harness execution, grounding, intelligence chaining, front-end connectivity. It is
deliberately NOT a production deployment path, because Zero Knowledge cannot be
held by a pod its operator can read. Production is user-owned only.

Before this, the only thing keeping `GcpBackend` out of production was an accident:
`personal_agent_registry` lives in the parked migration lane, so UAT and production
have no such table. A schema side-effect is not a control — it would have evaporated
the moment someone renumbered 900 into `migrations/`.

`dev_simulation_guard` already existed for exactly this shape, fail-closed and with
twelve tests, and had ZERO production callers. These assert it is now wired, and that
it denies by default rather than permitting when unconfigured.
"""

from __future__ import annotations

import pytest

from hushh_mcp.services.compute_backend import PodSpec
from hushh_mcp.services.dev_simulation_guard import SimulationNotPermittedError
from hushh_mcp.services.gcp_backend import GcpBackend

_SPEC = PodSpec(hushh_id="ha1x", phone_e164_hash="h" * 64, pod_pubkey="p" * 43)


def _clear_lane(monkeypatch) -> None:
    for name in ("HUSHH_DEV_SIMULATION_ENABLED", "HUSHH_DEPLOY_ENV", "DEPLOY_ENV", "_DEPLOY_ENV"):
        monkeypatch.delenv(name, raising=False)


@pytest.mark.asyncio
async def test_live_provisioning_refuses_when_no_lane_is_configured(monkeypatch):
    """Absence of configuration must DENY.

    The failure mode this guards is a container that lost its environment and is
    therefore treated as a development box. For an alias code that is a defensible
    trade; for "create billable per-person compute that hussh can read" it is not.
    """
    _clear_lane(monkeypatch)
    monkeypatch.setenv("ENVIRONMENT", "production")

    backend = GcpBackend(project="p", region="us-central1", live=True, client=object())

    with pytest.raises(SimulationNotPermittedError):
        await backend._execute(_SPEC, {"metadata": {"name": "one-pod-ha1x"}})


@pytest.mark.asyncio
async def test_live_provisioning_refuses_in_production_even_with_the_opt_in(monkeypatch):
    """The opt-in alone is not enough, and that is the point.

    A developer's laptop is a development environment. A production container with a
    stray flag is not, and the guard reads the deploy lane as authoritative rather
    than trusting the runtime environment name — which the dev hub deliberately
    skews to `uat` for behaviour parity.
    """
    _clear_lane(monkeypatch)
    monkeypatch.setenv("HUSHH_DEV_SIMULATION_ENABLED", "1")
    monkeypatch.setenv("HUSHH_DEPLOY_ENV", "production")

    backend = GcpBackend(project="p", region="us-central1", live=True, client=object())

    with pytest.raises(SimulationNotPermittedError):
        await backend._execute(_SPEC, {"metadata": {"name": "one-pod-ha1x"}})


@pytest.mark.asyncio
async def test_the_refusal_names_what_was_refused(monkeypatch):
    """A bypass that silently does nothing is indistinguishable from one that works.

    So the guard raises rather than returning falsy, and the message carries the
    observed lane and environment — the two things someone debugging a refused
    provision will actually want.
    """
    _clear_lane(monkeypatch)
    monkeypatch.setenv("HUSHH_DEPLOY_ENV", "uat")

    backend = GcpBackend(project="p", region="us-central1", live=True, client=object())

    with pytest.raises(SimulationNotPermittedError) as excinfo:
        await backend._execute(_SPEC, {"metadata": {"name": "one-pod-ha1x"}})

    message = str(excinfo.value)
    assert "hussh-managed pod provisioning" in message
    assert "uat" in message


def test_plan_mode_still_renders_everywhere(monkeypatch):
    """The refusal is at the live-execution boundary, never at render time.

    Rendering costs nothing and bills nothing, and being able to inspect the artifact
    a lane WOULD produce is how several defects in this workstream were found. Moving
    the guard to render time would have closed that off for no security gain.
    """
    _clear_lane(monkeypatch)
    monkeypatch.setenv("ENVIRONMENT", "production")

    config = GcpBackend(project="p", region="us-central1", live=False).render_deploy_config(_SPEC)

    assert config["metadata"]["name"] == "one-pod-ha1x"
