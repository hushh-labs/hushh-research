"""The rendered pod config must be one Cloud Run will actually accept.

On 2026-08-07 `GcpBackend.provision` was run against real Cloud Run for the first
time. It had never executed outside a fake. Cloud Run rejected it:

    HTTP 400 spec.template.spec.containers.resources.limits.cpu: Invalid value
    specified for cpu. Total cpu < 1 is not supported with cpu always allocated
    (unthrottled).

The warm tier (`min_instances >= 1`) sets `run.googleapis.com/cpu-throttling:
false`, because the pod heartbeat is a background asyncio loop that stalls between
beats when throttled — and the hub reads a healthy pod's silence as a fault. The
default CPU is `500m`, chosen for a network-bound workload. Each decision is sound
alone; the platform refuses the pair. So **every warm-tier provision failed with
400 before a container ever started**, which is why no hussh-managed pod has ever
existed.

Every existing test asserts on the rendered dict. None of them POSTs it, so the
config was being checked against our own expectations rather than against the
platform that has to accept it — the same shape as the commit-binding defect found
the same day. These tests encode the platform's constraint as a property of the
render, which is the closest a unit test can get to the API's answer.
"""

from __future__ import annotations

import pytest

from hushh_mcp.services.compute_backend import TIER_DEDICATED, TIER_LOGICAL, PodSpec
from hushh_mcp.services.gcp_backend import GcpBackend, _cpu_for_allocation, _cpu_millis

SPEC = PodSpec(
    hushh_id="HA1TESTPOD0001",
    phone_e164_hash="0" * 64,
    pod_pubkey="not-a-real-key",
    region="us-central1",
    tier=TIER_DEDICATED,
    billing_space_id="test-space",
)


def _render(**kwargs) -> dict:
    backend = GcpBackend(
        project="p", region="us-central1", image="img", service_account="sa@p", **kwargs
    )
    return backend.render_deploy_config(SPEC)


def _cpu_of(config: dict) -> str:
    return config["spec"]["template"]["spec"]["containers"][0]["resources"]["limits"]["cpu"]


def _unthrottled(config: dict) -> bool:
    ann = config["spec"]["template"]["metadata"]["annotations"]
    return ann.get("run.googleapis.com/cpu-throttling") == "false"


@pytest.mark.parametrize(
    ("text", "millis"),
    [("500m", 500), ("1", 1000), ("2", 2000), ("1000m", 1000), ("", 0), ("bogus", 0)],
)
def test_cpu_millis_parses_kubernetes_quantities(text: str, millis: int) -> None:
    assert _cpu_millis(text) == millis


def test_always_allocated_never_renders_less_than_one_vcpu() -> None:
    """The exact constraint Cloud Run enforced, as a property of the renderer."""
    assert _cpu_for_allocation("500m", always_allocated=True) == "1"
    assert _cpu_millis(_cpu_for_allocation("500m", always_allocated=True)) >= 1000


def test_throttled_keeps_the_cheaper_fractional_cpu() -> None:
    """The economy tier is untouched: throttled, 500m is valid and is the right choice."""
    assert _cpu_for_allocation("500m", always_allocated=False) == "500m"


def test_an_explicit_larger_cpu_is_never_reduced() -> None:
    assert _cpu_for_allocation("2", always_allocated=True) == "2"
    assert _cpu_for_allocation("2", always_allocated=False) == "2"


def test_warm_tier_render_is_acceptable_to_cloud_run() -> None:
    config = _render(min_instances=1, max_instances=1, cpu="500m")

    assert _unthrottled(config) is True, "warm tier must keep CPU always allocated"
    assert _cpu_millis(_cpu_of(config)) >= 1000, (
        "Cloud Run rejects cpu < 1 with cpu always allocated; this render would 400"
    )


def test_economy_tier_render_stays_cheap() -> None:
    config = _render(min_instances=0, max_instances=1, cpu="500m")

    assert _unthrottled(config) is False, "economy tier must not buy always-on CPU"
    assert _cpu_of(config) == "500m"


def test_the_invalid_combination_is_unrepresentable_at_any_tier() -> None:
    """Whatever else changes, these two must never be emitted together."""
    for min_instances in (0, 1, 2):
        config = _render(min_instances=min_instances, max_instances=max(min_instances, 1))
        if _unthrottled(config):
            assert _cpu_millis(_cpu_of(config)) >= 1000, (
                f"min_instances={min_instances} renders unthrottled CPU below 1 vCPU"
            )


def test_logical_tier_render_also_holds_the_constraint() -> None:
    spec = PodSpec(
        hushh_id="HA1TESTPOD0002",
        phone_e164_hash="0" * 64,
        pod_pubkey="not-a-real-key",
        region="us-central1",
        tier=TIER_LOGICAL,
    )
    backend = GcpBackend(
        project="p", region="us-central1", image="img", service_account="sa@p", min_instances=1
    )
    config = backend.render_deploy_config(spec)
    if _unthrottled(config):
        assert _cpu_millis(_cpu_of(config)) >= 1000
