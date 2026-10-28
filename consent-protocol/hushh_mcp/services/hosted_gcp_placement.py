"""Retained managed placement identity, independent of new-work admission expiry.

This classifies a trusted registry snapshot; it is not remote attestation, a cost
reservation or permission to mutate cloud resources.
"""

from __future__ import annotations

import hashlib
import re
from dataclasses import dataclass
from typing import Any
from uuid import UUID


@dataclass(frozen=True)
class HostedPlacement:
    owner_id: str
    hushh_id: str
    project: str
    project_number: str
    region: str
    service: str
    service_uid: str
    runtime_principal: str
    bootstrap_sa: str


def has_hosted_evidence(row: Any) -> bool:
    if not isinstance(row, dict):
        return False
    metadata = row.get("backend_metadata") or {}
    if not isinstance(metadata, dict):
        return False
    attempt = metadata.get("provisionAttempt")
    return metadata.get("tenancy") == "hussh-hosted" or (
        isinstance(attempt, dict) and "hostedAdmission" in attempt
    )


def retained_hosted_placement(row: Any) -> HostedPlacement | None:
    """Existing owner access survives expiry; malformed managed evidence refuses."""
    from hushh_mcp.services.gcp_backend import _service_name
    from hushh_mcp.services.user_gcp_backend import pod_service_account_id

    try:
        metadata = row["backend_metadata"]
        attempt = metadata["provisionAttempt"]
        admission = attempt["hostedAdmission"]
        assignment = admission["assignment"]
        observation = attempt["evidence"]["reserved"]["projectObservation"]
        creation = attempt["evidence"]["host_requested"]["creationAcknowledgement"]
        owner, hushh_id = row["user_id"], row["hushh_id"]
        project, region = assignment["project"], assignment["region"]
        principal = f"{pod_service_account_id(hushh_id)}@{project}.iam.gserviceaccount.com"
        valid = (
            _binding_matches(row, admission, observation)
            and metadata["project"] == creation["project"] == project
            and metadata["region"] == creation["region"] == region
            and metadata["service"] == creation["service"]
            and metadata["runtime_service_account"] == principal
            and creation["backend"] == "gcp"
            and creation["service"] == _service_name(hushh_id)
            and isinstance(creation["serviceUid"], str)
            and 1 <= len(creation["serviceUid"]) <= 128
            and metadata.get("serviceUid", creation["serviceUid"]) == creation["serviceUid"]
            and creation["initialImage"]
            == f"{region}-docker.pkg.dev/{project}/one-pod/consent-protocol-pod@{admission['imageDigest']}"
        )
        if not valid:
            return None
        bootstrap = (
            assignment.get("bootstrapContract", {})
            .get("plan", {})
            .get("federation", {})
            .get("impersonation", {})
            .get("bootstrap_service_account", "")
        )
        if not isinstance(bootstrap, str) or not re.fullmatch(
            r"[a-z][a-z0-9-]{4,28}[a-z0-9]@" + re.escape(project) + r"\.iam\.gserviceaccount\.com",
            bootstrap,
        ):
            return None
        return HostedPlacement(
            owner,
            hushh_id,
            project,
            observation["projectNumber"],
            region,
            creation["service"],
            creation["serviceUid"],
            principal,
            bootstrap,
        )
    except (KeyError, TypeError, ValueError, AttributeError):
        return None


def _model_binding_valid(value: Any) -> bool:
    return bool(
        isinstance(value, dict)
        and set(value) == {"provider", "project", "model", "profileHash"}
        and value["provider"] == "gemini"
        and isinstance(value["project"], str)
        and re.fullmatch(r"[a-z][a-z0-9-]{4,28}[a-z0-9]", value["project"])
        and isinstance(value["model"], str)
        and re.fullmatch(r"gemini-[A-Za-z0-9._-]{1,100}", value["model"])
        and isinstance(value["profileHash"], str)
        and re.fullmatch(r"[a-f0-9]{64}", value["profileHash"])
    )


def _binding_matches(row: dict, admission: dict, observation: dict) -> bool:
    metadata = row["backend_metadata"]
    attempt = metadata["provisionAttempt"]
    assignment = admission["assignment"]
    owner, hushh_id = row["user_id"], row["hushh_id"]
    project, region = assignment["project"], assignment["region"]
    return bool(
        row["deployment_target"] == "gcp"
        and row["backend"] == "gcp"
        and row.get("model_credential_mode") in {None, "fleet_adc"}
        and row["status"] in {"provisioning", "connecting", "provisioned"}
        and metadata["tenancy"] == "hussh-hosted"
        and "erasure" not in metadata
        and attempt["ownerId"] == attempt["intent"]["user_id"] == owner
        and attempt["intent"]["hushh_id"] == assignment["hushhId"] == hushh_id
        and attempt["phase"] in {"host_requested", "host_acknowledged", "connecting", "provisioned"}
        and type(admission["version"]) is int
        and admission["version"] == 1
        and admission["environment"] == "dev"
        and str(UUID(admission["policyId"])) == admission["policyId"]
        and assignment["ownerHash"] == "sha256:" + hashlib.sha256(owner.encode()).hexdigest()
        and re.fullmatch(r"[a-z][a-z0-9-]{4,28}[a-z0-9]", project)
        and re.fullmatch(r"[a-z]+-[a-z]+[0-9]+", region)
        and re.fullmatch(r"[a-f0-9]{40}", admission["sourceRevision"])
        and re.fullmatch(r"sha256:[a-f0-9]{64}", admission["imageDigest"])
        and observation["projectId"] == project
        and observation["lifecycleState"] == "ACTIVE"
        and re.fullmatch(r"[1-9][0-9]{0,19}", observation["projectNumber"])
        and assignment["projectNumber"] in {None, observation["projectNumber"]}
        and _model_binding_valid(admission["modelBinding"])
        and not any(value for key, value in row.items() if key.startswith("user_cloud_"))
    )


def direct_admission_snapshot(row: dict | None) -> dict | None:
    """Freeze exactly the managed authority checked before live ingress readback."""
    if row is None or retained_hosted_placement(row) is None:
        return None
    return {
        key: value
        for key, value in row.items()
        if key.startswith("user_cloud_")
        or key
        in {
            "user_id",
            "hushh_id",
            "backend",
            "deployment_target",
            "status",
            "pod_key_id",
            "pod_pubkey",
            "backend_metadata",
            "model_credential_mode",
        }
    }
