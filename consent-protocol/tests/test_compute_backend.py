"""Tests for the compute-backend seam (the provider abstraction).

Covers the backend-neutral value types, the inert ``NullBackend`` default, and
the ``resolve_compute_backend`` selector -- the guarantee that nothing calls out
to a real host until a backend is both implemented and explicitly named.
"""

from __future__ import annotations

from dataclasses import FrozenInstanceError, replace

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


def _vm_spec_and_metadata():
    from hushh_mcp.services.compute_backend import adoption_expectations
    from tests.test_azure_vm_host import installation

    config = installation()
    host = config["installation"]
    group = host["resource_id"].split("/providers/")[0]
    principal = "33333333-3333-3333-3333-333333333333"
    metadata = {
        "hostKind": "azure_vm",
        "vmHost": {
            "installation": host,
            "identityResourceId": group
            + "/providers/Microsoft.ManagedIdentity/userAssignedIdentities/agent",
            "principalId": principal,
            "location": "northcentralus",
        },
        "url": "https://owner.example.com",
        "image": config["image"],
        "image_digest": host["image_digest"],
        "serviceUid": host["generation"],
        "runtime_principal_id": principal,
        "runtime_client_id": host["client_id"],
        "setupNonce": "0123456789abcdef",
    }
    spec = _azure_spec(
        user_cloud_resource_group="owner",
        user_cloud_region="northcentralus",
        **adoption_expectations(metadata),
    )
    from dataclasses import replace

    return replace(spec, hushh_id=host["hushh_id"]), metadata


@pytest.mark.parametrize(
    "fault", ["kind", "missing", "principal", "client", "digest", "tag", "url", "extra"]
)
def test_retained_vm_host_cannot_silently_resolve_as_container_apps(fault):
    from hushh_mcp.services.compute_backend import adoption_expectations

    _, metadata = _vm_spec_and_metadata()
    if fault == "missing":
        metadata.pop("vmHost")
    elif fault == "kind":
        metadata["hostKind"] = "unqualified"
    elif fault == "extra":
        metadata["vmHost"]["runCommand"] = "unapproved"
    else:
        field = {
            "principal": "runtime_principal_id",
            "client": "runtime_client_id",
            "digest": "image_digest",
            "tag": "image",
            "url": "url",
        }[fault]
        metadata[field] = "changed"
    with pytest.raises(ValueError):
        adoption_expectations(metadata)


@pytest.mark.asyncio
async def test_vm_backend_attaches_exact_host_without_wake_or_false_health(monkeypatch):
    from hushh_mcp.services.azure_arm_client import ArmClient
    from hushh_mcp.services.compute_backend import (
        RestartableBackend,
        resolve_compute_backend_for_spec,
    )
    from hushh_mcp.services.user_azure_vm_backend import UserAzureVmBackend
    from tests.test_azure_vm_power import Provider

    spec, metadata = _vm_spec_and_metadata()
    resolved = resolve_compute_backend_for_spec(spec)
    assert isinstance(resolved, UserAzureVmBackend)
    assert isinstance(resolved, ComputeBackend) and not isinstance(resolved, RestartableBackend)
    assert resolved.live is False
    provider = Provider(spec.azure_vm_host.target())
    monkeypatch.setattr("requests.Session", lambda: provider)
    backend = UserAzureVmBackend(spec, observer=lambda: ArmClient("synthetic"))
    sleeping = await backend.get(resolved.app_id)
    assert sleeping.status == "sleeping" and sleeping.healthy is False
    provider.power = "running"
    running = await backend.get(resolved.app_id)
    assert running.status == "running" and running.healthy is False
    with pytest.raises(RuntimeError, match="exact owner-approved recovery"):
        await backend.provision(spec)
    assert not hasattr(backend, "discover")  # Generic recovery must not rotate retained VM keys.
    assert spec.azure_vm_host.record() == metadata["vmHost"]
    assert provider.posts == [] and provider.closed
    with pytest.raises(ValueError):
        await backend.get(resolved.app_id + "-other")


@pytest.mark.asyncio
@pytest.mark.parametrize("fault", ["forbidden", "absent", "incarnation", "principal", "image"])
async def test_vm_observation_refuses_changed_identity_and_does_not_call_denial_absence(
    monkeypatch, fault
):
    from hushh_mcp.services.azure_arm_client import ArmClient, ArmError
    from hushh_mcp.services.azure_vm_power import AzureVmPowerRefused
    from hushh_mcp.services.user_azure_vm_backend import UserAzureVmBackend
    from tests.test_azure_vm_power import Provider, _Response

    spec, _ = _vm_spec_and_metadata()
    target = spec.azure_vm_host.target()
    provider = Provider(target)
    if fault in {"forbidden", "absent"}:
        provider.request = lambda *_a, **_k: _Response(403 if fault == "forbidden" else 404, {})
    elif fault == "incarnation":
        provider.vm["properties"]["vmId"] = "99999999-9999-9999-9999-999999999999"
    elif fault == "principal":
        provider.vm["identity"]["userAssignedIdentities"][target.identity_resource_id][
            "principalId"
        ] = "different"
    else:
        provider.vm["tags"]["husshPodImage"] = "sha256:" + "f" * 64
    monkeypatch.setattr("requests.Session", lambda: provider)
    backend = UserAzureVmBackend(spec, observer=lambda: ArmClient("synthetic"))
    if fault == "absent":
        assert (await backend.get(backend.app_id)).status == "gone"
    else:
        with pytest.raises(ArmError if fault == "forbidden" else AzureVmPowerRefused):
            await backend.get(backend.app_id)
    assert provider.posts == [] and provider.closed


