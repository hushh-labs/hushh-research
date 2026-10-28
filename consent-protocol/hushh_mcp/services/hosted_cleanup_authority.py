"""Use the retained pilot assignment for cleanup, without borrowing BYOC ownership."""

from __future__ import annotations

import asyncio
import threading
from dataclasses import replace
from typing import Any

from hushh_mcp.services.compute_backend import PodSpec
from hushh_mcp.services.hosted_gcp_admission import _worker_guard
from hushh_mcp.services.hosted_gcp_authority import HostedGcpAuthority
from hushh_mcp.services.private_gcp_deployment import PrivateGcpDeployment
from hushh_mcp.services.provision_attempt import ProvisionReconciliationRequired


def cleanup_deployment(snapshot: dict) -> tuple[PrivateGcpDeployment, str, str]:
    attempt = snapshot["backend_metadata"]["provisionAttempt"]
    admission = attempt["hostedAdmission"]
    assignment = admission["assignment"]
    model = admission["modelBinding"]
    federation = assignment["bootstrapContract"]["plan"]["federation"]["impersonation"]
    observation = attempt["evidence"]["reserved"]["projectObservation"]
    project, region = assignment["project"], assignment["region"]
    if (
        attempt["ownerId"] != snapshot["user_id"]
        or assignment["hushhId"] != snapshot["hushh_id"]
        or observation["projectId"] != project
        or observation["lifecycleState"] != "ACTIVE"
    ):
        raise ProvisionReconciliationRequired("Managed cleanup placement changed")
    deployment = PrivateGcpDeployment(
        owner=snapshot["hushh_id"],
        hosting_mode="hussh_hosted",
        environment="dev",
        project=project,
        project_number=observation["projectNumber"],
        region=region,
        image=f"{region}-docker.pkg.dev/{project}/one-pod/consent-protocol-pod@{admission['imageDigest']}",
        hub_principal=federation["granted_to"],
        service_uid=snapshot["backend_metadata"].get("serviceUid"),
        inference_project=model["project"],
        inference_model=model["model"],
        inference_profile_hash=model["profileHash"],
    )
    deployment.validate(frozen=True)
    return (
        deployment,
        federation["bootstrap_service_account"],
        "gcr.io/hushh-pda-dev/consent-protocol-pod@" + admission["imageDigest"],
    )


def bind_managed_cleanup(spec: PodSpec, snapshot: dict, *, registry: Any) -> PodSpec:
    deployment, bootstrap, source = cleanup_deployment(snapshot)
    owner = snapshot["user_id"]
    attempt_id: str | None = None

    async def current() -> None:
        nonlocal attempt_id
        row = await registry.get(owner)
        reservation = ((row or {}).get("backend_metadata") or {}).get("erasure") or {}
        if (
            row is None
            or row.get("status") != "suspended"
            or reservation.get("ownerId") != owner
            or reservation.get("registrySnapshot") != snapshot
            or not reservation.get("attemptId")
            or (attempt_id is not None and attempt_id != reservation["attemptId"])
            or not await registry.hosted_cleanup_current(owner_id=owner, reservation=reservation)
        ):
            raise ProvisionReconciliationRequired("Managed cleanup authority changed")
        attempt_id = reservation["attemptId"]

    authority = HostedGcpAuthority(
        deployment,
        source,
        bootstrap,
        _worker_guard(current, asyncio.get_running_loop(), threading.get_ident()),
        operation="cleanup",
        execute=True,
    )
    authority.validate_execution()
    return replace(spec, private_gcp_deployment=deployment, hosted_admission_guard=authority)


def frozen_cleanup_coordinates(snapshot: dict) -> tuple[str, str]:
    deployment, bootstrap, _ = cleanup_deployment(snapshot)
    return deployment.project, bootstrap
