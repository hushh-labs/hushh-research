"""How warm a pod is kept must be a fact about ONE person, not about the process.

`HUSSH_POD_MIN_INSTANCES` is read once when the backend is constructed, so before
this every pod a deployment provisioned got the same `minScale`. "Economy by
default, warm for whoever needs it" was not expressible for a person -- only for a
whole fleet.

It is not a cost knob. `pod_liveness_service` reads a WARM pod's silence as a FAULT
and an ECONOMY pod's silence as its healthy steady state. So the tier decides
whether auto-heal restarts a pod that is working perfectly, and a row that records
the wrong tier is a restart loop for exactly one person -- which is the hardest kind
of fault to see, because the fleet looks fine.

That is why the assertions below are as much about the RECORDED tier as the rendered
one: an artifact that holds a paid instance while the registry row says `economy` is
worse than either mistake alone.
"""

from __future__ import annotations

import pytest

from hushh_mcp.services.compute_backend import (
    RESOURCE_TIER_ECONOMY,
    RESOURCE_TIER_WARM,
    PodSpec,
)
from hushh_mcp.services.gcp_backend import GcpBackend
from hushh_mcp.services.user_gcp_backend import UserGcpBackend

MIN_SCALE = "autoscaling.knative.dev/minScale"


def _spec(**kw) -> PodSpec:
    return PodSpec(hushh_id="HA1ABC", phone_e164_hash="h", pod_pubkey="pub", **kw)


def _min_scale(config: dict) -> int:
    return int(config["spec"]["template"]["metadata"]["annotations"][MIN_SCALE])


def _backend(default_min: int = 0) -> GcpBackend:
    return GcpBackend(project="p", image="i", live=False, min_instances=default_min)


def _byoc_backend(default_min: int = 0) -> UserGcpBackend:
    return UserGcpBackend(
        user_project="acme-user-proj", image="i", live=False, min_instances=default_min
    )


def test_two_people_on_one_deployment_get_different_warm_floors():
    """THE assertion. One process, one backend object, two different answers."""
    backend = _backend(default_min=0)
    economy = backend.render_deploy_config(_spec(resource_tier=RESOURCE_TIER_ECONOMY))
    warm = backend.render_deploy_config(_spec(resource_tier=RESOURCE_TIER_WARM))

    assert _min_scale(economy) == 0
    assert _min_scale(warm) >= 1, (
        "both people got the deployment's floor. The tier is still process-wide, so "
        "nobody can be warmed without warming everybody."
    )


def test_no_tier_means_the_deployment_default():
    """Additive: every existing caller passes no tier and must be unaffected."""
    assert _min_scale(_backend(default_min=0).render_deploy_config(_spec())) == 0
    assert _min_scale(_backend(default_min=1).render_deploy_config(_spec())) == 1


def test_an_unknown_tier_defers_instead_of_guessing():
    """Neither guess is safe, so it takes neither.

    Guessing `warm` holds a paid instance nobody asked for. Guessing `economy` makes
    the liveness evaluator read a warm-intended pod's silence as healthy, so a broken
    pod is never restarted. Falling back to the deployment default is the only answer
    that is wrong in a way an operator already understands.
    """
    for default in (0, 1):
        config = _backend(default_min=default).render_deploy_config(_spec(resource_tier="platinum"))
        assert _min_scale(config) == default


@pytest.mark.parametrize("make_backend", [_backend, _byoc_backend], ids=["managed", "byoc"])
@pytest.mark.parametrize(
    "tier,expected",
    [(None, "economy"), (RESOURCE_TIER_WARM, "warm"), (RESOURCE_TIER_ECONOMY, "economy")],
    ids=["default-spec", "warm", "economy"],
)
@pytest.mark.asyncio
async def test_the_row_records_the_tier_the_pod_actually_got(make_backend, tier, expected):
    """A row that disagrees with the artifact is worse than either being wrong.

    `livenessMode` is what `pod_liveness_service` judges the pod by. If the artifact
    holds a warm instance while the row says `economy`, that pod's silence reads as
    healthy forever and auto-heal never looks at it again.

    BOTH tiers, because the BYOC handle simply omitted the field: the registry
    column's `warm` default then stuck to every user-owned row, and the liveness
    sweep probed -- woke, billed -- healthy sleeping economy pods. `None` is the
    default spec every production caller passes, so it is the case that was wrong.
    """
    handle = await make_backend(default_min=0).provision(_spec(resource_tier=tier))
    assert (handle.backend_metadata or {}).get("livenessMode") == expected


@pytest.mark.asyncio
async def test_warm_gets_cpu_between_requests_and_economy_does_not():
    """The two halves of the tier must move together.

    Cloud Run throttles CPU to near zero between requests. A warm pod's heartbeat is a
    background loop, so without always-allocated CPU it stalls between beats and the
    hub reads a healthy pod as faulted -- paying for a warm instance and then breaking
    it. Splitting these two settings would produce exactly that pod.
    """
    backend = _backend(default_min=0)
    warm = backend.render_deploy_config(_spec(resource_tier=RESOURCE_TIER_WARM))
    economy = backend.render_deploy_config(_spec(resource_tier=RESOURCE_TIER_ECONOMY))

    warm_annotations = warm["spec"]["template"]["metadata"]["annotations"]
    economy_annotations = economy["spec"]["template"]["metadata"]["annotations"]
    cpu_throttling = "run.googleapis.com/cpu-throttling"

    assert warm_annotations.get(cpu_throttling) == "false", (
        "a warm pod is paying for an instance whose CPU is throttled between requests, "
        "so its heartbeat stalls and the hub will read it as faulted"
    )
    assert economy_annotations.get(cpu_throttling) != "false"