@pytest.mark.parametrize(
    "field",
    [
        "hushh_id",
        "expected_service_uid",
        "expected_runtime_principal",
        "user_cloud_subscription_id",
        "user_cloud_region",
        "deployment_target",
    ],
)
def test_vm_host_cannot_be_retargeted_after_registry_capture(field):
    from dataclasses import replace

    from hushh_mcp.services.compute_backend import resolve_compute_backend_for_spec

    spec, _ = _vm_spec_and_metadata()
    with pytest.raises(ValueError):
        resolve_compute_backend_for_spec(replace(spec, **{field: "changed"}))


@pytest.mark.asyncio
async def test_vm_status_cancellation_joins_and_closes_its_real_reader(monkeypatch):
    import asyncio
    from threading import Event

    from hushh_mcp.services.azure_arm_client import ArmClient
    from hushh_mcp.services.user_azure_vm_backend import UserAzureVmBackend
    from tests.test_azure_vm_power import Provider

    spec, _ = _vm_spec_and_metadata()
    provider = Provider(spec.azure_vm_host.target())
    original, entered, release = provider.request, Event(), Event()

    def blocked(*args, **kwargs):
        entered.set()
        assert release.wait(2)
        return original(*args, **kwargs)

    provider.request = blocked
    monkeypatch.setattr("requests.Session", lambda: provider)
    backend = UserAzureVmBackend(spec, observer=lambda: ArmClient("synthetic"))
    task = asyncio.create_task(backend.get(backend.app_id))
    try:
        assert await asyncio.to_thread(entered.wait, 1)
        task.cancel()
        await asyncio.sleep(0)
        assert not task.done()  # A cancelled executor proxy is not reader exit.
        release.set()
        with pytest.raises(asyncio.CancelledError):
            await asyncio.wait_for(task, 2)
        assert provider.closed and provider.posts == []
    finally:
        release.set()
        await asyncio.gather(task, return_exceptions=True)


@pytest.mark.parametrize("fault", [None, "nonce", "replacement", "confirmation"])
async def test_vm_cleanup_checkpoints_exact_reserved_host_without_arm_effects(fault):
    from hushh_mcp.services.azure_arm_client import ArmClient
    from hushh_mcp.services.azure_owner_cleanup import _checkpoint_backend
    from hushh_mcp.services.azure_setup_plan import PlanInputs, tags
    from hushh_mcp.services.azure_vm_power import AzureVmPowerRefused
    from hushh_mcp.services.compute_backend import OwnerAccessCheckpointBackend
    from tests.test_azure_vm_power import Provider

    spec, metadata = _vm_spec_and_metadata()
    inputs = PlanInputs(
        spec.hushh_id,
        spec.user_cloud_tenant_id,
        spec.user_cloud_subscription_id,
        spec.user_cloud_region,
        spec.user_cloud_resource_group,
        spec.expected_setup_nonce,
    )
    provider = Provider(spec.azure_vm_host.target())
    provider.vm["tags"].update(tags(inputs))
    arm = ArmClient("synthetic", session=provider)
    snapshot = {
        "hushh_id": spec.hushh_id,
        "deployment_target": "user_azure",
        "user_cloud_tenant_id": inputs.tenant_id,
        "user_cloud_subscription_id": inputs.subscription_id,
        "user_cloud_resource_group": inputs.resource_group,
        "user_cloud_region": inputs.location,
        "backend_metadata": metadata,
    }
    backend = _checkpoint_backend(snapshot, inputs, arm)
    assert isinstance(backend, OwnerAccessCheckpointBackend)
    expected = {
        "service": spec.azure_vm_host.installation.resource_id,
        "serviceUid": spec.expected_service_uid,
        "revision": spec.expected_service_uid,
        "podUrl": metadata["url"],
    }
    assert await backend.observe_erasure_target(spec) == expected
    if fault == "nonce":
        provider.vm["tags"].update(tags(replace(inputs, nonce="f" * 16)))
    elif fault == "replacement":
        provider.vm["properties"]["vmId"] = "99999999-9999-9999-9999-999999999999"
    called = []

    async def crypto_erase(resume):
        called.append(resume)
        return {
            "erased": fault != "confirmation",
            "hushhId": spec.hushh_id,
            "serviceUid": spec.expected_service_uid,
        }

    if fault:
        with pytest.raises((RuntimeError, AzureVmPowerRefused)):
            await backend.checkpoint_owner_access(spec, crypto_erase=crypto_erase)
    else:
        await backend.checkpoint_owner_access(spec, crypto_erase=crypto_erase)
        assert called == [{"setupNonce": inputs.nonce}]
    if fault in {"nonce", "replacement"}:
        assert called == []
    assert provider.posts == [] and not provider.closed
    with pytest.raises(RuntimeError, match="retained owner cleanup"):
        await backend.erase_owner_access(spec, crypto_erase=crypto_erase)
