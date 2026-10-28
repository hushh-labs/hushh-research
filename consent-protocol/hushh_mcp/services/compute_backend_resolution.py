"""Provider resolution behind the stable private compute contract facade."""

from __future__ import annotations

from typing import Any, Literal, Optional

from hushh_mcp.services.compute_backend import (
    BACKEND_GCP,
    BACKEND_NULL,
    BACKEND_USER_AZURE,
    BACKEND_USER_GCP,
    ComputeBackend,
    NullBackend,
    PodSpec,
    is_owner_cloud_target,
    owner_cloud_coordinates_complete,
)


def resolve_deployment_backend(backend_id: Optional[str] = None) -> ComputeBackend:
    """Resolve configured GCP hosting; empty/null remains safely unconfigured."""
    from hushh_mcp.runtime_settings import personal_agent_backend

    chosen = (backend_id if backend_id is not None else personal_agent_backend()).strip().lower()
    if chosen in ("", BACKEND_NULL, "none"):
        return NullBackend()
    if chosen == BACKEND_GCP:
        from hushh_mcp.services.gcp_backend import GcpBackend

        # Defaults to inert plan/dry-run mode: it renders deploy artifacts + handles
        # but makes NO live GCP call until explicitly enabled with credentials.
        gcp: ComputeBackend = GcpBackend()
        return gcp
    if chosen == BACKEND_USER_GCP:
        from hushh_mcp.services.user_gcp_backend import UserGcpBackend

        # BYOC: renders the pod + a keyless impersonation bootstrap plan for the USER's project.
        # Plan-mode by default; live raises until the owner bootstrap exists.
        user_gcp: ComputeBackend = UserGcpBackend()
        return user_gcp
    # `user_azure` is deliberately absent: it has no deployment-wide destination, so it
    # resolves only per person, through `resolve_compute_backend_for_spec`.
    raise NotImplementedError(
        f"compute backend '{chosen}' is not recognized (expected: null | gcp | user_gcp)"
    )


def resolve_owner_backend(spec: PodSpec) -> ComputeBackend:
    """Pick the backend for ONE person, from their own spec.

    `resolve_compute_backend()` answers "what does this deployment run?" — a
    process-wide question, and the only one that could be asked while both axes lived
    in environment variables. This answers "where does THIS person's pod run?", which
    is the question BYOC actually poses: their pod runs in their project whatever the
    hub happens to be configured for.

    Falls back to the deployment default when the spec names no target, so this is a
    superset of the existing behaviour rather than a second, competing resolver. An
    unrecognised target still raises through `resolve_compute_backend` — a person
    whose stored target is a typo must fail loudly, not silently land on the hub's
    default, which for a BYOC user would mean provisioning into hushh's project
    instead of their own. That is the one failure mode worth being noisy about.
    """
    target = (spec.deployment_target or "").strip() or None
    if spec.private_gcp_deployment is not None:
        from hushh_mcp.services.hosted_gcp_backend import hosted_backend_for_spec

        return hosted_backend_for_spec(spec)
    if spec.azure_vm_host is not None and target != BACKEND_USER_AZURE:
        raise ValueError("Azure VM host cannot be used with another deployment target")
    if target == BACKEND_USER_AZURE:
        return owner_azure_backend(spec)
    if target != BACKEND_USER_GCP:
        from hushh_mcp.services.compute_backend import resolve_compute_backend

        return resolve_compute_backend(target)

    # The tenant-bearing branch. `resolve_compute_backend` constructs its backends with
    # no arguments, which is right for every target whose destination is a property of
    # the deployment -- and exactly wrong for the one whose destination is a property of
    # the PERSON. Routing this branch through the generic resolver is what put two
    # people's pods in one project.
    if not (spec.user_cloud_project or "").strip():
        raise ValueError(
            "a user_gcp pod needs the person's own project on its spec, and it is never "
            "inferred. Falling back to HUSSH_USER_GCP_PROJECT here would build this "
            "person's pod inside whichever project that variable happens to name -- "
            "which, with more than one BYOC person, is somebody else's cloud."
        )

    from hushh_mcp.services.user_gcp_backend import UserGcpBackend

    tenant: ComputeBackend = UserGcpBackend(
        user_project=spec.user_cloud_project,
        user_region=spec.user_cloud_region or None,
        bootstrap_sa=spec.user_cloud_bootstrap_sa or None,
        hushh_id=spec.hushh_id,
    )
    return tenant


