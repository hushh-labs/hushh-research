from __future__ import annotations

import hashlib
import json
import re
from dataclasses import dataclass
from typing import Any, Protocol

from hushh_mcp.services.hosted_provider_account_transition import PLACEMENTS

CENTRAL_PROJECT = "hushh-pda-dev"

INFERENCE_BRIDGE_PROJECT = "hushh-gemini-bridge"

PROTECTED_PROJECTS = frozenset(
    {
        CENTRAL_PROJECT,
        INFERENCE_BRIDGE_PROJECT,
        "hushh-pda-uat",
        "hushh-pda-prod",
        "hushh-pda-production",
    }
)

REGION = "us-central1"

OLD_BILLING_ACCOUNT = "billingAccounts/014D7F-FD970D-D2459E"

TARGET_BILLING_ACCOUNT = "billingAccounts/013848-8258FA-2D068F"

EXPECTED_OPERATOR = "user:kushaltrivedi97@gmail.com"

REVIEWED_FOLDER_ID = "1085913534660"

MANIFEST_SCHEMA = "hosted-provider-account-review/v1"

SHA256_PATTERN = re.compile(r"^[a-f0-9]{64}$")

SOURCE_REVISION_PATTERN = re.compile(r"^[a-f0-9]{40}$")


class OperatorRefused(RuntimeError):
    """A manifest, identity or lifecycle precondition is not established."""


@dataclass(frozen=True)
class InventorySnapshot:
    manifest: dict[str, Any]
    sha256: str
    placements: dict[str, dict[str, Any]]
    unresolved: tuple[str, ...] = ()
    records: dict[str, dict[str, Any]] | None = None

    def report(self) -> dict[str, Any]:
        return {
            "schema": MANIFEST_SCHEMA,
            "manifest": self.manifest,
            "manifestSha256": self.sha256,
            "unresolved": list(self.unresolved),
            "reportOnly": True,
        }


class OperatorRuntime(Protocol):
    async def inventory(self) -> InventorySnapshot: ...

    async def perform(
        self,
        action: str,
        placement: dict[str, Any],
        *,
        reviewed_sha256: str,
        inventory_snapshot: InventorySnapshot,
    ) -> dict[str, Any]: ...


def canonical_manifest_sha256(manifest: dict[str, Any]) -> str:
    """Hash only the canonical, redacted inventory that the operator reviewed."""
    encoded = json.dumps(manifest, sort_keys=True, separators=(",", ":"), ensure_ascii=True).encode(
        "utf-8"
    )
    return hashlib.sha256(encoded).hexdigest()


def validate_manifest(manifest: Any) -> str:
    if not isinstance(manifest, dict) or manifest.get("schema") != MANIFEST_SCHEMA:
        raise OperatorRefused("reviewed manifest schema is invalid")
    digest = manifest.get("manifestSha256")
    if not isinstance(digest, str) or not SHA256_PATTERN.fullmatch(digest):
        raise OperatorRefused("reviewed manifest SHA-256 is invalid")
    return digest


def require_mutation_confirmation(
    *, environment: str | None, apply: bool, supplied_sha256: str | None
) -> None:
    if environment != "dev":
        raise OperatorRefused("mutations require --environment dev")
    if apply is not True:
        raise OperatorRefused("mutations require --apply")
    if not isinstance(supplied_sha256, str) or not SHA256_PATTERN.fullmatch(supplied_sha256):
        raise OperatorRefused("mutations require the reviewed --manifest-sha256")


def require_reviewed_placement(snapshot: InventorySnapshot, *, hushh_id: str) -> dict[str, Any]:
    if snapshot.unresolved:
        raise OperatorRefused("inventory contains unresolved evidence")
    placement = snapshot.placements.get(hushh_id)
    expected = PLACEMENTS.get(hushh_id)
    if not isinstance(placement, dict) or not isinstance(expected, dict):
        raise OperatorRefused("owner is outside the reviewed two-placement manifest")
    project = placement.get("projectId")
    if project in PROTECTED_PROJECTS:
        raise OperatorRefused("protected project cannot be mutated")
    if project != expected["projectId"]:
        raise OperatorRefused("project differs from the reviewed placement")
    if placement.get("identityState") != "verified":
        raise OperatorRefused("native and registry identity is unresolved")
    if placement.get("lifecycleState") not in {
        "provisioned",
        "provisioning",
        "provisioning_failed",
        "suspended",
    }:
        raise OperatorRefused("retained lifecycle phase is not supported")
    return placement


