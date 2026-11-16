"""Recover an incorrectly reinitialized managed placement without replacing its host."""

from __future__ import annotations

import asyncio
import json
import os
import threading
from copy import deepcopy
from dataclasses import replace

from sqlalchemy import text

from hushh_mcp.services.hosted_gcp_placement import retained_hosted_placement
from hushh_mcp.services.pod_adoption import PodAdoptionRefused


def recovery_placement(row: dict, owner: str):
    """A projected status validates retained bindings; it never becomes a write snapshot."""
    metadata = row.get("backend_metadata") or {}
    approval = metadata.get("upgradeApproval")
    if (
        os.environ.get("HUSHH_DEPLOY_ENV") != "dev"
        or row.get("user_id") != owner
        or row.get("status") != "needs_reinit"
        or row.get("operation_lease") is not None
        or any(key in metadata for key in ("erasure", "upgradeLease", "providerAccountTransition"))
        or (
            approval is not None
            and (
                not isinstance(approval, dict)
                or approval.get("status") not in {"succeeded", "failed"}
            )
        )
        or (metadata.get("provisionAttempt") or {}).get("phase") != "provisioned"
        or not all(
            row.get(key)
            for key in (
                "pod_pubkey",
                "pod_key_id",
                "pod_key_wrapping_alg",
                "pod_signing_pubkey",
                "pod_signing_key_id",
                "phone_e164_hash",
            )
        )
        or not metadata.get("image")
    ):
        raise PodAdoptionRefused("MANAGED_ADOPTION_REQUIRES_RETAINED_IDLE_HOST")
    projected = deepcopy(row)
    projected["status"] = "provisioned"
    placement = retained_hosted_placement(projected)
    if placement is None:
        raise PodAdoptionRefused("MANAGED_ADOPTION_BINDING_UNVERIFIED")
    return projected, placement


async def adopt_retained_host(service, *, row: dict, owner: str) -> dict:
    from hushh_mcp.services.compute_backend import BackendHandle, PodSpec, adoption_expectations
    from hushh_mcp.services.hosted_cleanup_authority import cleanup_deployment
    from hushh_mcp.services.hosted_gcp_admission import _worker_guard
    from hushh_mcp.services.hosted_gcp_authority import HostedGcpAuthority
    from hushh_mcp.services.pod_key_collector import fetch_pod_public_key
    from hushh_mcp.services.pod_lifecycle_log import append

    projected, placement = recovery_placement(row, owner)
    deployment, bootstrap, _ = cleanup_deployment(projected)
    deployment = replace(deployment, image=row["backend_metadata"]["image"])

    async def current() -> None:
        actual = await service._registry.get(owner)
        if actual != row:
            raise PodAdoptionRefused("MANAGED_ADOPTION_ASSIGNMENT_CHANGED")
        recovery_placement(actual, owner)

    authority = HostedGcpAuthority(
        deployment,
        "gcr.io/hushh-pda-dev/consent-protocol-pod@" + deployment.image.rsplit("@", 1)[-1],
        bootstrap,
        _worker_guard(current, asyncio.get_running_loop(), threading.get_ident()),
        operation="inspect",
        execute=True,
        installed_image=deployment.image,
    )
    authority.validate_execution()
    spec = PodSpec(
        hushh_id=placement.hushh_id,
        phone_e164_hash=row["phone_e164_hash"],
        billing_space_id=row.get("billing_space_id"),
        pod_pubkey=row["pod_pubkey"],
        deployment_target="gcp",
        private_gcp_deployment=deployment,
        hosted_admission_guard=authority,
        **adoption_expectations(row["backend_metadata"]),
    )
    backend = service._backend_for(spec)
    client = await asyncio.to_thread(backend._client)

    def observe():
        import requests

        response = requests.get(
            "https://cloudresourcemanager.googleapis.com/v1/projects/" + placement.project,
            headers=client._headers(),
            timeout=20,
            allow_redirects=False,
        )
        if response.status_code != 200:
            raise PodAdoptionRefused("MANAGED_ADOPTION_PROJECT_UNVERIFIED")
        project = response.json()
        if (
            project.get("projectId"),
            project.get("projectNumber"),
            project.get("lifecycleState"),
        ) != (placement.project, placement.project_number, "ACTIVE"):
            raise PodAdoptionRefused("MANAGED_ADOPTION_PROJECT_CHANGED")
        native = client.get_service(placement.service)
        try:
            deployment.verify_observation(native, frozen=True)
            observed = client.observe_erasure_runtime(
                name=placement.service, expected_uid=placement.service_uid, include_identity=True
            )
        except (ValueError, RuntimeError):
            raise PodAdoptionRefused("MANAGED_ADOPTION_RUNTIME_UNVERIFIED") from None
        if observed["podUrl"] != row["backend_metadata"]["url"].rstrip("/"):
            raise PodAdoptionRefused("MANAGED_ADOPTION_ENDPOINT_CHANGED")
        return observed

    before = await asyncio.to_thread(observe)
    handle = BackendHandle(
        external_agent_id=placement.service,
        a2a_route=row.get("a2a_route"),
        backend=row["backend"],
        status="provisioned",
        backend_metadata=row["backend_metadata"],
    )
    await backend.verify_adoption(spec, handle)
    keys = await fetch_pod_public_key(row, require_identity=True)
    expected = {
        "podPublicKey": row["pod_pubkey"],
        "podKeyId": row["pod_key_id"],
        "podKeyWrappingAlg": row["pod_key_wrapping_alg"],
        "podSigningKey": row["pod_signing_pubkey"],
        "podSigningKeyId": row["pod_signing_key_id"],
    }
    if keys != expected:
        raise PodAdoptionRefused("MANAGED_ADOPTION_KEYS_CHANGED")
    if await asyncio.to_thread(observe) != before:
        raise PodAdoptionRefused("MANAGED_ADOPTION_RUNTIME_CHANGED")
    await current()
    if not await service._registry.restore_confirmed_managed_host(owner=owner, observed=row):
        raise PodAdoptionRefused("MANAGED_ADOPTION_ASSIGNMENT_CHANGED")
    await append(
        owner,
        stage="authority_live",
        registry_status="provisioned",
        event="retained_managed_host_restored",
        hushh_id=placement.hushh_id,
        reason="native incarnation and retained public keys matched; no host or key replacement",
    )
    return {
        "hushhId": placement.hushh_id,
        "status": "provisioned",
        "adopted": True,
        "recovered": True,
    }


