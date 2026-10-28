"""One reviewed capability-domain exception for newly created managed pilots.

A generic Vertex location is not necessarily an Engine namespace. This leaf
never treats an HTTP error as an empty collection or relaxes legacy inventory.
"""

from __future__ import annotations

import hashlib
import json
import re
from datetime import datetime, timezone
from pathlib import Path

from hushh_mcp.services.provision_attempt import ProvisionReconciliationRequired

CONTRACT = Path(__file__).resolve().parents[2] / "config/managed-pilot-native-locations.json"
SOURCE = "https://docs.cloud.google.com/gemini-enterprise-agent-platform/resources/agent-locations"


def utc_now() -> datetime:
    return datetime.now(timezone.utc)


def _instant(value: str) -> datetime:
    parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    if parsed.tzinfo is None:
        raise ValueError("Timestamp lacks timezone")
    return parsed.astimezone(timezone.utc)


def provider_contract(now: datetime) -> dict:
    try:
        value = json.loads(CONTRACT.read_text())
        snapshot = value["snapshot"]
        digest = hashlib.sha256(
            json.dumps(snapshot, sort_keys=True, separators=(",", ":")).encode()
        ).hexdigest()
        regions = {name.rstrip("*†") for name in snapshot["regions"]}
        if (
            value["schemaVersion"] != 1
            or value["sourceUrl"] != SOURCE
            or digest != value["snapshotSha256"]
            or "ca" in regions
            or snapshot["multiRegions"] != ["us", "eu"]
            or snapshot["globalMemoryAndSessions"] is not True
            or not _instant(value["sourceLastUpdated"] + "T00:00:00Z")
            <= _instant(value["retrievedAt"])
            <= now
            < _instant(value["qualificationExpiresAt"])
        ):
            raise ValueError("Provider capability qualification is stale or changed")
        return {
            key: value[key]
            for key in (
                "sourceUrl",
                "sourceLastUpdated",
                "snapshotSha256",
                "qualificationExpiresAt",
            )
        }
    except (OSError, ValueError, TypeError, KeyError, AttributeError) as exc:
        raise ProvisionReconciliationRequired("Engine location contract is unqualified") from exc


def ca_not_applicable(
    *,
    project: str,
    number: str,
    native: dict,
    creation: dict,
    context: dict | None,
    retained_locations: tuple[str, ...],
    endpoint: str,
    observed_at: datetime,
) -> dict:
    try:
        snapshot = (context or {})["registrySnapshot"]
        attempt = snapshot["backend_metadata"]["provisionAttempt"]
        admission = attempt["hostedAdmission"]
        assignment = admission["assignment"]
        owner = snapshot["user_id"]
        expected_labels = {
            "created-by": "hussh-one",
            "tenancy": "hussh-hosted",
            "hussh-environment": "dev",
            "hussh-provision-attempt": attempt["attemptId"],
        }
        retained = json.dumps(snapshot["backend_metadata"], separators=(",", ":"))
        engine_reference = re.compile(
            r"projects/(?:"
            + re.escape(project)
            + "|"
            + re.escape(number)
            + r")/locations/ca/(?:reasoningEngines|memoryBanks)/"
        )
        if (
            admission["environment"] != "dev"
            or snapshot["deployment_target"] != "gcp"
            or owner != (context or {})["ownerId"]
            or owner != attempt["ownerId"]
            or assignment["project"] != project
            or assignment["hushhId"] != snapshot["hushh_id"]
            or assignment["ownerHash"] != "sha256:" + hashlib.sha256(owner.encode()).hexdigest()
            or admission["workBudgetCents"] != 20000
            or admission["cleanupReserveCents"] != 5000
            or not re.fullmatch(r"[a-f0-9]{32}", attempt["attemptId"])
            or creation.get("labels") != expected_labels
            or native.get("labels") != expected_labels
            or native.get("projectId") != project
            or native.get("projectNumber") != number
            or native.get("lifecycleState") != "ACTIVE"
            or "ca" in retained_locations
            or engine_reference.search(retained)
        ):
            raise ValueError("Not a fresh managed core pilot")
        contract = provider_contract(observed_at)
        if not (
            _instant(contract["sourceLastUpdated"] + "T00:00:00Z")
            <= _instant(native["createTime"])
            <= observed_at
        ):
            raise ValueError("Project predates provider qualification")
        identity = {
            key: native[key]
            for key in ("projectId", "projectNumber", "createTime", "lifecycleState", "labels")
        }
        expected_url = f"https://ca-aiplatform.googleapis.com/v1beta1/projects/{project}/locations/ca/reasoningEngines"
        if endpoint != expected_url:
            raise ValueError("Unexpected endpoint observation")
        return {
            "providerContract": contract,
            "projectIdentity": identity,
            "endpointObservation": {"url": endpoint, "httpStatus": 404, "status": "unavailable"},
        }
    except (ValueError, TypeError, KeyError, AttributeError) as exc:
        raise ProvisionReconciliationRequired("CA Engine applicability is unverified") from exc