async def execute_action(
    runtime: OperatorRuntime,
    *,
    action: str,
    hushh_id: str | None,
    environment: str | None,
    apply: bool,
    manifest_sha256: str | None,
) -> dict[str, Any]:
    """Inventory, gate a proposed mutation, re-inventory, then delegate once."""
    initial = await runtime.inventory()
    if action == "inventory":
        return initial.report()
    if action not in {"resume", "associate-account", "remove"}:
        raise OperatorRefused("unsupported action")
    if not hushh_id:
        raise OperatorRefused("mutating actions require --hushh-id")
    placement = require_reviewed_placement(initial, hushh_id=hushh_id)
    planned = {
        "action": action,
        "hushhId": hushh_id,
        "projectId": placement["projectId"],
        "operation": (
            "continue_existing_erasure_only"
            if action == "remove"
            else "continue_retained_operation"
        ),
        "reportOnly": True,
        "manifestSha256": initial.sha256,
    }
    if not apply:
        return planned
    require_mutation_confirmation(
        environment=environment,
        apply=apply,
        supplied_sha256=manifest_sha256,
    )
    if manifest_sha256 != initial.sha256:
        raise OperatorRefused("reviewed manifest SHA is stale")

    current = await runtime.inventory()
    if current.unresolved:
        raise OperatorRefused("fresh inventory contains unresolved evidence")
    if current.sha256 != manifest_sha256:
        raise OperatorRefused("native or registry identity changed after review")
    current_placement = require_reviewed_placement(current, hushh_id=hushh_id)
    result = await runtime.perform(
        action,
        current_placement,
        reviewed_sha256=current.sha256,
        inventory_snapshot=current,
    )
    return {
        "action": action,
        "hushhId": hushh_id,
        "projectId": current_placement["projectId"],
        "manifestSha256": current.sha256,
        "result": result,
        "reportOnly": False,
    }


def _owner_hash(owner_id: str) -> str:
    return "sha256:" + hashlib.sha256(owner_id.encode("utf-8")).hexdigest()


def _digest(value: Any) -> str:
    encoded = json.dumps(
        value, sort_keys=True, separators=(",", ":"), ensure_ascii=True, default=str
    ).encode("utf-8")
    return hashlib.sha256(encoded).hexdigest()


def _json_value(value: Any) -> Any:
    if value is None or isinstance(value, (str, int, float, bool)):
        return value
    if isinstance(value, dict):
        return {str(key): _json_value(item) for key, item in value.items()}
    if isinstance(value, list):
        return [_json_value(item) for item in value]
    return str(value)


def _authority_row(row: dict[str, Any] | None) -> dict[str, Any] | None:
    if not isinstance(row, dict):
        return None
    erasure = (row.get("backend_metadata") or {}).get("erasure")
    snapshot = erasure.get("registrySnapshot") if isinstance(erasure, dict) else None
    return snapshot if isinstance(snapshot, dict) else row


def _attempt(row: dict[str, Any] | None) -> dict[str, Any]:
    if not isinstance(row, dict):
        return {}
    metadata = row.get("backend_metadata")
    attempt = metadata.get("provisionAttempt") if isinstance(metadata, dict) else None
    return attempt if isinstance(attempt, dict) else {}


def _lifecycle_phase(row: dict[str, Any], attempt: dict[str, Any]) -> str:
    status = str(row.get("status") or "unknown")
    if status == "suspended":
        erasure = (row.get("backend_metadata") or {}).get("erasure") or {}
        return "erasure_" + str(erasure.get("phase") or "reserved")
    if status in {"provisioning", "connecting", "provisioned", "provisioning_failed"}:
        return str(attempt.get("phase") or status)
    return status


