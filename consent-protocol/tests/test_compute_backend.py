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


@pytest.mark.parametrize("backend", ["anypoint", "azure-not-yet", "aws"])
def test_resolver_rejects_unsupported_backend(backend):
    with pytest.raises(NotImplementedError):
        resolve_compute_backend(backend)


def test_resolver_reads_env_setting(monkeypatch):
    from hushh_mcp.services.gcp_backend import GcpBackend

    monkeypatch.setenv("PERSONAL_AGENT_BACKEND", "gcp")
    assert isinstance(resolve_compute_backend(), GcpBackend)
    monkeypatch.setenv("PERSONAL_AGENT_BACKEND", "")
    assert isinstance(resolve_compute_backend(), NullBackend)


# --- owner-cloud targets: one predicate instead of a provider literal per call site ---


@pytest.mark.parametrize(
    ("target", "expected"),
    [
        ("user_gcp", True),
        (" user_gcp ", True),
        ("user_azure", True),
        ("azure-not-yet", False),
        ("gcp", False),
        ("null", False),
        ("", False),
        (None, False),
    ],
)
def test_owner_cloud_predicate_names_only_owner_targets(target, expected):
    from hushh_mcp.services.compute_backend import is_owner_cloud_target

    assert is_owner_cloud_target(target) is expected


def test_owner_cloud_bind_is_a_list_parameter_for_static_sql():
    from hushh_mcp.services.compute_backend import OWNER_CLOUD_TARGETS, owner_cloud_bind

    assert owner_cloud_bind() == {"owner_cloud_targets": list(OWNER_CLOUD_TARGETS)}


def test_adding_a_provider_is_one_entry_and_the_provisioning_gate_follows(monkeypatch):
    """An unauthorized owner cloud on a NEW provider must block provisioning.

    Before the predicate, `UserCloud.is_user_owned` compared against one provider id,
    so an unauthorized cloud on any other provider read as "not user owned" and
    `blocks_provisioning` let it through to a backend (fail-open).
    """
    from hushh_mcp.services import compute_backend
    from hushh_mcp.services.user_cloud_service import UserCloud

    monkeypatch.setattr(
        compute_backend, "OWNER_CLOUD_TARGETS", (*compute_backend.OWNER_CLOUD_TARGETS, "user_next")
    )
    cloud = UserCloud(
        deployment_target="user_next",
        model_credential_mode=None,
        project=None,
        region=None,
        bootstrap_sa=None,
        authorized=False,
    )
    assert cloud.is_user_owned
    assert cloud.blocks_provisioning


# --- user_azure: the person's own subscription, resolved only per person -------------

_AZURE_COORDINATES = {
    "user_cloud_tenant_id": "11111111-1111-1111-1111-111111111111",
    "user_cloud_subscription_id": "22222222-2222-2222-2222-222222222222",
    "user_cloud_resource_group": "rg-hussh-one-0123456789abcdef0123",
    "user_cloud_region": "eastus2",
}


def _azure_spec(**overrides) -> PodSpec:
    fields = {**_AZURE_COORDINATES, **overrides}
    return PodSpec(
        hushh_id="ha1_abc",
        phone_e164_hash="hash",
        pod_pubkey="pub",
        deployment_target="user_azure",
        **fields,
    )


def test_user_azure_resolves_to_the_owner_subscription_backend():
    from hushh_mcp.services.compute_backend import (
        BACKEND_USER_AZURE,
        resolve_compute_backend_for_spec,
    )
    from hushh_mcp.services.user_azure_backend import UserAzureBackend

    backend = resolve_compute_backend_for_spec(_azure_spec())
    assert isinstance(backend, UserAzureBackend)
    assert backend.backend_id == BACKEND_USER_AZURE
    assert backend.app_id == (
        "/subscriptions/22222222-2222-2222-2222-222222222222/resourceGroups/"
        "rg-hussh-one-0123456789abcdef0123/providers/Microsoft.App/containerApps/ca-hussh-one-pod"
    )
    assert isinstance(backend, ComputeBackend)


@pytest.mark.parametrize("missing", sorted(_AZURE_COORDINATES))
def test_user_azure_without_every_coordinate_fails_closed(missing):
    """Like user_gcp without a project: never defaulted, never inferred."""
    from hushh_mcp.services.compute_backend import resolve_compute_backend_for_spec

    for blank in (None, "", "   "):
        with pytest.raises(ValueError, match="user_azure"):
            resolve_compute_backend_for_spec(_azure_spec(**{missing: blank}))


def test_user_azure_has_no_deployment_wide_default():
    """A subscription is never a property of the hub, so the env resolver refuses it."""
    with pytest.raises(NotImplementedError):
        resolve_compute_backend("user_azure")


def test_owner_cloud_coordinates_are_declared_per_target():
    from hushh_mcp.services.compute_backend import owner_cloud_coordinates_complete

    assert owner_cloud_coordinates_complete("user_gcp", {"project": "p"})
    assert not owner_cloud_coordinates_complete("user_gcp", {"project": " "})
    complete = {"tenant_id": "t", "subscription_id": "s", "resource_group": "g", "region": "r"}
    assert owner_cloud_coordinates_complete("user_azure", complete)
    assert not owner_cloud_coordinates_complete("user_azure", {**complete, "region": ""})
    assert not owner_cloud_coordinates_complete("user_next", complete)
    assert not owner_cloud_coordinates_complete("gcp", {"project": "p"})


def test_the_gcp_branch_is_unchanged_by_the_azure_branch():
    from hushh_mcp.services.compute_backend import resolve_compute_backend_for_spec
    from hushh_mcp.services.user_gcp_backend import UserGcpBackend

    spec = PodSpec(
        hushh_id="ha1_abc",
        phone_e164_hash="hash",
        pod_pubkey="pub",
        deployment_target="user_gcp",
        user_cloud_project="owner-project",
        **{k: v for k, v in _AZURE_COORDINATES.items() if k != "user_cloud_region"},
    )
    assert isinstance(resolve_compute_backend_for_spec(spec), UserGcpBackend)
