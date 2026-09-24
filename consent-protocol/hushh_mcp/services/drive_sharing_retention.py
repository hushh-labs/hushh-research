"""Account erasure with minimal, owner-only evidence of external Google effects.

Call inside the existing account transaction, under that account's graph gate.
Never acquire another owner's graph gate or insert another owner's row here.
Google ACLs are not revoked by account erasure. A keyed, ownerless file fence
survives an erased uncertain write; time alone cannot prove provider absence.
"""

import json

from sqlalchemy import text

from hushh_mcp.services.drive_sharing_contract import DriveSharingCipher


def minimal_receipt(receipt):
    """Exclude old ACL snapshots and private model/request/account payloads."""
    result = {
        key: receipt[key]
        for key in ("managed", "provenance", "removed_permission_id", "other_access_may_remain")
        if key in receipt
    }
    for key, fields in {
        "issuer": ("subject", "oauthClientId"),
        "created": ("permission_id", "email", "role"),
    }.items():
        if isinstance(receipt.get(key), dict):
            result[key] = {field: receipt[key][field] for field in fields if field in receipt[key]}
    return result


def _exists(connection, table):
    return connection.execute(
        text("SELECT to_regclass(:table) IS NOT NULL"), {"table": table}
    ).scalar_one()


def erase_drive_account_in_transaction(connection, *, user_id, permanent, cipher=None):
    """No network I/O. Any failure rolls back the surrounding account cleanup."""
    params = {"user": user_id}
    has_requests = _exists(connection, "drive_share_requests")
    if has_requests and not _exists(connection, "drive_share_management_contexts"):
        raise RuntimeError("drive_retention_migration_required")
    if has_requests:
        orphaned = connection.execute(
            text("""
            SELECT EXISTS(SELECT 1 FROM drive_share_requests r
              WHERE (r.user_id=:user OR r.recipient_user_id=:user)
                AND NOT EXISTS(SELECT 1 FROM drive_share_management_contexts m
                  WHERE m.request_id=r.request_id AND m.user_id=r.user_id))
        """),
            params,
        ).scalar_one()
        if orphaned is True:
            raise RuntimeError("drive_retention_context_missing")
        cipher = cipher or DriveSharingCipher()
        contexts = list(
            connection.execute(
                text("""
            SELECT m.* FROM drive_share_management_contexts m
            WHERE m.user_id=:user OR EXISTS (
              SELECT 1 FROM drive_share_requests r WHERE r.request_id=m.request_id
                AND r.recipient_user_id=:user)
            ORDER BY m.request_id FOR UPDATE OF m
        """),
                params,
            ).mappings()
        )
        for context in contexts:
            identifiers = {"request": context["request_id"], "user": user_id}
            owns = context["user_id"] == user_id
            operations = list(
                connection.execute(
                    text("""
                SELECT * FROM drive_share_permission_operations WHERE request_id=:request
                ORDER BY operation_id FOR UPDATE
            """),
                    identifiers,
                ).mappings()
            )
            if owns:
                connection.execute(
                    text("""
                    UPDATE drive_share_file_claims f SET operation_id=NULL,erased_at=clock_timestamp()
                    FROM drive_share_permission_operations p WHERE f.operation_id=p.operation_id
                      AND p.request_id=:request AND p.state IN ('dispatching','unknown')
                """),
                    identifiers,
                )
                connection.execute(
                    text("""
                    DELETE FROM drive_share_file_claims WHERE operation_id IN
                      (SELECT operation_id FROM drive_share_permission_operations WHERE request_id=:request)
                """),
                    identifiers,
                )
                # Children first because revoke operations refer to original grants.
                connection.execute(
                    text(
                        "DELETE FROM drive_share_permission_operations WHERE request_id=:request AND kind='revoke'"
                    ),
                    identifiers,
                )
                connection.execute(
                    text("DELETE FROM drive_share_permission_operations WHERE request_id=:request"),
                    identifiers,
                )
            else:
                connection.execute(
                    text("""
                    UPDATE drive_share_management_contexts SET private_request_erased_at=clock_timestamp(),
                      revocation_revision=revocation_revision+1 WHERE request_id=:request
                """),
                    identifiers,
                )
                for item in operations:
                    row = dict(item)
                    operation_id = str(row["operation_id"])
                    # Proven unposted grants are not necessary removal evidence.
                    if row["kind"] == "grant" and row["state"] in {
                        "queued",
                        "not_dispatched",
                        "rejected",
                        "absent",
                        "preexisting",
                        "present_unattributed",
                    }:
                        connection.execute(
                            text("DELETE FROM drive_share_file_claims WHERE operation_id=:id"),
                            {"id": operation_id},
                        )
                        connection.execute(
                            text(
                                "DELETE FROM drive_share_permission_operations WHERE operation_id=:id"
                            ),
                            {"id": operation_id},
                        )
                        continue
                    plan = cipher.open(
                        row["plan_envelope"],
                        user_id=row["user_id"],
                        resource_id=operation_id,
                        purpose="permission-plan",
                    )
                    if row["kind"] == "grant":
                        plan = {
                            "file_id": plan["file_id"],
                            "file_name": "Shared file",
                            "recipient": {"email": plan["recipient"]["email"]},
                        }
                    else:
                        plan = {
                            key: plan[key]
                            for key in (
                                "file_id",
                                "permission_id",
                                "recipient_email",
                                "issuer",
                                "grant_operation_id",
                                "document_id",
                                "review_revision",
                                "file_lock_hmac",
                                "revocation_revision",
                            )
                            if key in plan
                        }
                        plan["file_name"] = "Shared file"
                    receipt = (
                        minimal_receipt(
                            cipher.open(
                                row["receipt_envelope"],
                                user_id=row["user_id"],
                                resource_id=operation_id,
                                purpose="permission-receipt",
                            )
                        )
                        if row["receipt_envelope"]
                        else None
                    )
                    connection.execute(
                        text("""
                        UPDATE drive_share_permission_operations SET plan_envelope=CAST(:plan AS jsonb),
                          receipt_envelope=CAST(:receipt AS jsonb),
                          state=CASE WHEN state='queued' THEN 'not_dispatched' ELSE state END,
                          updated_at=clock_timestamp() WHERE operation_id=:id
                    """),
                        {
                            "id": operation_id,
                            "plan": json.dumps(
                                cipher.seal(
                                    plan,
                                    user_id=row["user_id"],
                                    resource_id=operation_id,
                                    purpose="permission-plan",
                                )
                            ),
                            "receipt": json.dumps(
                                cipher.seal(
                                    receipt,
                                    user_id=row["user_id"],
                                    resource_id=operation_id,
                                    purpose="permission-receipt",
                                )
                            )
                            if receipt is not None
                            else None,
                        },
                    )
                    if row["state"] == "queued":
                        connection.execute(
                            text("DELETE FROM drive_share_file_claims WHERE operation_id=:id"),
                            {"id": operation_id},
                        )
            if _exists(connection, "feed_events"):
                connection.execute(
                    text("""
                    DELETE FROM feed_events WHERE source_domain='consent' AND source_row_id IN
                      (SELECT event_id::text FROM drive_share_events WHERE request_id=:request)
                """),
                    identifiers,
                )
            connection.execute(
                text("DELETE FROM drive_share_events WHERE request_id=:request"), identifiers
            )
            connection.execute(
                text(
                    "DELETE FROM one_action_directive_ledger WHERE channel='document_review' AND document_request_id=:request"
                ),
                identifiers,
            )
            connection.execute(
                text("DELETE FROM drive_share_reviews WHERE request_id=:request"), identifiers
            )
            if _exists(connection, "drive_share_live_sources"):
                connection.execute(
                    text("DELETE FROM drive_share_live_sources WHERE request_id=:request"),
                    identifiers,
                )
            connection.execute(
                text("DELETE FROM drive_share_requests WHERE request_id=:request"), identifiers
            )
            if owns:
                connection.execute(
                    text("DELETE FROM drive_share_management_contexts WHERE request_id=:request"),
                    identifiers,
                )
            else:
                connection.execute(
                    text("""
                    DELETE FROM drive_share_management_contexts m WHERE request_id=:request
                      AND NOT EXISTS(SELECT 1 FROM drive_share_permission_operations p WHERE p.request_id=m.request_id)
                """),
                    identifiers,
                )

    if _exists(connection, "drive_document_rules"):
        connection.execute(
            text("DELETE FROM drive_document_rules WHERE user_id=:user OR recipient_user_id=:user"),
            params,
        )
    if _exists(connection, "drive_live_preferences"):
        connection.execute(text("DELETE FROM drive_live_preferences WHERE user_id=:user"), params)

    # Explicitly remove attempts: they intentionally have no connection FK.
    if _exists(connection, "external_connector_oauth_attempts"):
        connection.execute(
            text("DELETE FROM external_connector_oauth_attempts WHERE user_id=:user"), params
        )
    if not _exists(connection, "user_external_connector_connections"):
        return
    has_versions = connection.execute(
        text("""
        SELECT EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid='user_external_connector_connections'::regclass
          AND attname='connection_generation' AND NOT attisdropped)
    """)
    ).scalar_one()
    if permanent or not has_versions:
        connection.execute(
            text("DELETE FROM user_external_connector_connections WHERE user_id=:user"), params
        )
        return
    # Reset preserves monotonic counters, not credentials, account labels or
    # selection. Recreating generation 1 could activate a stale callback.
    if _exists(connection, "drive_picker_sessions"):
        connection.execute(text("DELETE FROM drive_picker_sessions WHERE user_id=:user"), params)
    if _exists(connection, "connected_documents"):
        connection.execute(text("DELETE FROM connected_documents WHERE user_id=:user"), params)
    connection.execute(
        text("""
        UPDATE user_external_connector_connections SET status='revoked',
          connection_generation=connection_generation+1,credential_version=credential_version+1,
          credential_ciphertext=NULL,credential_iv=NULL,credential_tag=NULL,credential_algorithm=NULL,
          credential_expires_at=NULL,pending_attempt_id=NULL,refresh_lease_id=NULL,refresh_lease_expires_at=NULL,
          validation_state='unverified',verified_policy_hash=NULL,verified_at=NULL,
          revocation_outcome='not_attempted',revocation_pending_until=NULL,
          connected_account_label=NULL,last_error_code=NULL,connected_at=NULL,
          last_used_at=NULL,revoked_at=clock_timestamp(),updated_at=clock_timestamp()
        WHERE user_id=:user
    """),
        params,
    )
