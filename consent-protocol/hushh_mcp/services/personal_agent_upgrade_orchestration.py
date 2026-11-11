"""Admission and ordered orchestration for an existing pod upgrade."""

from __future__ import annotations

from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from typing import TYPE_CHECKING, Any, Protocol

from hushh_mcp.runtime_settings import (
    personal_agent_enabled,
    personal_agent_upgrade_approval_required,
)
from hushh_mcp.services.compute_backend import (
    ComputeBackend,
    PodSpec,
    adoption_expectations,
    is_known_pod_target,
    is_owner_cloud_target,
)
from hushh_mcp.services.owner_direct_ingress import ingress_for_update
from hushh_mcp.services.personal_agent_grant_service import PersonalAgentDisabledError
from hushh_mcp.services.personal_agent_upgrade_policy import (
    _approval_is_well_formed,
    running_image,
    upgrade_approval_matches,
    upgrade_operation_is_recoverable,
)
from hushh_mcp.services.pod_release import (
    approved_release,
    image_digest,
    upgrade_is_supported,
)
from hushh_mcp.services.pod_update_identity import configuration_approval_pending
from hushh_mcp.services.user_cloud_service import UserCloud, spec_coordinates

if TYPE_CHECKING:
    from hushh_mcp.services.pod_browser.capability_update import GcpBrowserCapabilityPlan
    from hushh_mcp.services.pod_files.azure_capability import AzureFilesCapabilityPlan
    from hushh_mcp.services.pod_files.capability_update import FilesCapabilityPlan


class _Registry(Protocol):
    async def get(self, user_id: str) -> dict | None: ...


class _Owner(Protocol):
    @property
    def _registry(self) -> _Registry: ...

    def _backend_for(self, spec: PodSpec) -> ComputeBackend: ...

    async def _reconcile_image_upgrade(
        self,
        *,
        user_id: str,
        row: dict[str, Any],
        spec: PodSpec,
        backend: ComputeBackend,
        lease: object,
    ) -> dict[str, Any]: ...


@dataclass(frozen=True)
class UpgradeAdmission:
    user_id: str
    current_image: str
    resume_files_queue_operation: str | None
    resume_files_job: dict[str, Any] | None
    row: dict[str, Any]
    metadata: dict[str, Any]
    hushh_id: str
    held_lease: object | None
    files_capability: FilesCapabilityPlan | AzureFilesCapabilityPlan | None
    browser_capability: GcpBrowserCapabilityPlan | None
    spec: PodSpec
    backend: ComputeBackend


async def _load_upgrade_row(
    owner: _Owner, user_id: str, current_image: str
) -> tuple[dict[str, Any], dict[str, Any], str, str, object | None]:
    if not personal_agent_enabled():
        raise PersonalAgentDisabledError("upgrade requested while PERSONAL_AGENT_ENABLED is off")
    row = await owner._registry.get(user_id)
    from hushh_mcp.services.personal_agent_provisioning_service import (
        PersonalAgentUpgradeNotApprovedError,
    )

    if row is None:
        raise ValueError("no personal agent is registered for this person")
    if str(row.get("status") or "") != "provisioned":
        raise ValueError(
            f"only a provisioned pod can be upgraded (status is {row.get('status')!r})"
        )
    hushh_id = str(row.get("hushh_id") or "").strip()
    phone_hash = str(row.get("phone_e164_hash") or "").strip()
    if not hushh_id or not phone_hash:
        raise ValueError("registry row is missing its identity; refusing to upgrade")
    metadata = row.get("backend_metadata") or {}
    if not isinstance(metadata, dict):
        raise ValueError("registry row metadata is invalid; refusing to upgrade")
    held = metadata.get("upgradeLease")
    legacy_injected_row = _legacy_injected_row(row, metadata)
    if not is_known_pod_target(row.get("deployment_target")) and not legacy_injected_row:
        raise PersonalAgentUpgradeNotApprovedError(
            "a verified pod placement is required before an update or recovery"
        )
    if held is not None:
        from hushh_mcp.services.personal_agent_registry_repo import (
            upgrade_lease_host_binding_matches,
        )

        if not upgrade_lease_host_binding_matches(row) and not legacy_injected_row:
            raise PersonalAgentUpgradeNotApprovedError(
                "retained update host binding is missing or changed; provider recovery is unavailable"
            )
    requires_approval = (
        personal_agent_upgrade_approval_required()
        or configuration_approval_pending(metadata.get("upgradeApproval"))
        or is_owner_cloud_target(row.get("deployment_target"))
    )
    approval_matches = upgrade_approval_matches(row, current_image)
    recoverable = upgrade_operation_is_recoverable(row)
    if requires_approval and not (approval_matches or (held is not None and recoverable)):
        raise PersonalAgentUpgradeNotApprovedError(
            "owner approval for this release and pod incarnation is required"
        )
    _require_installed_release(row, metadata, current_image, requires_approval, held)
    return row, metadata, hushh_id, phone_hash, held


