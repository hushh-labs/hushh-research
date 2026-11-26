"""One admission check for exact owner-item exports across all read surfaces."""

from __future__ import annotations

import time
from typing import Any

from hushh_mcp.consent.export_envelope import (
    ConsentExportEnvelopeSubmissionV2,
    validate_export_envelope_submission,
)


async def owner_item_export_is_admitted(
    export: dict[str, Any], token, metadata: dict, *, allow_stale_source: bool = False
) -> bool:
    """A scope spelling alone never activates a free credential grant.

    The existing owner-item issuer owns recipient resolution and source locking.
    Refresh uses the same grant and original expiry, with current export source
    revisions; it never changes the approved item, recipient or expiry ceiling.
    """
    from db.connection import get_pool
    from hushh_mcp.consent.pkm_scope_policy import consent_token_scope_value
    from hushh_mcp.services.owner_item_grants import (
        owner_item_binding,
        require_owner_item_binding,
    )

    try:
        owner_id = str(token.user_id)
        scope = consent_token_scope_value(token)
        binding = owner_item_binding(metadata, owner_id, scope)
        app_id = str(metadata["developer_app_id"])
        agent_id = str(metadata.get("recipient_agent_id") or "agent_one")
        if (
            str(token.agent_id) != agent_id
            or export.get("user_id") != owner_id
            or export.get("scope") != scope
            or export.get("app_id") != app_id
            or export.get("is_strict_zero_knowledge") is not True
            or export.get("envelope_version") != 2
            or export.get("connector_key_id") != metadata.get("connector_key_id")
            or export.get("recipient_key_fingerprint") != metadata.get("recipient_key_fingerprint")
        ):
            return False
        envelope = ConsentExportEnvelopeSubmissionV2.model_validate(
            {
                "version": 2,
                "export_id": export["export_id"],
                "aad": export["envelope_aad"],
                "aad_sha256": export["envelope_aad_sha256"],
                "ciphertext_sha256": export["ciphertext_sha256"],
                "ciphertext_bytes": export["ciphertext_bytes"],
            }
        )
        if (
            not time.time() * 1000 < envelope.aad.expires_at_ms <= token.expires_at
            or envelope.ciphertext_bytes > 65536
        ):
            return False
        validate_export_envelope_submission(
            envelope=envelope,
            encrypted_data=export["encrypted_data"],
            expected_app_id=app_id,
            expected_grant_id=str(export["grant_id"]),
            expected_revision=export["export_revision"],
            expected_scope=scope,
            expected_scope_handle=metadata["scope_handle"],
            expected_recipient_fingerprint=metadata["recipient_key_fingerprint"],
        )
        if export["export_revision"] == 1 and (
            export.get("source_content_revision"),
            export.get("source_manifest_revision"),
        ) != (binding["source_content_revision"], binding["source_manifest_revision"]):
            return False
        pool = await get_pool()
        async with pool.acquire() as conn, conn.transaction():
            await require_owner_item_binding(conn, owner_id, scope, metadata, verify_source=False)
            if not allow_stale_source:
                from hushh_mcp.consent.paid_admission import verify_source_revisions

                await verify_source_revisions(
                    conn,
                    owner_id,
                    scope,
                    {
                        "contentRevision": export["source_content_revision"],
                        "manifestRevision": export["source_manifest_revision"],
                    },
                )
        return True
    except Exception:
        return False
