"""Queue continuation and existing registry lease admission for upgrades."""

from __future__ import annotations

import logging
from collections.abc import Awaitable, Callable
from dataclasses import dataclass, replace
from typing import Any, cast

from hushh_mcp.services.compute_backend import BackendHandle, ComputeBackend, PodSpec
from hushh_mcp.services.personal_agent_upgrade_orchestration import UpgradeAdmission, _Owner
from hushh_mcp.services.personal_agent_upgrade_policy import running_image, set_by_newer_hub
from hushh_mcp.services.personal_agent_upgrade_publication import _FilesExecutor

logger = logging.getLogger(__name__)


def _hosted_files_deployed_image(backend: ComputeBackend, spec: PodSpec, source_image: str) -> str:
    """Bind the approved source digest to its retained owner-project image URI."""
    from hushh_mcp.services.hosted_gcp_backend import HostedGcpBackend
    from hushh_mcp.services.pod_release import image_digest

    deployment = spec.private_gcp_deployment
    digest = image_digest(source_image)
    if (
        not isinstance(backend, HostedGcpBackend)
        or deployment is None
        or digest is None
        or spec.deployment_target != "gcp"
    ):
        raise ValueError("managed Files needs its retained owner image deployment")
    deployed_image = backend._user_pod_image_ref(spec, digest)
    if (
        deployed_image != deployment.image
        or deployed_image.rsplit("@", 1)[-1] != digest
        or not deployed_image.startswith(
            f"{deployment.region}-docker.pkg.dev/{deployment.project}/one-pod/consent-protocol-pod@"
        )
    ):
        raise ValueError("managed Files owner image differs from the retained deployment")
    return deployed_image


@dataclass(frozen=True)
class UpgradeClaim:
    row: dict[str, Any]
    spec: PodSpec
    backend: ComputeBackend
    upgrade: Callable[[PodSpec], Awaitable[BackendHandle]]
    files_executor: _FilesExecutor | None
    lease: str
    requested_binding: dict[str, Any] | None


@dataclass(frozen=True)
class UpgradeClaimOutcome:
    claim: UpgradeClaim | None
    result: dict[str, Any] | None


def _in_progress(admission: UpgradeAdmission, row: dict[str, Any]) -> dict[str, Any]:
    image = running_image(row)
    return {
        "hushhId": admission.hushh_id,
        "status": "provisioned",
        "upgraded": False,
        "skipped": "in_progress",
        "image": image,
        "previousImage": image,
    }


def _require_live_upgrader(
    admission: UpgradeAdmission,
) -> Callable[[PodSpec], Awaitable[BackendHandle]]:
    from hushh_mcp.services.personal_agent_provisioning_service import (
        PersonalAgentUpgradeUnsupportedError,
    )

    upgrade = getattr(admission.backend, "upgrade", None)
    if upgrade is None:
        raise PersonalAgentUpgradeUnsupportedError(
            f"backend {getattr(admission.backend, 'backend_id', '?')!r} cannot upgrade a pod in place"
        )
    if getattr(admission.backend, "live", True) is False:
        raise PersonalAgentUpgradeUnsupportedError(
            f"backend {getattr(admission.backend, 'backend_id', '?')!r} is in plan mode: it renders a "
            "deployment without calling its provider. Refusing rather than recording an "
            "upgrade that never happened; give the backend its live credentials first."
        )
    return cast(Callable[[PodSpec], Awaitable[BackendHandle]], upgrade)


def _newer_hub_result(admission: UpgradeAdmission, row: dict[str, Any]) -> dict[str, Any]:
    image = running_image(row)
    logger.info(
        "personal_agent.upgrade_skipped hushh_id=%s reason=set_by_newer_hub",
        admission.hushh_id,
    )
    return {
        "hushhId": admission.hushh_id,
        "status": "provisioned",
        "upgraded": False,
        "skipped": "set_by_newer_hub",
        "image": image,
        "previousImage": image,
    }