def _require_installed_release(
    row: dict[str, Any],
    metadata: dict[str, Any],
    current_image: str,
    requires_approval: bool,
    held: object | None,
) -> None:
    from hushh_mcp.services.personal_agent_provisioning_service import (
        PersonalAgentUpgradeNotApprovedError,
    )

    if not requires_approval or held is not None:
        return
    release = approved_release(metadata.get("upgradeApproval"), current_image)
    installed = metadata.get("image_digest") or running_image(row)
    compatibility_host = (
        is_owner_cloud_target(row.get("deployment_target"))
        or _legacy_injected_row(row, metadata)
        or _retained_managed_files_update_host(row, metadata)
    )
    if compatibility_host and upgrade_is_supported(release, installed):
        return
    pending_same_host = (
        release is not None
        and compatibility_host
        and configuration_approval_pending(metadata.get("upgradeApproval"))
        and image_digest(installed) == image_digest(current_image)
    )
    if not pending_same_host:
        raise PersonalAgentUpgradeNotApprovedError(
            "verified compatibility metadata for this installed image is required"
        )


def _retained_managed_files_update_host(row: dict[str, Any], metadata: dict[str, Any]) -> bool:
    """Allow managed compatibility only for a retained GCP Files placement."""
    if (
        row.get("deployment_target") != "gcp"
        or metadata.get("tenancy") != "hussh-hosted"
        or "hostKind" in metadata
        or "vmHost" in metadata
    ):
        return False
    approval = metadata.get("upgradeApproval")
    if not isinstance(approval, dict):
        return False
    try:
        from hushh_mcp.services.hosted_gcp_placement import retained_hosted_placement
        from hushh_mcp.services.pod_update_identity import approved_files_plan

        if approved_files_plan(approval) is None:
            return False
        placement = retained_hosted_placement(row)
    except (TypeError, ValueError):
        return False
    return bool(
        placement is not None
        and row.get("external_agent_id") == placement.service
        and metadata.get("service") == placement.service
        and metadata.get("serviceUid") == placement.service_uid
        and metadata.get("project") == placement.project
        and metadata.get("region") == placement.region
    )


def _legacy_injected_row(row: dict[str, Any], metadata: dict[str, Any]) -> bool:
    """Keep historical injected rows on their established approval path."""
    return row.get("deployment_target") is None and metadata.get("tenancy") != "hussh-hosted"


async def _resolve_upgrade_cloud(
    owner: _Owner,
    user_id: str,
    row: dict[str, Any],
    resolve_cloud: Callable[..., Awaitable[UserCloud | None]],
) -> UserCloud | None:
    from hushh_mcp.services.personal_agent_provisioning_service import (
        PersonalAgentCloudNotAuthorizedError,
        PersonalAgentUpgradeNotApprovedError,
    )

    cloud = await resolve_cloud(user_id, repo=owner._registry)
    if cloud is not None and cloud.blocks_provisioning:
        raise PersonalAgentCloudNotAuthorizedError(cloud.refusal_reason)
    if (
        cloud is not None
        and cloud.deployment_target
        and cloud.deployment_target != row.get("deployment_target")
    ):
        raise PersonalAgentUpgradeNotApprovedError("the pod placement changed before update")
    return cloud