def _creation_identity(row: dict[str, Any] | None) -> dict[str, Any]:
    attempt = _attempt(row)
    evidence = attempt.get("evidence") if isinstance(attempt.get("evidence"), dict) else {}
    reserved = evidence.get("reserved") if isinstance(evidence.get("reserved"), dict) else {}
    checkpoint = reserved.get("hostedPreparation")
    completed = checkpoint.get("completed") if isinstance(checkpoint, dict) else None
    if isinstance(completed, list) and completed and isinstance(completed[0], dict):
        observation = completed[0].get("resourceObservation")
        identity = observation.get("identity") if isinstance(observation, dict) else None
        return identity if isinstance(identity, dict) else {}
    return {}


def _retained_service_name(row: dict[str, Any] | None, expected: dict[str, Any]) -> str:
    if isinstance(row, dict):
        metadata = row.get("backend_metadata") or {}
        attempt = _attempt(row)
        evidence = attempt.get("evidence") if isinstance(attempt.get("evidence"), dict) else {}
        host_requested = evidence.get("host_requested")
        acknowledgement = (
            host_requested.get("creationAcknowledgement")
            if isinstance(host_requested, dict)
            else None
        )
        if isinstance(acknowledgement, dict) and isinstance(acknowledgement.get("service"), str):
            return acknowledgement["service"]
        if isinstance(metadata.get("service"), str) and metadata["service"]:
            return metadata["service"]
        from hushh_mcp.services.gcp_backend import _service_name

        return _service_name(str(row.get("hushh_id") or expected["hushhId"]))
    from hushh_mcp.services.gcp_backend import _service_name

    return _service_name(expected["hushhId"])


def _service_parts(
    service: Any,
) -> tuple[dict[str, Any], dict[str, Any], dict[str, Any], dict[str, Any]]:
    metadata = service.get("metadata") if isinstance(service, dict) else None
    metadata = metadata if isinstance(metadata, dict) else {}
    labels = metadata.get("labels") if isinstance(metadata.get("labels"), dict) else {}
    service_spec = service.get("spec") if isinstance(service, dict) else None
    service_spec = service_spec if isinstance(service_spec, dict) else {}
    template = service_spec.get("template")
    template = template if isinstance(template, dict) else {}
    template_spec = template.get("spec")
    template_spec = template_spec if isinstance(template_spec, dict) else {}
    containers = template_spec.get("containers")
    container = containers[0] if isinstance(containers, list) and len(containers) == 1 else {}
    return metadata, labels, template_spec, container if isinstance(container, dict) else {}


def _service_matches(service: Any, *, row: dict[str, Any] | None, expected: dict[str, Any]) -> bool:
    if not isinstance(service, dict) or not isinstance(row, dict):
        return False
    metadata, labels, template_spec, container = _service_parts(service)
    attempt = _attempt(row)
    identity = _creation_identity(row)
    metadata_row = row.get("backend_metadata") or {}
    expected_name = _retained_service_name(row, expected)
    image = container.get("image")
    runtime = template_spec.get("serviceAccountName")
    return bool(
        metadata.get("name") == expected_name
        and metadata.get("namespace") == expected["projectNumber"]
        and metadata.get("uid") == expected["serviceUid"]
        and labels.get("app") == "hussh-one-pod"
        and labels.get("hussh-tenancy") == "hussh-hosted"
        and labels.get("hussh-provision-attempt") == expected["attemptId"]
        and runtime == expected["runtimePrincipal"]
        and image
        == (
            f"{REGION}-docker.pkg.dev/{expected['projectId']}/one-pod/"
            "consent-protocol-pod@sha256:639958a5d5a9adf12c5a93839afaa3a8a1a86421896291b746b4e8c257ffc8a1"
        )
        and attempt.get("attemptId") == expected["attemptId"]
        and identity.get("projectId") == expected["projectId"]
        and identity.get("projectNumber") == expected["projectNumber"]
        and metadata_row.get("project") == expected["projectId"]
        and metadata_row.get("runtime_service_account") == expected["runtimePrincipal"]
        and metadata_row.get("serviceUid", expected["serviceUid"]) == expected["serviceUid"]
    )