async def _resume_files_queue(
    owner: _Owner, admission: UpgradeAdmission
) -> tuple[dict[str, Any], PodSpec, _FilesExecutor | None]:
    from hushh_mcp.services.personal_agent_provisioning_service import (
        PersonalAgentUpgradeUnsupportedError,
    )

    row, spec, backend = admission.row, admission.spec, admission.backend
    executor: _FilesExecutor | None = None
    held = admission.held_lease
    operation = admission.resume_files_queue_operation
    if (
        held is None
        or set_by_newer_hub(row)
        or admission.current_image != spec.upgrade_target_image
    ):
        raise ValueError("Files continuation requires its current held operation")
    if row.get("deployment_target") == "gcp":
        from hushh_mcp.services.pod_files.capability_contract import hosted_schema_ready

        if not await hosted_schema_ready(owner._registry):
            raise PersonalAgentUpgradeUnsupportedError("Managed Files recovery schema is not ready")
    from hushh_mcp.services.pod_files.queue_recovery import claim_queue_retry

    managed_files = (
        row.get("deployment_target") == "gcp"
        and (row.get("backend_metadata") or {}).get("tenancy") == "hussh-hosted"
    )

    async def claim_hosted_retry(observed: dict, retry_checkpoint: dict) -> dict:
        nonlocal executor
        resume = getattr(owner._registry, "resume_hosted_files_executor", None)
        if not callable(resume):
            raise PersonalAgentUpgradeUnsupportedError(
                "managed Files retry authority is unavailable"
            )
        if admission.files_capability is None:
            raise PersonalAgentUpgradeUnsupportedError("managed Files retry plan is unavailable")
        deployed_image = _hosted_files_deployed_image(backend, spec, admission.current_image)
        executor, updated_row = await resume(
            user_id=admission.user_id,
            observed=observed,
            lease=held,
            retry_checkpoint=retry_checkpoint,
            plan=admission.files_capability.model_dump(),
            incarnation=spec.expected_service_uid or "",
            deployed_image=deployed_image,
        )
        return updated_row

    try:
        row, prefix = await claim_queue_retry(
            registry=owner._registry,
            row=row,
            spec=spec,
            backend=backend,
            operation=operation,
            hosted_claim=claim_hosted_retry if managed_files else None,
        )
    except BaseException:
        if executor is not None and not executor.closed:
            await executor.close()
        raise
    spec = replace(spec, files_upgrade_completed_steps=prefix)
    if executor is not None:
        spec = replace(spec, hosted_files_executor=executor)
    return row, spec, executor


async def _claim_upgrade_lease(
    owner: _Owner,
    admission: UpgradeAdmission,
    *,
    row: dict[str, Any],
    spec: PodSpec,
    files_executor: _FilesExecutor | None,
) -> tuple[str | None, _FilesExecutor | None, dict[str, Any] | None]:
    from hushh_mcp.services.personal_agent_provisioning_service import (
        PersonalAgentUpgradeUnsupportedError,
    )
    from hushh_mcp.services.personal_agent_registry_repo import upgrade_host_snapshot

    registry = owner._registry
    requested_binding = upgrade_host_snapshot(row)
    claim = getattr(registry, "claim_image_upgrade", None)
    if not callable(claim):
        raise PersonalAgentUpgradeUnsupportedError("registry cannot fence image upgrades")
    hosted_files = (
        admission.files_capability is not None
        and row.get("deployment_target") == "gcp"
        and admission.metadata.get("tenancy") == "hussh-hosted"
    )
    if (
        hosted_files
        and admission.held_lease is None
        and admission.resume_files_queue_operation is None
    ):
        begin = getattr(registry, "begin_hosted_files_executor", None)
        if not callable(begin):
            raise PersonalAgentUpgradeUnsupportedError(
                "managed Files executor authority is unavailable"
            )
        plan = admission.files_capability
        if plan is None:
            raise PersonalAgentUpgradeUnsupportedError("managed Files executor plan is unavailable")
        deployed_image = _hosted_files_deployed_image(
            admission.backend, spec, admission.current_image
        )
        files_executor = await begin(
            user_id=admission.user_id,
            observed=row,
            target_image=admission.current_image,
            operation_id=spec.upgrade_operation_id or "",
            plan=plan.model_dump(),
            incarnation=spec.expected_service_uid or "",
            deployed_image=deployed_image,
        )
        lease = files_executor.lease
        spec = replace(spec, hosted_files_executor=files_executor)
    elif hosted_files and files_executor is not None:
        lease = files_executor.lease
        spec = replace(spec, hosted_files_executor=files_executor)
    elif hosted_files:
        raise PersonalAgentUpgradeUnsupportedError(
            "managed Files executor authority is unavailable for this recovery"
        )
    else:
        lease = (
            admission.held_lease
            if admission.resume_files_queue_operation is not None
            else await claim(
                user_id=admission.user_id,
                target_image=admission.current_image,
                observed=row,
            )
        )
    if not isinstance(lease, str) or not lease:
        return None, files_executor, None
    return lease, files_executor, requested_binding


async def claim_upgrade(owner: _Owner, admission: UpgradeAdmission) -> UpgradeClaimOutcome:
    row, spec, backend = admission.row, admission.spec, admission.backend
    executor: _FilesExecutor | None = None
    if admission.resume_files_queue_operation is not None:
        row, spec, executor = await _resume_files_queue(owner, admission)
    elif admission.held_lease is not None:
        result = await owner._reconcile_image_upgrade(
            user_id=admission.user_id,
            row=row,
            spec=spec,
            backend=backend,
            lease=admission.held_lease,
        )
        return UpgradeClaimOutcome(claim=None, result=result)
    upgrade = _require_live_upgrader(admission)
    if set_by_newer_hub(row):
        return UpgradeClaimOutcome(claim=None, result=_newer_hub_result(admission, row))
    lease, executor, requested_binding = await _claim_upgrade_lease(
        owner, admission, row=row, spec=spec, files_executor=executor
    )
    if lease is None:
        return UpgradeClaimOutcome(claim=None, result=_in_progress(admission, row))
    return UpgradeClaimOutcome(
        claim=UpgradeClaim(
            row=row,
            spec=spec,
            backend=backend,
            upgrade=upgrade,
            files_executor=executor,
            lease=lease,
            requested_binding=requested_binding,
        ),
        result=None,
    )
