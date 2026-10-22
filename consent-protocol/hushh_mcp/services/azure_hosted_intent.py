"""Bound, secret-free plans for existing Azure pods, in the existing setup journal."""

from __future__ import annotations

import hashlib
from typing import Any, Literal

from hushh_mcp.services.azure_agent_setup import parse_source_image
from hushh_mcp.services.azure_arm_client import API_VERSIONS
from hushh_mcp.services.azure_setup_applier import CUSTODY_STAGES, AzureSetupRefused
from hushh_mcp.services.azure_setup_plan import (
    PlanInputs,
    Scopes,
    build_setup_plan,
    import_image_step,
    resource_names,
)
from hushh_mcp.services.compute_backend import PodSpec

_HOST_FIELDS = (
    "user_id",
    "hushh_id",
    "backend",
    "external_agent_id",
    "deployment_target",
    "pod_pubkey",
    "pod_key_id",
    "model_credential_mode",
)
_IDENTITY_FIELDS = (
    "serviceUid",
    "setupNonce",
    "runtime_principal_id",
    "runtime_client_id",
    "image",
)


def registry_binding(row: dict) -> dict:
    """Only stable identity/custody fields; progress and observations may change."""
    metadata = row.get("backend_metadata") or {}
    return {
        **{field: row.get(field) for field in _HOST_FIELDS},
        **{field: metadata.get(field) for field in _IDENTITY_FIELDS},
    }


def _request(method: str, path: str, api: str, purpose: str) -> dict[str, str]:
    return {"method": method, "path": path, "apiVersion": API_VERSIONS[api], "purpose": purpose}


def hosted_intent(
    row: dict, *, job: str, spec: PodSpec, source: str, kind: Literal["upgrade", "rebuild"]
) -> dict[str, Any]:
    """Derive exact dispatch tuples from their owning plans, never request bodies."""
    metadata = row.get("backend_metadata") or {}
    if (
        row.get("deployment_target") != "user_azure"
        or row.get("hushh_id") != spec.hushh_id
        or metadata.get("serviceUid") != spec.expected_service_uid
        or not metadata.get("setupNonce")
    ):
        raise AzureSetupRefused("The agent binding changed.", code="SETUP_FENCED")
    if kind == "upgrade":
        from hushh_mcp.services.azure_agent_upgrade import import_source

        if source != spec.upgrade_target_image:
            raise AzureSetupRefused("Update image changed.", code="SETUP_FENCED")
        registry, repository, _digest = import_source(source)
    else:
        registry, repository, _digest = parse_source_image(source)
    inputs = PlanInputs(
        spec.hushh_id,
        str(row.get("user_cloud_tenant_id") or ""),
        str(row.get("user_cloud_subscription_id") or ""),
        str(row.get("user_cloud_region") or ""),
        str(row.get("user_cloud_resource_group") or ""),
        str(metadata["setupNonce"]),
        files_enabled=spec.files_library_enabled,
    )
    intent = {
        "version": 2,
        "kind": kind,
        "jobId": job,
        "hushhId": spec.hushh_id,
        "tenantId": inputs.tenant_id,
        "subscriptionId": inputs.subscription_id,
        "resourceGroup": inputs.resource_group,
        "location": inputs.location,
        "setupNonce": inputs.nonce,
        "binding": registry_binding(row),
        "sourceImage": source,
    }
    if kind == "upgrade":
        return {**intent, **_upgrade(row, spec, inputs, registry, repository)}
    plan = build_setup_plan(
        inputs, source_registry=registry, source_repository=repository, app_body={}
    )
    return {
        **intent,
        "allowedRequests": [
            _request(step.method, step.path, step.api, step.stage)
            for step in plan.steps
            if not (step.kind == "resource" and step.stage in CUSTODY_STAGES)
        ],
    }


def _upgrade(row: dict, spec: PodSpec, inputs: PlanInputs, registry: str, repository: str) -> dict:
    from hushh_mcp.services.personal_agent_provisioning_service import _approval_is_well_formed
    from hushh_mcp.services.pod_update_identity import approved_files_plan

    metadata = row["backend_metadata"]
    approval = metadata.get("upgradeApproval")
    lease = metadata.get("upgradeLease")
    if (
        not isinstance(lease, str)
        or not lease
        or hashlib.sha256(lease.encode()).hexdigest() != spec.upgrade_attempt_id
        or not _approval_is_well_formed(row, approval)
        or approval["operationId"] != spec.upgrade_operation_id
        or approval["targetImage"] != spec.upgrade_target_image
    ):
        raise AzureSetupRefused("Update authority changed.", code="SETUP_FENCED")
    scopes = Scopes(inputs, resource_names(inputs))
    imported = import_image_step(scopes, registry, repository)
    requests = [
        _request(imported.method, imported.path, imported.api, imported.stage),
        _request("PUT", scopes.app, "container_apps", "deploying_agent"),
    ]
    capability = approved_files_plan(approval)
    from hushh_mcp.services.pod_update_identity import approved_browser_plan

    browser = approved_browser_plan(approval)
    if browser is not None and spec.browser_upgrade_plan != browser.model_dump(mode="json"):
        raise AzureSetupRefused("Browser approval changed.", code="SETUP_FENCED")
    if capability is not None:
        if spec.files_upgrade_plan != capability.model_dump():
            raise AzureSetupRefused("Files approval changed.", code="SETUP_FENCED")
        requests += [
            _request("PUT", call["path"], call["api"], "files_activation")
            for call in capability.operations()
        ]
    return {
        "attemptId": spec.upgrade_attempt_id,
        "operationId": approval["operationId"],
        "releaseId": approval["releaseId"],
        "idempotencyKey": approval["idempotencyKey"],
        "capabilityPlanDigest": approval.get("capabilityPlanDigest"),
        "allowedRequests": requests,
    }
