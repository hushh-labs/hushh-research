"""Bind the existing owner-approved update lease to its retained managed placement."""

from __future__ import annotations

import asyncio
import threading
from dataclasses import replace
from typing import Any

from hushh_mcp.services.compute_backend import PodSpec
from hushh_mcp.services.hosted_gcp_admission import _worker_guard
from hushh_mcp.services.hosted_gcp_authority import HostedGcpAuthority
from hushh_mcp.services.hosted_gcp_placement import retained_hosted_placement
from hushh_mcp.services.private_gcp_deployment import PrivateGcpDeployment
from hushh_mcp.services.provision_attempt import ProvisionReconciliationRequired


async def bind_managed_upgrade(
    spec: PodSpec, row: dict, *, registry: Any, lease: str | None
) -> PodSpec:
    from hushh_mcp.services.personal_agent_provisioning_service import upgrade_approval_matches

    placement = retained_hosted_placement(row)
    source = spec.upgrade_target_image
    inspecting = bool(lease and not upgrade_approval_matches(row, source or ""))
    if (
        placement is None
        or not source
        or not upgrade_approval_matches(row, source, allow_unresolved=inspecting)
    ):
        raise ProvisionReconciliationRequired(
            "Managed update needs its retained owner approval and placement"
        )
    metadata = row["backend_metadata"]
    attempt = metadata["provisionAttempt"]
    model = attempt["hostedAdmission"]["modelBinding"]
    deployment = PrivateGcpDeployment(
        owner=placement.hushh_id,
        hosting_mode="hussh_hosted",
        environment="dev",
        project=placement.project,
        project_number=placement.project_number,
        region=placement.region,
        service_uid=placement.service_uid,
        image=f"{placement.region}-docker.pkg.dev/{placement.project}/one-pod/consent-protocol-pod@{source.rsplit('@', 1)[-1]}",
        hub_principal=attempt["hostedAdmission"]["assignment"]["bootstrapContract"]["plan"][
            "federation"
        ]["impersonation"]["granted_to"],
        inference_project=model["project"],
        inference_model=model["model"],
        inference_profile_hash=model["profileHash"],
    )
    approval = metadata["upgradeApproval"]

    async def current() -> None:
        observed = await registry.get(placement.owner_id)
        if (
            not lease
            or observed is None
            or observed.get("status") != "provisioned"
            or (observed.get("backend_metadata") or {}).get("upgradeLease") != lease
            or (observed.get("backend_metadata") or {})
            .get("upgradeApproval", {})
            .get("operationId")
            != approval["operationId"]
            or retained_hosted_placement(observed) != placement
            or not upgrade_approval_matches(observed, source, allow_unresolved=inspecting)
            or not await registry.hosted_upgrade_current(
                owner_id=placement.owner_id, lease=lease, observed=observed, work=not inspecting
            )
        ):
            raise ProvisionReconciliationRequired("Managed update authority changed")

    authority = HostedGcpAuthority(
        deployment,
        source,
        placement.bootstrap_sa,
        _worker_guard(current, asyncio.get_running_loop(), threading.get_ident()),
        operation="inspect" if inspecting else "upgrade",
        execute=True,
        installed_image=metadata.get("image"),
        operation_id=approval["operationId"],
    )
    authority.validate_execution()
    return replace(spec, private_gcp_deployment=deployment, hosted_admission_guard=authority)
