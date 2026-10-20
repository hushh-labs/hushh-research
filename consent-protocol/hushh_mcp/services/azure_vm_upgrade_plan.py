"""Exact VM image-update requests for the existing owner operation.

Preparation only: this does not admit an ARM write or enable VM hosting. The
worker must retain the intent, hold the existing upgrade lease and reconcile
each provider dispatch before continuing. No credential or script enters it.
"""

from __future__ import annotations

import hashlib
import json
from copy import deepcopy
from dataclasses import dataclass, field
from typing import Callable, Literal, NoReturn

from hushh_mcp.services.azure_arm_client import API_VERSIONS
from hushh_mcp.services.azure_arm_mutations import body_commitment
from hushh_mcp.services.azure_hosted_intent import registry_binding
from hushh_mcp.services.azure_setup_applier import AzureSetupRefused
from hushh_mcp.services.azure_setup_plan import ArmStep
from hushh_mcp.services.azure_vm_host_binding import AzureVmHostBinding, recorded_vm_host
from hushh_mcp.services.azure_vm_host_bundle import _SOURCE, replacement_from_binding
from hushh_mcp.services.compute_backend import PodSpec


def _refuse() -> NoReturn:
    raise AzureSetupRefused("The agent's installed host changed.", code="SETUP_FENCED")


def vm_registry_binding(row: dict) -> dict:
    """Capture current custody as well as provider identity, without private values."""
    metadata = row.get("backend_metadata") or {}
    return {
        **registry_binding(row),
        "placement_epoch": row.get("placement_epoch"),
        **{key: row.get(key) for key in ("pod_signing_key_id", "pod_signing_pubkey")},
        **{
            key: deepcopy(metadata.get(key))
            for key in (
                "hostKind",
                "vmHost",
                "url",
                "image_digest",
                "vmConfigurationSha256",
                "vmUpdateModuleSha256",
            )
        },
        "vmPower": (
            {
                key: deepcopy(metadata["vmPower"].get(key))
                for key in ("operationId", "phase", "binding")
            }
            if isinstance(metadata.get("vmPower"), dict)
            else None
        ),
    }


@dataclass(frozen=True)
class VmImageUpdatePlan:
    # Serialized request bodies are held in memory, never displayed or journaled.
    _requests: tuple[tuple[str, Literal["PUT", "POST", "PATCH"], str, str, bytes], ...] = field(
        repr=False
    )
    _intent: bytes = field(repr=False)
    target_image: str
    host_request_sha256: str

    def intent(self, *, job: str) -> dict:
        if not 1 <= len(job) <= 128:
            _refuse()
        return {**json.loads(self._intent), "jobId": job}

    def steps(self) -> tuple[ArmStep, ...]:
        """Return fresh bodies so callers cannot change the retained commitments."""
        return tuple(
            ArmStep(purpose, "action", method, path, api, json.loads(raw))
            for purpose, method, path, api, raw in self._requests
        )


def approved_vm_update(
    row: dict, spec: PodSpec, *, allow_unresolved: bool = False
) -> tuple[AzureVmHostBinding, dict, dict]:
    """Verify existing owner approval before asking the old runtime to drain."""
    from hushh_mcp.services.personal_agent_provisioning_service import _approval_is_well_formed

    metadata = row.get("backend_metadata") or {}
    host = recorded_vm_host(metadata)
    if host is None or spec.azure_vm_host != host:
        _refuse()
    host.require_spec(spec)
    module_sha = hashlib.sha256((_SOURCE / "update.py").read_bytes()).hexdigest()
    approval, lease = metadata.get("upgradeApproval"), metadata.get("upgradeLease")
    if not isinstance(approval, dict):
        _refuse()
    if (
        row.get("status") != "provisioned"
        or row.get("backend") != "user_azure"
        or row.get("deployment_target") != "user_azure"
        or row.get("external_agent_id") != host.installation.resource_id
        or row.get("hushh_id") != host.installation.hushh_id
        or row.get("pod_pubkey") != spec.pod_pubkey
        or type(row.get("placement_epoch")) is not int
        or row["placement_epoch"] < 0
        or any(
            row.get("user_cloud_" + key) != getattr(spec, "user_cloud_" + key)
            for key in ("tenant_id", "subscription_id", "resource_group", "region")
        )
        or not isinstance(metadata.get("setupNonce"), str)
        or "erasure" in metadata
        or not row.get("pod_signing_key_id")
        or not row.get("pod_signing_pubkey")
        or metadata.get("vmUpdateModuleSha256") != module_sha
        or not isinstance(lease, str)
        or not lease
        or hashlib.sha256(lease.encode()).hexdigest() != spec.upgrade_attempt_id
        or not _approval_is_well_formed(row, approval, allow_unresolved=allow_unresolved)
        or approval["operationId"] != spec.upgrade_operation_id
        or approval["targetImage"] != spec.upgrade_target_image
        or approval.get("capabilityPlanDigest") is not None
        or spec.files_upgrade_plan is not None
        or (
            metadata.get("vmPower") is not None
            and (
                not isinstance(metadata["vmPower"], dict)
                or metadata["vmPower"].get("phase") != "ready"
            )
        )
    ):
        _refuse()
    return host, metadata, approval


def _require_update(
    row: dict, spec: PodSpec, idle_record: dict
) -> tuple[AzureVmHostBinding, dict, dict]:
    host, metadata, approval = approved_vm_update(row, spec)
    if approval.get("handoffIdleRecord") != idle_record:
        _refuse()
    from hushh_mcp.services.pod_upgrade_handoff import (
        PodUpgradeHandoffUnavailable,
        retained_idle_evidence,
    )

    try:
        retained_idle_evidence(
            {
                "operationId": approval["operationId"],
                "incarnation": approval.get("handoffIncarnation"),
                "runtimeEpoch": approval.get("handoffRuntimeEpoch"),
                "activeWork": 0,
                "committedState": approval.get("handoffCommittedState"),
                "committedCursor": approval.get("handoffCommittedCursor"),
                "idleRecord": idle_record,
            },
            operation_id=spec.upgrade_operation_id or "",
            require_cursor=True,
        )
    except PodUpgradeHandoffUnavailable:
        _refuse()
    if approval["handoffIncarnation"] != host.installation.generation:
        _refuse()
    return host, metadata, approval


