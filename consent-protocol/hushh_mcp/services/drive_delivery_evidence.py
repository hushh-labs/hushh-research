"""Validate source provenance without interpreting document relevance."""

from hushh_mcp.services.google_drive_adapter import DriveReadError


def require_delivery_evidence(file, *, user_id, generation):
    if "discoveryEvidence" in file:
        from hushh_mcp.services.drive_request_discovery import discovery_evidence_matches

        if not discovery_evidence_matches(file, user_id=user_id, generation=generation):
            raise DriveReadError("source_changed")
    if file.get("contentVerified") is True:
        from hushh_mcp.services.drive_request_candidate_assessment import (
            verified_evidence_matches,
        )

        evidence = file.get("requestEvidence", {})
        if not verified_evidence_matches(
            evidence,
            user_id=user_id,
            request_id=evidence.get("request_id"),
            request_revision=evidence.get("request_revision"),
            connection_generation=generation,
            plan_digest=evidence.get("plan_digest"),
            metadata=file,
            policy_version=evidence.get("assessment_policy_version"),
        ):
            raise DriveReadError("source_changed")


def metadata_only_delivery(file):
    return (
        file.get("metadataOnly") is True
        and file.get("fingerprintBasis") == "provider_metadata"
        and file.get("discoveryEvidence") is not None
    ) or not bool(file.get("packageDigest") or file.get("contentVerified"))
