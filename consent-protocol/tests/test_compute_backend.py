"""Tests for the compute-backend seam (the provider abstraction).

Covers the backend-neutral value types, the inert ``NullBackend`` default, and
the ``resolve_compute_backend`` selector -- the guarantee that nothing calls out
to a real host until a backend is both implemented and explicitly named.
"""

from __future__ import annotations

from dataclasses import FrozenInstanceError

import pytest

from hushh_mcp.services.compute_backend import (
    BACKEND_NULL,
    TIER_LOGICAL,
    BackendHandle,
    BackendStatus,
    ComputeBackend,
    NullBackend,
    PodSpec,
    resolve_compute_backend,
)


def _spec() -> PodSpec:
    return PodSpec(hushh_id="ha1_abc", phone_e164_hash="hash", pod_pubkey="pub")


def test_pod_spec_defaults_are_backend_neutral():
    spec = _spec()
    assert spec.tier == TIER_LOGICAL
    assert spec.billing_space_id is None
    assert spec.region is None
    with pytest.raises(FrozenInstanceError):
        spec.hushh_id = "mutated"  # type: ignore[misc]


def test_backend_handle_defaults_are_empty():
    handle = BackendHandle()
    assert handle.external_agent_id is None
    assert handle.a2a_route is None
    assert handle.backend is None
    assert handle.attestation_ref is None
    assert handle.status == TIER_LOGICAL


def test_null_backend_satisfies_the_protocol():
    assert isinstance(NullBackend(), ComputeBackend)
    assert NullBackend().backend_id == BACKEND_NULL


async def test_null_backend_provision_returns_empty_logical_handle():
    handle = await NullBackend().provision(_spec())
    # An empty handle -> the registry keeps its schema NULLs (Phase-0 behavior).
    assert handle.external_agent_id is None
    assert handle.a2a_route is None
    assert handle.attestation_ref is None
    assert handle.status == TIER_LOGICAL
    # All-None (incl. backend): a NullBackend row keeps its schema NULLs.
    assert handle.backend is None


async def test_null_backend_deprovision_is_a_noop():
    assert await NullBackend().deprovision("anything") is None


async def test_null_backend_get_is_unhealthy_unknown():
    status = await NullBackend().get("ext-1")
    assert isinstance(status, BackendStatus)
    assert status.external_agent_id == "ext-1"
    assert status.healthy is False
    assert status.status == "unknown"


async def test_null_backend_health_is_true():
    assert await NullBackend().health() is True


def test_resolver_defaults_to_null_backend(monkeypatch):
    monkeypatch.delenv("PERSONAL_AGENT_BACKEND", raising=False)
    assert isinstance(resolve_compute_backend(), NullBackend)


@pytest.mark.parametrize("value", ["", "null", "none", "  NULL  "])
def test_resolver_empty_or_null_is_inert(value):
    assert isinstance(resolve_compute_backend(value), NullBackend)


def test_resolver_constructs_gcp_backend():
    from hushh_mcp.services.gcp_backend import GcpBackend

    assert isinstance(resolve_compute_backend("gcp"), GcpBackend)
    assert isinstance(resolve_compute_backend("GCP"), GcpBackend)  # case-insensitive


def test_resolver_constructs_anypoint_backend():
    from hushh_mcp.services.anypoint_backend import AnypointBackend

    assert isinstance(resolve_compute_backend("anypoint"), AnypointBackend)


def test_resolver_rejects_unknown_backend():
    with pytest.raises(NotImplementedError):
        resolve_compute_backend("azure-not-yet")


def test_resolver_reads_env_setting(monkeypatch):
    from hushh_mcp.services.gcp_backend import GcpBackend

    monkeypatch.setenv("PERSONAL_AGENT_BACKEND", "gcp")
    assert isinstance(resolve_compute_backend(), GcpBackend)
    monkeypatch.setenv("PERSONAL_AGENT_BACKEND", "")
    assert isinstance(resolve_compute_backend(), NullBackend)
