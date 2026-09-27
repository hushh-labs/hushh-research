"""Read-only capability offer for an existing owner pod's update workflow."""

from __future__ import annotations

import asyncio
import os

from hushh_mcp.services.compute_backend import PodSpec, resolve_compute_backend_for_spec
from hushh_mcp.services.personal_agent_registry_repo import upgrade_host_snapshot
from hushh_mcp.services.pod_files.capability_update import plan_from_observation
from hushh_mcp.services.pod_update_identity import release_identity


class FilesStoragePrerequisite(ValueError):
    """The existing bucket cannot safely host a Files library yet."""

    public_message = (
        "Your cloud bucket needs verified owner access, encryption and enforced "
        "public-access prevention before Files setup. No setup has started."
    )


async def verify_storage_prerequisite(plan) -> None:
    from hushh_mcp.services.pod_files.capability_bootstrap import FilesCapabilityBootstrap
    from hushh_mcp.services.user_gcp_bootstrap import BootstrapError, mint_bootstrap_token

    try:
        token = await asyncio.to_thread(mint_bootstrap_token, bootstrap_sa=plan.bootstrapAccount)
        bootstrap = FilesCapabilityBootstrap(capability=plan, token=token)
        await asyncio.to_thread(bootstrap.verify_existing_bucket)
    except BootstrapError:
        raise FilesStoragePrerequisite(FilesStoragePrerequisite.public_message) from None


async def inspect_files_offer(repo, row: dict, target_image: str):
    if os.getenv("HUSSH_POD_FILES_ENABLED", "").lower() not in {"1", "true"}:
        raise ValueError("Files activation is not enabled")
    metadata = row.get("backend_metadata") or {}
    readiness = getattr(repo, "files_upgrade_admission_ready", None)
    if readiness is None or not await readiness():
        raise ValueError("Files upgrade recovery schema is not ready")
    if (
        row.get("deployment_target") != "user_gcp"
        or row.get("status") != "provisioned"
        or not row.get("user_cloud_authorized_at")
        or metadata.get("upgradeLease") is not None
        or "erasure" in metadata
    ):
        raise ValueError("Files requires an available owner-authorized BYOC pod")
    spec = PodSpec(
        hushh_id=row["hushh_id"],
        phone_e164_hash=row["phone_e164_hash"],
        pod_pubkey=row.get("pod_pubkey") or "",
        deployment_target="user_gcp",
        expected_service_uid=metadata.get("serviceUid"),
        user_cloud_project=row.get("user_cloud_project"),
        user_cloud_region=row.get("user_cloud_region"),
        user_cloud_bootstrap_sa=row.get("user_cloud_bootstrap_sa"),
    )
    backend = resolve_compute_backend_for_spec(spec)
    inspect = getattr(backend, "inspect_files_capability", None)
    if inspect is None or not getattr(backend, "live", False):
        raise ValueError("Files capability inspection is unavailable")
    observation = await inspect(spec)
    # Only the existing approved dev bridge may be offered outside the owner
    # project. The exact choice is disclosed and included in the approval hash.
    bridge = None
    if os.getenv("HUSHH_DEPLOY_ENV") == "dev":
        from hushh_mcp.runtime_providers import ManagedGeminiRuntimeBinding

        bridge = ManagedGeminiRuntimeBinding.from_environment().project
    plan = plan_from_observation(row, target_image, observation, dev_model_project=bridge)
    await verify_storage_prerequisite(plan)
    current = await repo.get(row["user_id"])

    def authority_snapshot(value):
        snapshot = upgrade_host_snapshot(value)
        if snapshot is None:
            return None
        return {
            key: item
            for key, item in snapshot.items()
            if key not in {"updated_at", "backend_metadata"}
        }

    if authority_snapshot(current) != authority_snapshot(row) or (
        ((current or {}).get("backend_metadata") or {}).get("upgradeLease") is not None
        or "erasure" in ((current or {}).get("backend_metadata") or {})
    ):
        raise ValueError("Pod assignment changed while preparing Files activation")
    return plan


def public_files_offer(plan) -> dict:
    return {
        "releaseId": release_identity(
            plan.hushhId, plan.serviceUid, plan.targetImage, capability_digest=plan.digest
        ),
        "capabilityPlanDigest": plan.digest,
        "summary": "Enable your encrypted Files library in your existing cloud bucket.",
        "changes": [
            "Add a bounded background queue and a separate worker identity in your project.",
            "Allow your existing setup account to manage Cloud Tasks queues in your project.",
            "Keep your compute size, recovery information, encryption key and network settings.",
            "Content analysis stays off until you enable it in Files.",
        ],
        "modelProcessing": (
            "Dev analysis uses your explicitly configured Vertex AI bridge."
            if plan.devModelProject
            else "Analysis uses Vertex AI in your cloud project."
        ),
    }