def owner_azure_backend(spec: PodSpec) -> ComputeBackend:
    """Resolve recorded owner coordinates and host binding, without a fleet default.

    Missing coordinates refuse; a destination is never inferred from the hub.
    """
    coordinates = {
        "tenant_id": spec.user_cloud_tenant_id,
        "subscription_id": spec.user_cloud_subscription_id,
        "resource_group": spec.user_cloud_resource_group,
        "region": spec.user_cloud_region,
    }
    if not owner_cloud_coordinates_complete(BACKEND_USER_AZURE, coordinates):
        missing = sorted(name for name, value in coordinates.items() if not (value or "").strip())
        raise ValueError(
            "a user_azure pod needs the person's own tenant, subscription, resource group "
            f"and location on its spec, and none is ever inferred (missing: {missing})."
        )

    if spec.azure_vm_host is not None:
        from hushh_mcp.services.user_azure_vm_backend import UserAzureVmBackend

        return UserAzureVmBackend(spec)

    from hushh_mcp.services.user_azure_backend import UserAzureBackend

    azure: ComputeBackend = UserAzureBackend(
        tenant_id=str(spec.user_cloud_tenant_id).strip(),
        subscription_id=str(spec.user_cloud_subscription_id).strip(),
        resource_group=str(spec.user_cloud_resource_group).strip(),
        location=str(spec.user_cloud_region).strip(),
        recorded_principal=spec.expected_runtime_principal or "",
        recorded_digest=spec.expected_image_digest or "",
        files_library_enabled=spec.files_library_enabled,
    )
    return azure


def private_pod_row(row: Any) -> bool:
    """Known owner cloud or a verified per-owner managed placement; never a fleet flag."""
    from collections.abc import Mapping

    from hushh_mcp.services.hosted_gcp_placement import (
        has_hosted_evidence,
        retained_hosted_placement,
    )

    if not isinstance(row, Mapping):
        return False
    candidate = dict(row)
    if has_hosted_evidence(candidate):
        return retained_hosted_placement(candidate) is not None
    return is_owner_cloud_target(row.get("deployment_target"))


async def bind_reserved_spec(
    spec: PodSpec,
    reservation: dict,
    *,
    registry: Any,
    release: dict,
    purpose: Literal["bootstrap", "provision"] | None = None,
) -> PodSpec:
    """The lifecycle asks for an admitted spec without naming its hosting adapter."""
    if not reservation.get("hostedAdmission"):
        return spec
    from hushh_mcp.services.hosted_gcp_admission import bind_provision_spec
    from hushh_mcp.services.provision_attempt import ProvisionReconciliationRequired

    try:
        principal = reservation["hostedAdmission"]["assignment"]["bootstrapContract"]["plan"][
            "federation"
        ]["impersonation"]["granted_to"]
    except (KeyError, TypeError):
        raise ProvisionReconciliationRequired("Managed project preparation is incomplete") from None
    return await bind_provision_spec(
        spec,
        reservation,
        registry=registry,
        release=release,
        hub_principal=principal,
        execute=True,
        purpose=purpose,
    )


async def bind_private_upgrade(
    spec: PodSpec, row: dict, *, registry: Any, lease: str | None
) -> PodSpec:
    from hushh_mcp.services.hosted_gcp_placement import has_hosted_evidence

    if not has_hosted_evidence(row):
        return spec
    from hushh_mcp.services.hosted_upgrade_authority import bind_managed_upgrade

    return await bind_managed_upgrade(spec, row, registry=registry, lease=lease)


def bind_private_cleanup(spec: PodSpec, snapshot: dict, *, registry: Any) -> PodSpec:
    from hushh_mcp.services.hosted_gcp_placement import has_hosted_evidence

    if not has_hosted_evidence(snapshot):
        return spec
    from hushh_mcp.services.hosted_cleanup_authority import bind_managed_cleanup

    return bind_managed_cleanup(spec, snapshot, registry=registry)


def frozen_cleanup_coordinates(snapshot: dict) -> tuple[str, str]:
    from hushh_mcp.services.hosted_gcp_placement import has_hosted_evidence

    if has_hosted_evidence(snapshot):
        from hushh_mcp.services.hosted_cleanup_authority import (
            frozen_cleanup_coordinates as managed,
        )

        return managed(snapshot)
    return str(snapshot.get("user_cloud_project") or ""), str(
        snapshot.get("user_cloud_bootstrap_sa") or ""
    ).removeprefix("serviceAccount:")


async def require_erasure_supported(row: Any, *, registry: Any) -> None:
    from hushh_mcp.services.hosted_gcp_placement import has_hosted_evidence
    from hushh_mcp.services.hosted_tier_guard import require_supported_erasure

    if not has_hosted_evidence(row):
        require_supported_erasure(row)
        return
    if not await registry.hosted_retained_current(owner_id=row["user_id"], observed=row):
        raise RuntimeError("Private cleanup requires its retained assignment")


def cleanup_spec(snapshot: dict, *, registry: Any) -> PodSpec:
    from hushh_mcp.services.compute_backend import adoption_expectations
    from hushh_mcp.services.user_cloud_service import spec_coordinates_from_row

    metadata = snapshot.get("backend_metadata") or {}
    spec = PodSpec(
        hushh_id=snapshot["hushh_id"],
        phone_e164_hash=str(snapshot.get("phone_e164_hash") or ""),
        pod_pubkey=str(snapshot.get("pod_pubkey") or ""),
        billing_space_id=snapshot.get("billing_space_id"),
        **adoption_expectations(metadata),
        deployment_target=snapshot.get("deployment_target"),
        model_credential_mode=snapshot.get("model_credential_mode"),
        **spec_coordinates_from_row(snapshot),
    )
    return bind_private_cleanup(spec, snapshot, registry=registry)
