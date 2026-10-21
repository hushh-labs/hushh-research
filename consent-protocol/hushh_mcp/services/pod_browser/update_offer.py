"""Read-only Browser offer; exact owner approval remains the update authority."""

from __future__ import annotations

import asyncio
import os

from hushh_mcp.services.compute_backend import (
    PodSpec,
    adoption_expectations,
    resolve_compute_backend_for_spec,
)
from hushh_mcp.services.personal_agent_registry_repo import upgrade_host_snapshot
from hushh_mcp.services.pod_release import image_digest, upgrade_is_supported
from hushh_mcp.services.pod_update_identity import release_identity
from hushh_mcp.services.user_cloud_service import spec_coordinates_from_row

from .capability_update import GcpBrowserCapabilityPlan, plan_from_observation


def browser_review_available(row: dict | None, target: str, release: dict | None) -> bool:
    """Advertise review only; the plan still checks schema and live configuration."""
    if row is None or release is None:
        return False
    metadata = row.get("backend_metadata") or {}
    installed = (
        metadata.get("image_digest") or metadata.get("image") or metadata.get("source_image")
    )
    return bool(
        os.getenv("HUSSH_POD_BROWSER_ENABLED", "").lower() in {"1", "true"}
        and row.get("deployment_target") in {"user_gcp", "user_azure"}
        and not (
            row.get("deployment_target") == "user_azure"
            and ("hostKind" in metadata or "vmHost" in metadata)
        )
        and row.get("status") == "provisioned"
        and row.get("user_cloud_authorized_at")
        and row.get("pod_key_id")
        and metadata.get("upgradeLease") is None
        and "erasure" not in metadata
        and (metadata.get("upgradeApproval") or {}).get("status")
        not in {"approved", "scheduled", "updating", "blocked"}
        and (
            upgrade_is_supported(release, installed)
            or image_digest(installed) == image_digest(target)
        )
        and not (
            (metadata.get("browserCapability") or {}).get("status") == "configured"
            and image_digest(installed) == image_digest(target)
        )
        and any(
            item.get("host_kind")
            == (
                "azure_container_apps"
                if row.get("deployment_target") == "user_azure"
                else "gcp_cloud_run"
            )
            and "public_policy" in item
            for item in release.get("browserQualifications", [])
        )
    )


async def require_browser_schema(repo, provider: str | None = None) -> None:
    function = (
        "azure_browser_update_admission_ready"
        if provider == "user_azure"
        else "browser_update_admission_ready"
    )
    try:
        result = await asyncio.to_thread(
            repo._db().execute_raw, f"SELECT public.{function}() AS ready", {}
        )
        if result.data and result.data[0].get("ready") is True:
            return
    except Exception:
        pass
    raise ValueError("Browser update admission is not installed")


def _snapshot(row):
    snapshot = upgrade_host_snapshot(row)
    if snapshot is None:
        return None
    return {
        key: value
        for key, value in snapshot.items()
        if key not in {"updated_at", "backend_metadata"}
    }


async def inspect_browser_offer(repo, row: dict, target_image: str, release: dict):
    if os.getenv("HUSSH_POD_BROWSER_ENABLED", "").lower() not in {"1", "true"}:
        raise ValueError("Browser setup is not offered yet")
    metadata = row.get("backend_metadata") or {}
    if (
        row.get("deployment_target") not in {"user_gcp", "user_azure"}
        or (
            row.get("deployment_target") == "user_azure"
            and ("hostKind" in metadata or "vmHost" in metadata)
        )
        or row.get("status") != "provisioned"
        or not row.get("user_cloud_authorized_at")
        or metadata.get("upgradeLease") is not None
        or "erasure" in metadata
    ):
        raise ValueError("Browser needs your available, authorized private cloud")
    provider = row["deployment_target"]
    await require_browser_schema(repo, provider)
    host_kind = "azure_container_apps" if provider == "user_azure" else "gcp_cloud_run"
    qualification = next(
        (
            item
            for item in release.get("browserQualifications", [])
            if item["host_kind"] == host_kind and "public_policy" in item
        ),
        None,
    )
    if qualification is None:
        raise ValueError("This image has no qualified Browser policy offer")
    spec = PodSpec(
        hushh_id=row["hushh_id"],
        phone_e164_hash=row["phone_e164_hash"],
        pod_pubkey=row["pod_pubkey"],
        deployment_target=provider,
        **adoption_expectations(metadata),
        **spec_coordinates_from_row(row),
    )
    backend = resolve_compute_backend_for_spec(spec)
    inspect = getattr(backend, "inspect_pod_configuration", None)
    if inspect is None:
        raise ValueError("Browser configuration inspection is unavailable")
    observation = await inspect(spec)
    factory = plan_from_observation
    if provider == "user_azure":
        from .azure_capability import plan_from_observation as azure_plan

        factory = azure_plan
    plan = factory(row, target_image, observation, qualification)
    current = await repo.get(row["user_id"])
    if (
        _snapshot(current) != _snapshot(row)
        or ((current or {}).get("backend_metadata") or {}).get("upgradeLease") is not None
        or "erasure" in ((current or {}).get("backend_metadata") or {})
    ):
        raise ValueError("Pod assignment changed during Browser review")
    return plan


def public_browser_offer(plan: GcpBrowserCapabilityPlan, qualification: dict) -> dict:
    return {
        "releaseId": release_identity(
            plan.hushhId, plan.serviceUid, plan.targetImage, browser_digest=plan.digest
        ),
        "browserPlanDigest": plan.digest,
        "summary": "Enable Browser in your private agent.",
        "publicPolicy": plan.publicPolicy.model_dump(mode="json"),
        "model": qualification["readiness"]["model_name"],
        "resources": plan.resourceLimits,
        "changes": [
            "Your agent can research these public pages; you can watch, take control or stop.",
            "Screens use your selected AI. Website actions require your approval."
            if plan.publicPolicy.interactive
            else "Screens use your selected AI. Login and submissions are unavailable for this policy.",
            "Your existing cloud size, keys and on-demand settings stay in place.",
            "Background work shares one queue; a browser task can delay other queued work for up to 15 minutes.",
        ],
    }
