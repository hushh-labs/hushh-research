"""Read-only capability offer for an existing owner pod's update workflow."""

from __future__ import annotations

import asyncio
import json
import os
import threading
from copy import deepcopy
from dataclasses import replace

from hushh_mcp.services.compute_backend import PodSpec, resolve_compute_backend_for_spec
from hushh_mcp.services.personal_agent_registry_repo import upgrade_host_snapshot
from hushh_mcp.services.pod_files.capability_update import (
    _literal_environment,
    plan_from_observation,
)
from hushh_mcp.services.pod_update_identity import release_identity
from hushh_mcp.services.user_cloud_service import spec_coordinates_from_row


class FilesStoragePrerequisite(ValueError):
    """The existing bucket cannot safely host a Files library yet."""

    public_message = (
        "Your cloud bucket needs verified owner access, encryption and enforced "
        "public-access prevention before Files setup. No setup has started."
    )


def _authority_snapshot(value):
    snapshot = upgrade_host_snapshot(value)
    if snapshot is None:
        return None
    return {
        key: item for key, item in snapshot.items() if key not in {"updated_at", "backend_metadata"}
    }


async def verify_storage_prerequisite(plan) -> None:
    from hushh_mcp.services.pod_files.capability_bootstrap import FilesCapabilityBootstrap
    from hushh_mcp.services.user_gcp_bootstrap import BootstrapError, mint_bootstrap_token

    try:
        token = await asyncio.to_thread(mint_bootstrap_token, bootstrap_sa=plan.bootstrapAccount)
        bootstrap = FilesCapabilityBootstrap(capability=plan, token=token)
        await asyncio.to_thread(bootstrap.verify_existing_bucket)
    except BootstrapError:
        raise FilesStoragePrerequisite(FilesStoragePrerequisite.public_message) from None


def _approved_dev_model_project(observation: dict) -> str | None:
    """Recognize existing deployment authority without changing the pod's AI."""
    if os.getenv("HUSHH_DEPLOY_ENV") != "dev":
        return None
    from hushh_mcp.runtime_providers import ManagedGeminiRuntimeBinding
    from hushh_mcp.services.pod_inference_bridge import BRIDGE_ENV, render_inference_bridge

    spec = observation["spec"]["template"]["spec"]
    env = _literal_environment(observation)
    rendered = render_inference_bridge(service_account=spec["serviceAccountName"])
    approved = json.loads(rendered[0]["value"]) if rendered else None
    for entry in spec["containers"][0].get("env", []):
        if entry["name"] == BRIDGE_ENV and (
            approved is None or json.loads(entry.get("value", "null")) != approved
        ):
            raise ValueError("Files installed inference policy needs reconciliation")
    observed_project = env.get("GENAI_GOOGLE_CLOUD_PROJECT") or env.get("GOOGLE_CLOUD_PROJECT")
    if approved is not None and observed_project == approved["project"]:
        project = approved["project"]
        if not isinstance(project, str):
            raise ValueError("Files inference policy project is invalid")
        return project
    return ManagedGeminiRuntimeBinding.from_environment().project