def _import_body(
    registry: str, repository: str, image_digest: str, source_credentials: dict[str, str] | None
) -> dict:
    import_body: dict = {
        "source": {"registryUri": registry, "sourceImage": repository + "@" + image_digest},
        "untaggedTargetRepositories": ["pod"],
        "mode": "NoForce",
    }
    if source_credentials is not None:
        from hushh_mcp.services.azure_image_source import REGISTRY_USERNAME, is_google_registry

        # The caller uses azure_image_source's approved reader. Its short-lived
        # credential is committed only AFTER injection and stays in this object.
        if (
            not is_google_registry(registry)
            or set(source_credentials) != {"username", "password"}
            or source_credentials.get("username") != REGISTRY_USERNAME
            or any(not isinstance(value, str) or not value for value in source_credentials.values())
        ):
            _refuse()
        import_body["source"]["credentials"] = deepcopy(source_credentials)
    return import_body


def _intent(
    row: dict,
    spec: PodSpec,
    host: AzureVmHostBinding,
    approval: dict,
    idle_record: dict,
    steps: tuple[ArmStep, ...],
    host_request_sha256: str,
) -> dict:
    metadata = row["backend_metadata"]
    return {
        "version": 3,
        "kind": "vm_upgrade",
        "hushhId": spec.hushh_id,
        "tenantId": str(row["user_cloud_tenant_id"]),
        "subscriptionId": str(row["user_cloud_subscription_id"]),
        "resourceGroup": str(row["user_cloud_resource_group"]),
        "location": host.location,
        "setupNonce": metadata["setupNonce"],
        "binding": vm_registry_binding(row),
        "sourceImage": spec.upgrade_target_image,
        "attemptId": spec.upgrade_attempt_id,
        "operationId": approval["operationId"],
        "releaseId": approval["releaseId"],
        "idempotencyKey": approval["idempotencyKey"],
        "capabilityPlanDigest": None,
        "idleRecord": deepcopy(idle_record),
        "hostRequestSha256": host_request_sha256,
        "allowedRequests": [
            {
                "method": step.method,
                "path": step.path,
                "apiVersion": API_VERSIONS[step.api],
                "purpose": step.stage,
                "bodySha256": body_commitment(step.body),
            }
            for step in steps
        ],
    }


def build_vm_image_update(
    row: dict,
    spec: PodSpec,
    *,
    idle_record: dict,
    source_credentials: dict[str, str] | None = None,
) -> VmImageUpdatePlan:
    """Freeze the real import body after ephemeral credentials are supplied.

    The previous configuration stays on the host. Its installed commitment must
    already be retained; no configuration export is needed for preparation.
    This image-only plan cannot install Files resources, change host capacity or
    repair an unknown updater. Those require distinct, qualified offers.
    """
    from hushh_mcp.services.azure_agent_upgrade import import_source

    host, metadata, approval = _require_update(row, spec, idle_record)
    source = str(spec.upgrade_target_image or "")
    registry, repository, image_digest = import_source(source)
    destination = host.image.split("@", 1)[0] + "@" + image_digest
    replacement, payload_sha = replacement_from_binding(
        installation=host.installation.model_dump(),
        previous_image=host.image,
        configuration_sha256=metadata.get("vmConfigurationSha256", ""),
        update_module_sha256=metadata.get("vmUpdateModuleSha256", ""),
        image=destination,
        operation_id=approval["operationId"],
        idle_record=idle_record,
    )
    steps = (
        ArmStep(
            "vm_image_import",
            "action",
            "POST",
            host.installation.resource_id.split("/providers/", 1)[0]
            + "/providers/Microsoft.ContainerRegistry/registries/"
            + host.image.split(".", 1)[0]
            + "/importImage",
            "container_registry",
            _import_body(registry, repository, image_digest, source_credentials),
        ),
        ArmStep(
            "vm_image_replace",
            "action",
            replacement.method,
            replacement.path,
            replacement.api,
            replacement.body,
        ),
        ArmStep(
            "vm_image_tag",
            "action",
            "PATCH",
            host.installation.resource_id + "/providers/Microsoft.Resources/tags/default",
            "tags",
            {"operation": "Merge", "properties": {"tags": {"husshPodImage": image_digest}}},
        ),
    )
    return VmImageUpdatePlan(
        tuple((s.stage, s.method, s.path, s.api, json.dumps(s.body).encode()) for s in steps),
        json.dumps(_intent(row, spec, host, approval, idle_record, steps, payload_sha)).encode(),
        destination,
        payload_sha,
    )


def prepare_vm_image_update(
    *,
    row: dict,
    spec: PodSpec,
    receipt: dict,
    guard: Callable[[], None],
    advance: Callable[[str], None],
) -> VmImageUpdatePlan:
    from hushh_mcp.services.azure_agent_upgrade import import_source
    from hushh_mcp.services.azure_image_source import import_credentials, require_import_access

    guard()
    registry, repository, digest = import_source(str(spec.upgrade_target_image or ""))
    require_import_access(registry, repository, digest)
    credentials = import_credentials(registry)
    private = credentials() if credentials is not None else None
    guard()
    return build_vm_image_update(
        row, spec, idle_record=receipt["idleRecord"], source_credentials=private
    )