def _service_summary(candidate: dict[str, Any]) -> dict[str, Any]:
    service = candidate.get("service")
    metadata, labels, template_spec, container = _service_parts(service)
    return {
        "name": metadata.get("name"),
        "namespace": metadata.get("namespace"),
        "serviceUid": metadata.get("uid"),
        "candidateSources": list(candidate.get("candidateSources") or []),
        "labels": {
            key: labels.get(key)
            for key in (
                "app",
                "hussh-tenancy",
                "hussh-provision-attempt",
                "hussh-env",
                "hussh-purpose",
            )
            if isinstance(labels.get(key), str)
        },
        "runtimePrincipal": template_spec.get("serviceAccountName"),
        "image": container.get("image"),
    }


def _read_native_project_identity(reader: Any, expected: dict[str, Any]) -> dict[str, Any]:
    url = f"https://cloudresourcemanager.googleapis.com/v1/projects/{expected['projectId']}"
    response = reader.response(url, {})
    if response.status_code != 200:
        error = RuntimeError("native project read failed")
        error.http_status = response.status_code
        raise error
    value = reader.body(response)
    if (
        not isinstance(value, dict)
        or value.get("projectId") != expected["projectId"]
        or str(value.get("projectNumber")) != expected["projectNumber"]
    ):
        raise OperatorRefused("native project ID or number differs from reviewed manifest")
    return value


def _registry_evidence(row: dict[str, Any] | None) -> dict[str, Any]:
    from scripts.ops.hosted_provider_account_evidence import _transition_summary

    if not isinstance(row, dict):
        return {"state": "absent"}
    authority = _authority_row(row) or {}
    attempt = _attempt(authority)
    admission = attempt.get("hostedAdmission") or {}
    assignment = admission.get("assignment") or {}
    erasure = (row.get("backend_metadata") or {}).get("erasure") or {}
    return {
        "ownerHash": _owner_hash(str(row.get("user_id") or "")),
        "hushhId": row.get("hushh_id"),
        "status": row.get("status"),
        "placementEpoch": row.get("placement_epoch"),
        "backend": row.get("backend"),
        "deploymentTarget": row.get("deployment_target"),
        "project": (authority.get("backend_metadata") or {}).get("project"),
        "region": (authority.get("backend_metadata") or {}).get("region"),
        "service": (authority.get("backend_metadata") or {}).get("service"),
        "serviceUid": (authority.get("backend_metadata") or {}).get("serviceUid"),
        "runtimePrincipal": (authority.get("backend_metadata") or {}).get(
            "runtime_service_account"
        ),
        "attemptId": attempt.get("attemptId"),
        "attemptPhase": attempt.get("phase"),
        "admission": {
            "environment": admission.get("environment"),
            "sourceRevision": admission.get("sourceRevision"),
            "imageDigest": admission.get("imageDigest"),
            "project": assignment.get("project"),
            "projectNumber": assignment.get("projectNumber"),
            "ownerHash": assignment.get("ownerHash"),
        },
        "transition": _transition_summary(attempt.get("providerAccountTransition")),
        "erasure": {
            "ownerHash": _owner_hash(str(erasure.get("ownerId") or ""))
            if erasure.get("ownerId")
            else None,
            "attemptId": erasure.get("attemptId"),
            "phase": erasure.get("phase"),
            "snapshotSha256": _digest(erasure.get("registrySnapshot"))
            if isinstance(erasure.get("registrySnapshot"), dict)
            else None,
        },
    }


def _creation_recovery_ready(row: dict[str, Any] | None) -> bool:
    if not isinstance(row, dict):
        return False
    attempt = _attempt(row)
    evidence = attempt.get("evidence") if isinstance(attempt.get("evidence"), dict) else {}
    completed = (
        evidence.get("reserved", {}).get("hostedPreparation", {}).get("completed")
        if isinstance(evidence.get("reserved"), dict)
        else None
    )
    return bool(
        row.get("status") == "provisioning"
        and attempt.get("phase") == "host_requested"
        and not evidence.get("host_requested", {}).get("creationAcknowledgement")
        and isinstance(completed, list)
        and len(completed) == 5
        and all(isinstance(item, dict) and item.get("ok") is True for item in completed)
    )


def _safe_result(value: Any) -> dict[str, Any]:
    if not isinstance(value, dict):
        return {"status": "completed"}
    safe = {}
    for key in ("status", "phase", "generation", "attemptId", "noOp", "rowDeleteDeferred"):
        if isinstance(value.get(key), (str, int, bool)):
            safe[key] = value[key]
    return safe or {"status": "completed"}