def restore_retained_host(db, *, owner: str, observed: dict) -> bool:
    """Existing deletion barriers and an exact locked row fence the status-only CAS."""
    from hushh_mcp.services.account_deletion_lifecycle_service import (
        AccountDeletionLifecycleService,
        account_deletion_user_hash,
    )
    from hushh_mcp.services.account_generation_service import AccountGenerationService

    recovery_placement(observed, owner)
    with db.engine.begin() as conn:
        conn.execute(text("SET LOCAL statement_timeout='5000ms'"))
        AccountDeletionLifecycleService.lock_user_writes_in_transaction(conn, user_ids=[owner])
        AccountGenerationService.identity_in_transaction(conn, owner)
        if conn.execute(
            text("""SELECT EXISTS(SELECT 1 FROM account_deletion_tombstones WHERE user_id_hash=:hash)
                OR EXISTS(SELECT 1 FROM personal_agent_deletion_tombstones WHERE hushh_id=:hushh)
                OR EXISTS(SELECT 1 FROM personal_agent_cloud_removals
                    WHERE user_id=:owner AND completed_at IS NULL)"""),
            {
                "hash": account_deletion_user_hash(owner),
                "owner": owner,
                "hushh": observed["hushh_id"],
            },
        ).scalar_one():
            return False
        params = {"owner": owner, "snapshot": json.dumps(observed, default=str)}
        matched = conn.execute(
            text("""
            SELECT to_jsonb(r) = to_jsonb(jsonb_populate_record(
                NULL::personal_agent_registry, CAST(:snapshot AS jsonb)))
            FROM personal_agent_registry r WHERE user_id=:owner FOR UPDATE
        """),
            params,
        ).scalar_one_or_none()
        if matched is not True:
            return False
        conn.execute(
            text("""UPDATE personal_agent_registry
            SET status='provisioned', updated_at=clock_timestamp() WHERE user_id=:owner"""),
            {"owner": owner},
        )
    return True
