"""Consent HTTP adapters for inactive paid approval and leased export refresh.

The route supplies its authenticated owner and canonical request/export context;
all authority remains in the existing consent and commercial service facades.
"""

from __future__ import annotations

from typing import Any

from fastapi import HTTPException


def is_developer_information_requester(metadata: Any, connector_public_key: Any) -> bool:
    return bool(
        connector_public_key
        or (
            isinstance(metadata, dict)
            and (
                metadata.get("request_source") == "developer_api_v1"
                or metadata.get("requester_actor_type") == "developer"
            )
        )
    )


async def paid_owner_approval(
    owner_user_id: str, request_id: str, machine_scope: str, metadata: Any, expiry_hours: int
) -> dict | None:
    from hushh_mcp.consent.paid_admission import maybe_approve_paid_request

    try:
        result = await maybe_approve_paid_request(
            owner_user_id=owner_user_id,
            request_id=request_id,
            machine_scope=machine_scope,
            metadata=metadata if isinstance(metadata, dict) else {},
            duration_seconds=expiry_hours * 3600,
        )
        if result is not None and not isinstance(result, dict):
            raise ValueError("invalid_paid_approval_result")
        return result
    except (ValueError, PermissionError) as exc:
        raise HTTPException(409, detail={"error_code": "PAID_APPROVAL_UNAVAILABLE"}) from exc


async def commit_refreshed_export(
    service: Any,
    submission: Any,
    prior_revision: int,
    wrapped_key_bundle: dict,
    existing_export: dict,
) -> bool:
    result = await service.complete_claimed_consent_export_refresh(
        user_id=submission.userId,
        claim_id=submission.jobClaimId,
        expected_export_revision=prior_revision,
        encrypted_data=submission.encryptedData,
        iv=submission.encryptedIv,
        tag=submission.encryptedTag,
        wrapped_key_bundle=wrapped_key_bundle,
        connector_key_id=wrapped_key_bundle.get("connector_key_id"),
        connector_wrapping_alg=str(wrapped_key_bundle.get("wrapping_alg") or ""),
        envelope_aad=submission.exportEnvelope.aad.model_dump(mode="json"),
        envelope_aad_sha256=submission.exportEnvelope.aad_sha256,
        ciphertext_sha256=submission.exportEnvelope.ciphertext_sha256,
        ciphertext_bytes=submission.exportEnvelope.ciphertext_bytes,
        source_content_revision=submission.sourceContentRevision,
        source_manifest_revision=submission.sourceManifestRevision,
        grant_metadata=existing_export.get("_grant_metadata"),
    )
    if not isinstance(result, bool):
        raise ValueError("invalid_export_commit_result")
    return result
