"""Current owner-item authority around the existing refresh lease/revision CAS."""

from __future__ import annotations

import json
from uuid import UUID

from hushh_mcp.consent.export_envelope import (
    ConsentExportEnvelopeSubmissionV2,
    validate_export_envelope_submission,
)


async def complete_owner_item_refresh(params: dict, grant_metadata: dict | None) -> bool:
    from db.connection import get_pool
    from hushh_mcp.consent.paid_admission import _request_lock, verify_source_revisions
    from hushh_mcp.consent.token import validate_token
    from hushh_mcp.services.consent_commerce_ports import complete_refresh
    from hushh_mcp.services.consent_export_storage import normalized_export_identity
    from hushh_mcp.services.owner_item_grants import require_owner_item_binding

    aad = params["p_envelope_aad"]
    pool = await get_pool()
    async with pool.acquire() as conn, conn.transaction():
        await _request_lock(conn, str(aad["grant_id"]))
        row = await conn.fetchrow(
            """SELECT e.*,a.action,a.token_id,a.agent_id,a.metadata
               FROM consent_export_refresh_jobs j JOIN consent_exports e
                 ON e.consent_token=j.consent_token AND e.user_id=j.user_id
               JOIN LATERAL (SELECT action,token_id,agent_id,metadata FROM consent_audit
                 WHERE request_id=e.grant_id AND user_id=e.user_id
                 ORDER BY issued_at DESC,id DESC LIMIT 1) a ON TRUE
               WHERE j.user_id=$1 AND j.claim_id=$2 AND j.status='processing'
                 AND j.claim_expires_at>clock_timestamp() AND e.expires_at>clock_timestamp()""",
            params["p_user_id"],
            UUID(params["p_claim_id"]),
        )
        if not row or row["action"] != "CONSENT_GRANTED" or row["token_id"] != row["consent_token"]:
            return False
        metadata = row["metadata"]
        if isinstance(metadata, str):
            metadata = json.loads(metadata)
        valid, _, token = validate_token(row["consent_token"])
        if (
            not valid
            or token is None
            or str(token.user_id) != row["user_id"]
            or str(token.agent_id) != row["agent_id"]
            or token.scope_str != row["scope"]
            or not isinstance(metadata, dict)
            or metadata != grant_metadata
            or row["refresh_policy"] != "continuous_until_expiry"
            or params["p_connector_key_id"] != row["connector_key_id"]
            or params["p_connector_wrapping_alg"] != row["connector_wrapping_alg"]
        ):
            return False
        try:
            # The original source is stale by definition; the new source is
            # checked below under the same PKM mutation lock as publication.
            await require_owner_item_binding(
                conn, row["user_id"], row["scope"], metadata, verify_source=False
            )
            prior_aad = row["envelope_aad"]
            if isinstance(prior_aad, str):
                prior_aad = json.loads(prior_aad)
            export_id = normalized_export_identity(dict(row), prior_aad)
            envelope = ConsentExportEnvelopeSubmissionV2.model_validate(
                {
                    "version": 2,
                    "export_id": export_id,
                    "aad": aad,
                    "aad_sha256": params["p_envelope_aad_sha256"],
                    "ciphertext_sha256": params["p_ciphertext_sha256"],
                    "ciphertext_bytes": params["p_ciphertext_bytes"],
                }
            )
            if envelope.ciphertext_bytes > 65536:
                return False
            validate_export_envelope_submission(
                envelope=envelope,
                encrypted_data=params["p_encrypted_data"],
                expected_app_id=row["app_id"],
                expected_grant_id=row["grant_id"],
                expected_revision=params["p_expected_export_revision"] + 1,
                expected_scope=row["scope"],
                expected_scope_handle=row["scope_handle"],
                expected_recipient_fingerprint=row["recipient_key_fingerprint"],
                expected_expires_at_ms=int(row["expires_at"].timestamp() * 1000),
                expected_export_id=export_id,
            )
            await verify_source_revisions(
                conn,
                row["user_id"],
                row["scope"],
                {
                    "contentRevision": params["p_source_content_revision"],
                    "manifestRevision": params["p_source_manifest_revision"],
                },
            )
        except ValueError:
            return False
        # Free consent keeps latest-per-agent/scope semantics across requests.
        # The PKM lock above also serializes owner-item grant/terminal commits.
        latest_token = await conn.fetchval(
            """SELECT token_id FROM consent_audit WHERE user_id=$1 AND agent_id=$2
               AND scope=$3 AND action IN ('CONSENT_GRANTED','REVOKED','CONSENT_DENIED')
               ORDER BY issued_at DESC,id DESC LIMIT 1""",
            row["user_id"],
            row["agent_id"],
            row["scope"],
        )
        if latest_token != row["consent_token"]:
            return False
        return await complete_refresh(conn, params)