async def inspect_files_offer(repo, row: dict, target_image: str):
    if os.getenv("HUSSH_POD_FILES_ENABLED", "").lower() not in {"1", "true"}:
        raise ValueError("Files activation is not enabled")
    metadata = row.get("backend_metadata") or {}
    provider = row.get("deployment_target")
    from hushh_mcp.services.hosted_gcp_placement import retained_hosted_placement

    from .capability_contract import hosted_schema_ready, schema_ready

    placement = retained_hosted_placement(row) if provider == "gcp" else None
    hosted = placement is not None
    ready = (
        await hosted_schema_ready(repo)
        if hosted
        else await schema_ready(repo, 2 if provider == "user_azure" else 1)
    )
    if not ready:
        raise ValueError("Files upgrade recovery schema is not ready")
    if (
        (provider not in {"user_gcp", "user_azure"} and not hosted)
        or row.get("status") != "provisioned"
        or (not hosted and not row.get("user_cloud_authorized_at"))
        or metadata.get("upgradeLease") is not None
        or "erasure" in metadata
    ):
        raise ValueError("Files requires an available owner-authorized BYOC pod")
    from hushh_mcp.services.compute_backend import adoption_expectations

    spec = PodSpec(
        hushh_id=row["hushh_id"],
        phone_e164_hash=row["phone_e164_hash"],
        pod_pubkey=row.get("pod_pubkey") or "",
        deployment_target=provider,
        **adoption_expectations(metadata),
        **spec_coordinates_from_row(row),
    )
    hosted_snapshot = None
    if hosted:
        from hushh_mcp.services.hosted_gcp_placement import direct_admission_snapshot

        hosted_snapshot = deepcopy(direct_admission_snapshot(row))
        spec = await _bind_hosted_inspection(repo, row, spec, hosted_snapshot)
    backend = resolve_compute_backend_for_spec(spec)
    inspect = getattr(backend, "inspect_files_capability", None)
    if inspect is None:
        raise ValueError("Files capability inspection is unavailable")
    observation = await inspect(spec)
    if provider == "user_azure":
        from .azure_capability import plan_from_observation as azure_plan

        # The standing observer can read the app, not its private storage. Full
        # custody preflight uses fresh owner authorization before any mutation.
        plan = azure_plan(row, target_image, observation)
    else:
        # Freeze the already selected, explicitly approved project; storage and
        # workload custody stay in the owner's project.
        bridge = None if hosted else _approved_dev_model_project(observation)
        plan = plan_from_observation(row, target_image, observation, dev_model_project=bridge)
        await verify_storage_prerequisite(plan)
    current = await repo.get(row["user_id"])

    if _authority_snapshot(current) != _authority_snapshot(row) or (
        ((current or {}).get("backend_metadata") or {}).get("upgradeLease") is not None
        or "erasure" in ((current or {}).get("backend_metadata") or {})
    ):
        raise ValueError("Pod assignment changed while preparing Files activation")
    if hosted and (
        direct_admission_snapshot(current) != hosted_snapshot
        or not await repo.hosted_retained_current(owner_id=row["user_id"], observed=current)
    ):
        raise ValueError("Hosted assignment changed while preparing Files activation")
    return plan


async def _bind_hosted_inspection(repo, row: dict, spec: PodSpec, snapshot: dict) -> PodSpec:
    from hushh_mcp.services.hosted_cleanup_authority import cleanup_deployment
    from hushh_mcp.services.hosted_gcp_admission import _worker_guard
    from hushh_mcp.services.hosted_gcp_authority import HostedGcpAuthority
    from hushh_mcp.services.hosted_gcp_placement import direct_admission_snapshot

    deployment, bootstrap, _ = cleanup_deployment(row)
    installed = (row.get("backend_metadata") or {}).get("image")
    if not isinstance(installed, str) or "@sha256:" not in installed:
        raise ValueError("Hosted Files inspection needs the recorded installed image")
    deployment = replace(deployment, image=installed)
    source = "gcr.io/hushh-pda-dev/consent-protocol-pod@" + installed.rsplit("@", 1)[-1]

    async def current() -> None:
        observed = await repo.get(row["user_id"])
        metadata = (observed or {}).get("backend_metadata") or {}
        if (
            direct_admission_snapshot(observed) != snapshot
            or metadata.get("upgradeLease") is not None
            or "erasure" in metadata
            or not await repo.hosted_retained_current(owner_id=row["user_id"], observed=observed)
        ):
            raise ValueError("Hosted Files inspection authority changed")

    await current()
    authority = HostedGcpAuthority(
        deployment,
        source,
        bootstrap,
        _worker_guard(current, asyncio.get_running_loop(), threading.get_ident()),
        operation="inspect",
        execute=True,
        installed_image=installed,
    )
    authority.validate_execution()
    return replace(spec, private_gcp_deployment=deployment, hosted_admission_guard=authority)


def public_files_offer(plan, *, hosted: bool = False) -> dict:
    if plan.version == 2:
        return {
            "releaseId": release_identity(
                plan.hushhId, plan.serviceUid, plan.targetImage, capability_digest=plan.digest
            ),
            "capabilityPlanDigest": plan.digest,
            "summary": "Enable your encrypted Files library in your existing cloud storage.",
            "changes": [
                "Add a bounded queue and allow only your existing private agent to process its jobs.",
                "Verify storage and permissions after your Microsoft sign-in, before setup starts.",
                "Keep your compute size, recovery information, encryption key and network settings.",
                "Content analysis stays off until you enable it in Files.",
            ],
            "modelProcessing": "Analysis uses the existing Azure model in your subscription.",
        }
    if hosted:
        return {
            "releaseId": release_identity(
                plan.hushhId, plan.serviceUid, plan.targetImage, capability_digest=plan.digest
            ),
            "capabilityPlanDigest": plan.digest,
            "summary": "Enable your encrypted Files library in your managed pod storage.",
            "changes": [
                "Add a bounded queue and worker identity to your managed pod.",
                "Keep your recovery information, encryption key and network settings.",
                "Content analysis remains unavailable until separately qualified and enabled.",
            ],
            "modelProcessing": "Files analysis is not available in this pilot.",
        }
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
