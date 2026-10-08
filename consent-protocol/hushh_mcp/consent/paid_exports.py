"""Owner-encrypted paid export validation and atomic canonical publication.

The fixed lease's authenticated expiry is never rewritten. Source revisions,
recipient binding and current consent authority are rechecked before publication.
"""

from __future__ import annotations

import base64
import json
from typing import Any

from hushh_mcp.consent.export_envelope import (
    ConsentExportEnvelopeSubmissionV2,
    enforce_raw_byte_limit,
    validate_export_envelope_submission,
)
from hushh_mcp.consent.paid_admission import _request_lock


async def verify_source_revisions(
    conn: Any,
    owner_user_id: str,
    machine_scope: str,
    revisions: dict,
) -> None:
    """Share the PKM mutation lock: stale encryption can never publish as current."""
    domain = machine_scope.split(".")[1]
    content = revisions.get("contentRevision", revisions.get("content_revision"))
    manifest = revisions.get("manifestRevision", revisions.get("manifest_revision"))
    if not isinstance(content, int) or not isinstance(manifest, int) or min(content, manifest) < 1:
        raise ValueError("source_revision_required")
    await conn.execute(
        "SELECT pg_advisory_xact_lock(hashtextextended($1,0))", owner_user_id + ":" + domain
    )
    header = await conn.fetchrow(
        "SELECT manifest_version FROM pkm_manifests WHERE user_id=$1 AND domain=$2 FOR SHARE",
        owner_user_id,
        domain,
    )
    blobs = await conn.fetch(
        "SELECT content_revision,manifest_revision FROM pkm_blobs WHERE user_id=$1 AND domain=$2 FOR SHARE",
        owner_user_id,
        domain,
    )
    if (
        not header
        or header["manifest_version"] != manifest
        or not blobs
        or any(
            row["content_revision"] != content or row["manifest_revision"] != manifest
            for row in blobs
        )
    ):
        raise ValueError("source_revision_changed")


def _require_base64(value: Any, size: int) -> str:
    if not isinstance(value, str):
        raise ValueError("invalid_encrypted_package")
    try:
        if len(base64.b64decode(value, validate=True)) != size:
            raise ValueError("invalid_encrypted_package")
    except (ValueError, TypeError):
        raise ValueError("invalid_encrypted_package") from None
    return value


async def finalize_paid_export(conn: Any, purchase: dict) -> dict:
    """Called inside the commercial stage transaction before money is consumed."""
    from hushh_mcp.services.consent_db import ConsentDBService
    from hushh_mcp.services.scope_commerce_requests import (
        resolve_commerce_request,
        validate_tariff_scope,
    )

    await _request_lock(conn, str(purchase["request_id"]))
    binding = await resolve_commerce_request(
        str(purchase["request_id"]), str(purchase["owner_user_id"]), connection=conn
    )
    if binding["consent_action"] not in {
        "CONSENT_PAID_APPROVED",
        "CONSENT_PAID_FUNDED",
        "approved",
    } or any(
        str(binding.get(key) or "") != str(purchase.get(key) or "")
        for key in (
            "owner_user_id",
            "payer_user_id",
            "buyer_app_id",
            "machine_scope",
            "scope_handle",
            "recipient_key_fingerprint",
        )
    ):
        raise ValueError("consent_authority_changed")
    package, envelope, wrapped, expires_at_ms = _validated_package(purchase, binding)
    revisions = package.get("sourceRevisions") or purchase.get("source_revisions") or {}
    await verify_source_revisions(
        conn, binding["owner_user_id"], binding["machine_scope"], revisions
    )
    await validate_tariff_scope(
        binding["owner_user_id"], binding["scope_handle"], binding["machine_scope"]
    )
    token = await _store_canonical_export(
        conn, binding, package, envelope, wrapped, revisions, expires_at_ms
    )
    service = ConsentDBService()
    metadata = {
        **binding["metadata"],
        "commercial_required": True,
        "commerce_purchase_id": str(purchase["purchase_id"]),
        "activation_at_ms": int(purchase["activation_at"].timestamp() * 1000),
        "commerce_status": "armed",
        "request_id": binding["request_id"],
    }
    if binding["metadata"].get("request_source") == "marketplace":
        await conn.execute(
            "UPDATE marketplace_access_requests SET metadata=$2::jsonb WHERE id::text=$1 AND status='approved'",
            binding["request_id"],
            json.dumps(metadata),
        )
    await service.insert_event(
        user_id=binding["owner_user_id"],
        agent_id=binding["agent_id"],
        scope=binding["machine_scope"],
        action="CONSENT_GRANTED",
        token_id=token.token,
        request_id=binding["request_id"],
        expires_at=expires_at_ms,
        metadata=metadata,
        connection=conn,
    )
    return {"consent_token": token.token}