async def _build_upgrade_spec(
    owner: _Owner,
    *,
    user_id: str,
    current_image: str,
    row: dict[str, Any],
    metadata: dict[str, Any],
    hushh_id: str,
    phone_hash: str,
    held: object | None,
    cloud: UserCloud | None,
    resume_files_job: dict[str, Any] | None,
) -> tuple[
    PodSpec,
    ComputeBackend,
    FilesCapabilityPlan | AzureFilesCapabilityPlan | None,
    GcpBrowserCapabilityPlan | None,
]:
    from hushh_mcp.services.pod_update_capabilities import (
        admit_capabilities,
        approved_update_browser_qualification,
    )

    approval = metadata.get("upgradeApproval")
    approval_matches = upgrade_approval_matches(row, current_image)
    recoverable = upgrade_operation_is_recoverable(row)
    files, browser = await admit_capabilities(
        owner._registry,
        row,
        approval_matches=approval_matches,
        recoverable_operation=recoverable,
    )
    approval_valid = _approval_is_well_formed(row, approval) or (
        held is not None and _approval_is_well_formed(row, approval, allow_unresolved=True)
    )
    operation_id = (
        str(approval.get("operationId") or "").strip()
        if approval_valid and isinstance(approval, dict)
        else ""
    ) or None
    spec = PodSpec(
        hushh_id=hushh_id,
        phone_e164_hash=phone_hash,
        billing_space_id=row.get("billing_space_id"),
        pod_pubkey=str(row.get("pod_pubkey") or ""),
        **adoption_expectations(metadata),
        deployment_target=row.get("deployment_target")
        or (cloud.deployment_target if cloud else None),
        model_credential_mode=row.get("model_credential_mode")
        or (cloud.model_credential_mode if cloud else None),
        **spec_coordinates(cloud),
        files_library_enabled=bool(cloud and cloud.files_library_enabled),
        upgrade_operation_id=operation_id,
        files_upgrade_plan=files.model_dump() if files else None,
        browser_upgrade_plan=browser.model_dump(mode="json") if browser else None,
        files_upgrade_recovery_job=resume_files_job,
        upgrade_target_image=(
            str(approval.get("targetImage") or "").strip() or None
            if approval_valid and isinstance(approval, dict)
            else None
        ),
        browser_qualification=approved_update_browser_qualification(row, approved=approval_valid),
        resource_tier=row.get("liveness_mode"),
        ingress=ingress_for_update(metadata),
    )
    from hushh_mcp.services.compute_backend_resolution import bind_private_upgrade

    spec = await bind_private_upgrade(spec, row, registry=owner._registry, lease=held)
    return spec, owner._backend_for(spec), files, browser


async def prepare_upgrade(
    owner: _Owner,
    *,
    user_id: str,
    current_image: str,
    resume_files_queue_operation: str | None,
    resume_files_job: dict[str, Any] | None,
    resolve_cloud: Callable[..., Awaitable[UserCloud | None]],
) -> UpgradeAdmission:
    row, metadata, hushh_id, phone_hash, held = await _load_upgrade_row(
        owner, user_id, current_image
    )
    cloud = await _resolve_upgrade_cloud(owner, user_id, row, resolve_cloud)
    spec, backend, files, browser = await _build_upgrade_spec(
        owner,
        user_id=user_id,
        current_image=current_image,
        row=row,
        metadata=metadata,
        hushh_id=hushh_id,
        phone_hash=phone_hash,
        held=held,
        cloud=cloud,
        resume_files_job=resume_files_job,
    )
    return UpgradeAdmission(
        user_id=user_id,
        current_image=current_image,
        resume_files_queue_operation=resume_files_queue_operation,
        resume_files_job=resume_files_job,
        row=row,
        metadata=metadata,
        hushh_id=hushh_id,
        held_lease=held,
        files_capability=files,
        browser_capability=browser,
        spec=spec,
        backend=backend,
    )
