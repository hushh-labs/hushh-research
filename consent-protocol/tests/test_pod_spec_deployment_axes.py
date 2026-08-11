"""Where a person's pod runs must be a property of that person, not of the process.

BYOC is the production path and the hussh-managed tier is strictly simulation. That
makes "which target" a per-person production fact — and until `PodSpec` carried it,
both axes (deployment target, model credential mode) were process-wide environment
variables read by `resolve_compute_backend()` with no argument at all four production
call sites. A hub could therefore only ever build every pod the same way.

The north star names this as the first change, ahead of credentials and IAM: "putting
both axes on PodSpec and on a per-user column, after which the rest becomes possible."
It is also the deployment-agnostic test made concrete — moving a pod to someone else's
project has to be setting a value, not editing code.
"""

from __future__ import annotations

import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from hushh_mcp.services.compute_backend import (  # noqa: E402
    BACKEND_GCP,
    BACKEND_NULL,
    BACKEND_USER_GCP,
    NullBackend,
    PodSpec,
    resolve_compute_backend,
    resolve_compute_backend_for_spec,
)
from hushh_mcp.services.personal_agent_provisioning_service import (  # noqa: E402
    PersonalAgentProvisioningService,
)


def _spec(**kw) -> PodSpec:
    return PodSpec(hushh_id="HA1SPEC001", phone_e164_hash="h", pod_pubkey="", **kw)


def test_the_axes_default_to_the_deployment_default() -> None:
    """Additive by construction: absent axes mean exactly what happened before."""
    spec = _spec()
    assert spec.deployment_target is None
    assert spec.model_credential_mode is None


def test_a_persons_target_selects_their_backend_not_the_deployments(monkeypatch) -> None:
    """The whole point. The hub is configured for one target; the person has another.

    A BYOC user's pod must be built in their project by a hub running in hushh's.
    """
    monkeypatch.setenv("PERSONAL_AGENT_BACKEND", BACKEND_GCP)

    from hushh_mcp.services.user_gcp_backend import UserGcpBackend

    chosen = resolve_compute_backend_for_spec(_spec(deployment_target=BACKEND_USER_GCP))
    assert isinstance(chosen, UserGcpBackend), (
        "a person who connected their own cloud was routed to the deployment's "
        "backend instead of their own — this is the BYOC failure the axis exists to stop"
    )


def test_no_target_falls_back_to_the_deployment(monkeypatch) -> None:
    """A superset of the old behaviour, not a second competing resolver."""
    monkeypatch.setenv("PERSONAL_AGENT_BACKEND", BACKEND_NULL)
    assert isinstance(resolve_compute_backend_for_spec(_spec()), NullBackend)
    assert isinstance(resolve_compute_backend(), NullBackend)


def test_an_unrecognised_target_fails_loudly(monkeypatch) -> None:
    """The one failure mode worth being noisy about.

    Silently falling back would provision a BYOC user's holdings into hushh's project
    instead of their own — the exact property the architecture exists to preserve.
    """
    monkeypatch.setenv("PERSONAL_AGENT_BACKEND", BACKEND_GCP)
    with pytest.raises(NotImplementedError):
        resolve_compute_backend_for_spec(_spec(deployment_target="typo_cloud"))


# -- the service honours it -------------------------------------------------------


class _RecordingBackend:
    """Stands in for the deployment default, and records if it was used."""

    def __init__(self) -> None:
        self.provisioned: list[PodSpec] = []

    async def provision(self, spec):
        self.provisioned.append(spec)
        from hushh_mcp.services.compute_backend import BackendHandle

        return BackendHandle(status="planned", backend="recording")

    async def deprovision(self, external_agent_id):  # pragma: no cover - unused here
        return None

    async def get(self, external_agent_id):  # pragma: no cover - unused here
        return None

    def render_deploy_config(self, spec):  # pragma: no cover - unused here
        return {}


def test_the_injected_backend_still_wins_when_no_target_is_set() -> None:
    """Every existing caller, and every test passing a fake, must be unaffected.

    A fake backend IS the deployment default for that test, so injection has to keep
    winning in the absent-axis case or this change would rewrite behaviour it was
    only meant to make expressible.
    """
    injected = _RecordingBackend()
    svc = PersonalAgentProvisioningService(registry=object(), backend=injected)
    assert svc._backend_for(_spec()) is injected


def test_a_per_person_target_overrides_the_injected_backend(monkeypatch) -> None:
    """Injection answers "what does this deployment run". It is the wrong question
    for a person who owns their own compute."""
    monkeypatch.setenv("PERSONAL_AGENT_BACKEND", BACKEND_GCP)
    from hushh_mcp.services.user_gcp_backend import UserGcpBackend

    injected = _RecordingBackend()
    svc = PersonalAgentProvisioningService(registry=object(), backend=injected)
    chosen = svc._backend_for(_spec(deployment_target=BACKEND_USER_GCP))

    assert chosen is not injected
    assert isinstance(chosen, UserGcpBackend)


def test_the_credential_axis_travels_with_the_spec() -> None:
    """It selects no backend today, and it must still be carried.

    Target and credential are separate axes — the north star's correction records that
    conflating them is one axis off. Recording the credential mode on the spec is what
    lets a later read say what a pod was actually built as, rather than what the
    environment happens to say now.
    """
    spec = _spec(deployment_target=BACKEND_USER_GCP, model_credential_mode="byok")
    assert spec.model_credential_mode == "byok"
    assert spec.deployment_target == BACKEND_USER_GCP