def _validated_package(
    purchase: dict, binding: dict
) -> tuple[dict, ConsentExportEnvelopeSubmissionV2, dict, int]:
    package = purchase.get("staged_export") or purchase.get("stagedExport") or {}
    envelope = ConsentExportEnvelopeSubmissionV2.model_validate(package.get("exportEnvelope"))
    expires_at = purchase["expires_at"]
    expires_at_ms = int(expires_at.timestamp() * 1000)
    ciphertext = package.get("ciphertext")
    validate_export_envelope_submission(
        envelope=envelope,
        encrypted_data=ciphertext,
        expected_app_id=binding["buyer_app_id"],
        expected_grant_id=binding["request_id"],
        expected_revision=1,
        expected_scope=binding["machine_scope"],
        expected_scope_handle=binding["scope_handle"],
        expected_recipient_fingerprint=binding["recipient_key_fingerprint"],
        expected_expires_at_ms=expires_at_ms,
    )
    if envelope.export_id != str(purchase["export_id"]):
        raise ValueError("export_identity_changed")
    enforce_raw_byte_limit(envelope.ciphertext_bytes, 16 * 1024 * 1024)
    wrapped = package.get("wrappedKey") or {}
    if (
        wrapped.get("connector_key_id") != binding["connector_key_id"]
        or wrapped.get("wrapping_alg") != "X25519-AES256-GCM"
    ):
        raise ValueError("recipient_key_changed")
    for key, size in (
        ("wrapped_export_key", 32),
        ("wrapped_key_iv", 12),
        ("wrapped_key_tag", 16),
        ("sender_public_key", 32),
    ):
        _require_base64(wrapped.get(key), size)
    _require_base64(package.get("iv"), 12)
    _require_base64(package.get("tag"), 16)
    return package, envelope, wrapped, expires_at_ms


async def _store_canonical_export(
    conn: Any,
    binding: dict,
    package: dict,
    envelope: ConsentExportEnvelopeSubmissionV2,
    wrapped: dict,
    revisions: dict,
    expires_at_ms: int,
) -> Any:
    from hushh_mcp.consent.token import issue_token
    from hushh_mcp.services.consent_db import ConsentDBService

    token = issue_token(
        user_id=binding["owner_user_id"],
        agent_id=binding["agent_id"],
        scope=binding["machine_scope"],
        expires_at_ms=expires_at_ms,
    )
    service = ConsentDBService()
    stored = await service.store_consent_export(
        consent_token=token.token,
        user_id=binding["owner_user_id"],
        encrypted_data=package["ciphertext"],
        iv=package["iv"],
        tag=package["tag"],
        export_key=None,
        wrapped_key_bundle=wrapped,
        scope=binding["machine_scope"],
        expires_at_ms=expires_at_ms,
        source_content_revision=revisions.get("contentRevision"),
        source_manifest_revision=revisions.get("manifestRevision"),
        refresh_policy=binding["refresh_policy"],
        export_id=envelope.export_id,
        envelope_version=2,
        grant_id=binding["request_id"],
        app_id=binding["buyer_app_id"],
        scope_handle=binding["scope_handle"],
        recipient_key_fingerprint=binding["recipient_key_fingerprint"],
        envelope_aad=envelope.aad.model_dump(mode="json"),
        envelope_aad_sha256=envelope.aad_sha256,
        ciphertext_sha256=envelope.ciphertext_sha256,
        ciphertext_bytes=envelope.ciphertext_bytes,
        connection=conn,
    )
    if not stored:
        raise ValueError("export_storage_failed")
    return token


async def export_is_admitted(service: Any, export: dict[str, Any]) -> bool:
    """All export lookups share signature, exact grant and paid admission."""
    from hushh_mcp.consent.token import validate_token_with_db

    valid, _, token = await validate_token_with_db(str(export.get("consent_token") or ""))
    if not (valid and token and str(token.user_id) == str(export.get("user_id"))):
        return False
    from hushh_mcp.services.consent_commerce_ports import token_grant

    grant = await token_grant(service._get_db(), str(export.get("consent_token")))
    metadata = service._parse_metadata(grant.get("metadata")) if grant else {}
    from hushh_mcp.consent.paid_admission import is_paid_grant, paid_grant_is_admitted

    if is_paid_grant(metadata):
        from db.connection import get_pool
        from hushh_mcp.services.scope_commerce.service import COMMERCE_GATE

        pool = await get_pool()
        async with pool.acquire() as conn, conn.transaction():
            await conn.execute("SELECT pg_advisory_xact_lock($1)", COMMERCE_GATE)
            if not await paid_grant_is_admitted(
                str(export["consent_token"]), metadata, connection=conn
            ):
                return False
            current = await conn.fetchrow(
                "SELECT * FROM consent_exports WHERE consent_token=$1 AND expires_at>clock_timestamp()",
                export["consent_token"],
            )
            if not current:
                return False
            export.clear()
            export.update(service._normalize_export_row(dict(current)))
    export["_grant_metadata"] = metadata
    return True


async def complete_paid_refresh(params: dict, grant_metadata: dict) -> bool:
    """Fence current authority and source before the owning lease/revision CAS."""
    from uuid import UUID

    from db.connection import get_pool
    from hushh_mcp.consent.paid_admission import paid_grant_is_admitted
    from hushh_mcp.services.consent_commerce_ports import complete_refresh
    from hushh_mcp.services.scope_commerce.service import COMMERCE_GATE

    pool = await get_pool()
    async with pool.acquire() as conn, conn.transaction():
        await conn.execute("SELECT pg_advisory_xact_lock($1)", COMMERCE_GATE)
        await _request_lock(conn, str(params["p_envelope_aad"]["grant_id"]))
        job = await conn.fetchrow(
            "SELECT consent_token FROM consent_export_refresh_jobs WHERE user_id=$1 AND claim_id=$2 AND status='processing'",
            params["p_user_id"],
            UUID(params["p_claim_id"]),
        )
        if not job or not await paid_grant_is_admitted(
            str(job["consent_token"]), grant_metadata, connection=conn
        ):
            return False
        await verify_source_revisions(
            conn,
            params["p_user_id"],
            str(params["p_envelope_aad"]["machine_scope"]),
            {
                "contentRevision": params["p_source_content_revision"],
                "manifestRevision": params["p_source_manifest_revision"],
            },
        )
        # The owning RPC retains original expiry and revision/lease CAS.
        return await complete_refresh(conn, params)


async def revoke_paid_export(db: Any, token: str) -> None:
    """Close paid financial authority before legacy export deletion proceeds."""
    from hushh_mcp.consent.paid_admission import _metadata, is_paid_grant
    from hushh_mcp.services.consent_commerce_ports import token_grant
    from hushh_mcp.services.scope_commerce.service import ScopeCommerceService

    grant = await token_grant(db, token)
    metadata = _metadata(grant.get("metadata")) if grant else {}
    if is_paid_grant(metadata):
        await ScopeCommerceService().revoke_purchase(
            owner_user_id=str(grant["user_id"]),
            purchase_id=str(metadata["commerce_purchase_id"]),
        )
