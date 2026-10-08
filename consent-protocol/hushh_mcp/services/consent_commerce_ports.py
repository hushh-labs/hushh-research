"""Canonical consent persistence ports used by the existing facade.

These adapters accept server-resolved context and a caller-owned transaction;
they never decide scope, price, recipient authority or usable paid admission.
Legacy free persistence remains behind ConsentDBService's established facade.
"""

from __future__ import annotations

import asyncio
import hashlib
import json
import logging
from datetime import datetime, timezone
from typing import Any

from asyncpg import UndefinedTableError

UPSERT_EXPORT_V2 = """INSERT INTO consent_exports(
                         consent_token,user_id,encrypted_data,iv,tag,export_key,wrapped_key_bundle,
                         connector_key_id,connector_wrapping_alg,export_revision,export_generated_at,
                         source_content_revision,source_manifest_revision,refresh_status,refresh_policy,
                         envelope_version,grant_id,app_id,scope_handle,recipient_key_fingerprint,
                         payload_algorithm,envelope_aad,envelope_aad_sha256,ciphertext_sha256,
                         ciphertext_bytes,scope,expires_at,export_id)
                       VALUES($1,$2,$3,$4,$5,NULL,$6::jsonb,$7,$8,$9,$10,$11,$12,$13,$14,
                         $15,$16,$17,$18,$19,$20,$21::jsonb,$22,$23,$24,$25,$26,$27::uuid)
                       ON CONFLICT(consent_token) DO UPDATE SET
                         user_id=EXCLUDED.user_id,encrypted_data=EXCLUDED.encrypted_data,
                         iv=EXCLUDED.iv,tag=EXCLUDED.tag,export_key=NULL,
                         wrapped_key_bundle=EXCLUDED.wrapped_key_bundle,
                         connector_key_id=EXCLUDED.connector_key_id,
                         connector_wrapping_alg=EXCLUDED.connector_wrapping_alg,
                         export_revision=EXCLUDED.export_revision,
                         export_generated_at=EXCLUDED.export_generated_at,
                         source_content_revision=EXCLUDED.source_content_revision,
                         source_manifest_revision=EXCLUDED.source_manifest_revision,
                         refresh_status=EXCLUDED.refresh_status,refresh_policy=EXCLUDED.refresh_policy,
                         envelope_version=EXCLUDED.envelope_version,grant_id=EXCLUDED.grant_id,
                         app_id=EXCLUDED.app_id,scope_handle=EXCLUDED.scope_handle,
                         recipient_key_fingerprint=EXCLUDED.recipient_key_fingerprint,
                         payload_algorithm=EXCLUDED.payload_algorithm,envelope_aad=EXCLUDED.envelope_aad,
                         envelope_aad_sha256=EXCLUDED.envelope_aad_sha256,
                         ciphertext_sha256=EXCLUDED.ciphertext_sha256,
                         ciphertext_bytes=EXCLUDED.ciphertext_bytes,scope=EXCLUDED.scope,
                         expires_at=EXCLUDED.expires_at,export_id=EXCLUDED.export_id"""


STAGED_REFRESH_CANDIDATES = """SELECT e.consent_token,e.scope,e.expires_at,e.scope_handle,
                             e.envelope_version,e.refresh_policy,p.consent_token_hash,
                             (NULLIF(e.wrapped_key_bundle->>'wrapped_export_key','') IS NOT NULL
                               AND e.export_key IS NULL)
                               AS is_strict_zero_knowledge
                           FROM scope_commerce_purchases p JOIN consent_exports e
                             ON e.grant_id=p.request_id AND e.user_id=p.owner_user_id
                            AND e.scope=p.machine_scope AND e.scope_handle=p.scope_handle
                            AND e.app_id=p.buyer_app_id
                            AND replace(e.export_id::text,'-','')=replace(p.export_id,'-','')
                            AND e.recipient_key_fingerprint=p.recipient_key_fingerprint
                            AND e.expires_at=p.expires_at
                           WHERE p.owner_user_id=$1 AND split_part(p.machine_scope,'.',2)=$2
                             AND p.status='staged' AND p.erased_at IS NULL
                             AND p.activation_at>clock_timestamp()
                             AND p.expires_at>clock_timestamp() AND e.envelope_version=2
                             AND e.refresh_policy='continuous_until_expiry'
                             AND EXISTS(SELECT 1 FROM consent_audit a WHERE
                               a.token_id=e.consent_token AND a.request_id=p.request_id
                               AND a.user_id=p.owner_user_id AND a.scope=p.machine_scope
                               AND a.action='CONSENT_GRANTED'
                               AND a.metadata->>'commerce_purchase_id'=p.purchase_id::text
                               AND a.metadata->>'commercial_required'='true')"""


def _export_values(row: dict) -> tuple:
    return (
        row["consent_token"],
        row["user_id"],
        row["encrypted_data"],
        row["iv"],
        row["tag"],
        json.dumps(row["wrapped_key_bundle"]),
        row["connector_key_id"],
        row["connector_wrapping_alg"],
        row["export_revision"],
        datetime.fromisoformat(str(row["export_generated_at"]).replace("Z", "+00:00")),
        row["source_content_revision"],
        row["source_manifest_revision"],
        row["refresh_status"],
        row["refresh_policy"],
        row["envelope_version"],
        row["grant_id"],
        row["app_id"],
        row["scope_handle"],
        row["recipient_key_fingerprint"],
        row["payload_algorithm"],
        json.dumps(row["envelope_aad"]),
        row["envelope_aad_sha256"],
        row["ciphertext_sha256"],
        row["ciphertext_bytes"],
        row["scope"],
        datetime.fromisoformat(row["expires_at"]),
        row["export_id"],
    )


async def store_export(conn: Any, row: dict) -> bool:
    if row["envelope_version"] != 2 or not row.get("export_id"):
        raise ValueError("transactional_export_requires_envelope_v2")
    await conn.execute(UPSERT_EXPORT_V2, *_export_values(row))
    return True


async def insert_consent_event(conn: Any, event: dict) -> int:
    issued_at = int(datetime.now(timezone.utc).timestamp() * 1000)
    prior = await conn.fetchval(
        "SELECT MAX(issued_at) FROM consent_audit WHERE request_id=$1", event.get("request_id")
    )
    issued_at = max(issued_at, int(prior or 0) + 1)
    return int(
        await conn.fetchval(
            """INSERT INTO consent_audit
           (user_id,agent_id,scope,action,token_id,request_id,scope_description,
            issued_at,expires_at,poll_timeout_at,metadata)
           VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb) RETURNING id""",
            event["user_id"],
            event["agent_id"],
            event["scope"],
            event["action"],
            event.get("token_id") or f"evt_{issued_at}",
            event.get("request_id"),
            event.get("scope_description"),
            issued_at,
            event.get("expires_at"),
            event.get("poll_timeout_at"),
            json.dumps(event.get("metadata") or {}),
        )
    )


async def commit_free_event(service: Any, event: dict, validator: Any) -> int | None:
    """The caller supplies the sole tariff/admission policy; commit is atomic."""
    from db.connection import get_pool
    from hushh_mcp.services.consent_event_authority import append_event_receipt

    pool = await get_pool()
    if pool.__class__.__module__.startswith("db.offline"):
        async with pool.acquire() as conn:
            present = await conn.fetchval(
                "SELECT name FROM sqlite_master WHERE type='table' AND name='scope_commerce_tariffs'"
            )
        if present:
            raise PermissionError("offline_paid_authority_unavailable")
        return None
    async with pool.acquire() as conn, conn.transaction():
        await validator(conn, event["user_id"], event["scope"])
        event_id = await service.insert_event(**event, connection=conn)
        issued_at = await conn.fetchval("SELECT issued_at FROM consent_audit WHERE id=$1", event_id)
    await append_event_receipt(
        {
            "user_id": event["user_id"],
            "agent_id": event["agent_id"],
            "scope": event["scope"],
            "action": event["action"],
            "token_id": event.get("token_id") or "",
            "request_id": event.get("request_id"),
            "metadata": json.dumps(event.get("metadata") or {}),
        },
        issued_at=int(issued_at),
        event_id=event_id,
    )
    return event_id


async def staged_refresh_candidates(pool: Any, owner_user_id: str, domain: str) -> list[dict]:
    """Private queue inputs, never a buyer grant or public export projection."""
    if pool.__class__.__module__.startswith("db.offline"):
        return []
    async with pool.acquire() as conn:
        try:
            async with conn.transaction():
                rows = await conn.fetch(STAGED_REFRESH_CANDIDATES, owner_user_id, domain)
        except UndefinedTableError:
            return []
    result = []
    for row in rows:
        token = str(row["consent_token"])
        if hashlib.sha256(token.encode()).hexdigest() != row["consent_token_hash"]:
            continue
        result.append(
            {
                "token_id": token,
                "scope": row["scope"],
                "expires_at": int(row["expires_at"].timestamp() * 1000),
                "_refresh_metadata": {
                    key: row[key]
                    for key in (
                        "scope_handle",
                        "envelope_version",
                        "refresh_policy",
                        "is_strict_zero_knowledge",
                    )
                },
            }
        )
    return result


async def complete_refresh(conn: Any, params: dict) -> bool:
    """Existing canonical refresh RPC, bound to the caller-owned transaction."""
    from uuid import UUID

    return bool(
        await conn.fetchval(
            "SELECT complete_consent_export_refresh_v2($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9,$10::jsonb,$11,$12,$13,$14,$15)",
            params["p_user_id"],
            UUID(params["p_claim_id"]),
            params["p_expected_export_revision"],
            params["p_encrypted_data"],
            params["p_iv"],
            params["p_tag"],
            json.dumps(params["p_wrapped_key_bundle"]),
            params["p_connector_key_id"],
            params["p_connector_wrapping_alg"],
            json.dumps(params["p_envelope_aad"]),
            params["p_envelope_aad_sha256"],
            params["p_ciphertext_sha256"],
            params["p_ciphertext_bytes"],
            params["p_source_content_revision"],
            params["p_source_manifest_revision"],
        )
    )


async def exact_scope_grant(
    db: Any, user_id: str, scope: str, agent_id: str | None, token: str
) -> dict | None:
    rows = await asyncio.to_thread(
        lambda: (
            db.table("consent_audit")
            .select("metadata,expires_at")
            .eq("user_id", user_id)
            .eq("agent_id", agent_id)
            .eq("scope", scope)
            .eq("token_id", token)
            .eq("action", "CONSENT_GRANTED")
            .order("issued_at", desc=True)
            .limit(1)
            .execute()
            .data
            or []
        )
    )
    return rows[0] if rows else None


async def token_grant(db: Any, token: str) -> dict | None:
    rows = await asyncio.to_thread(
        lambda: (
            db.table("consent_audit")
            .select("user_id,metadata")
            .eq("token_id", token)
            .eq("action", "CONSENT_GRANTED")
            .order("issued_at", desc=True)
            .limit(1)
            .execute()
            .data
            or []
        )
    )
    return rows[0] if rows else None


async def free_scope_lineage(db: Any, user_id: str, scope: str, agent_id: str | None) -> list[dict]:
    response = await asyncio.to_thread(
        db.execute_raw,
        """SELECT action,expires_at,issued_at,token_id,metadata FROM consent_audit AS event
           WHERE user_id=:user_id AND scope=:scope
             AND (:agent_id IS NULL OR agent_id=:agent_id)
             AND action IN ('CONSENT_GRANTED','REVOKED')
             AND COALESCE(metadata->>'commercial_required','false') <> 'true'
             AND NOT EXISTS (SELECT 1 FROM consent_audit AS paid
                 WHERE paid.request_id=event.request_id AND paid.action='CONSENT_GRANTED'
                   AND paid.metadata->>'commercial_required'='true')
           ORDER BY issued_at DESC,id DESC LIMIT 1""",
        {"user_id": user_id, "scope": scope, "agent_id": agent_id},
    )
    return response.data or []


async def append_external_event(service: Any, event: dict, connection: Any = None) -> int:
    from hushh_mcp.consent.paid_admission import is_paid_grant, validate_free_grant_commit

    if (
        connection is None
        and event["action"] == "CONSENT_GRANTED"
        and event["scope"].startswith("attr.")
        and event["request_id"]
        and not is_paid_grant(event["metadata"])
    ):
        event_id = await commit_free_event(service, event, validate_free_grant_commit)
        if event_id is not None:
            return event_id
    if connection is not None:
        return await insert_consent_event(connection, event)
    return await _append_legacy_event(service, event)


async def _append_legacy_event(service: Any, event: dict) -> int:
    from hushh_mcp.services.consent_event_authority import (
        append_event_receipt,
        persist_external_event,
    )

    logger = logging.getLogger(__name__)
    db = service._get_db()
    issued_at = int(datetime.now(tz=timezone.utc).timestamp() * 1000)
    event["token_id"] = event["token_id"] or f"evt_{issued_at}"
    metadata_json = json.dumps(event["metadata"]) if event["metadata"] else None
    data = {
        "token_id": event["token_id"],
        "user_id": event["user_id"],
        "agent_id": event["agent_id"],
        "scope": event["scope"],
        "action": event["action"],
        "request_id": event["request_id"],
        "scope_description": event["scope_description"],
        "issued_at": issued_at,
        "expires_at": event["expires_at"],
        "poll_timeout_at": event["poll_timeout_at"],
        "metadata": metadata_json,
    }
    data = {k: v for k, v in data.items() if v is not None}
    response = await persist_external_event(db, data, event["metadata"])
    if response.data and len(response.data) > 0:
        event_id = response.data[0].get("id")
        persisted_issued_at = response.data[0].get("issued_at")
        if isinstance(persisted_issued_at, int):
            issued_at = persisted_issued_at
        audit_event_id = int(event_id) if isinstance(event_id, int) else None
        logger.info(f"Inserted {event['action']} event: {event_id}")
    else:
        logger.warning(
            f"Inserted {event['action']} event but no ID returned, using issued_at: {issued_at}"
        )
        event_id = issued_at
        audit_event_id = None
    await append_event_receipt(data, issued_at=issued_at, event_id=audit_event_id)
    return event_id


async def _internal_lineage_rows(
    service: Any, user_id: str, scope: str, agent_id: str | None
) -> list[dict]:
    from db.db_client import DatabaseExecutionError

    logger = logging.getLogger(__name__)
    try:
        db = service._get_db()
        query = (
            db.table("internal_access_events")
            .select("action,expires_at,issued_at,token_id,metadata")
            .eq("user_id", user_id)
            .eq("scope", scope)
            .in_("action", ["CONSENT_GRANTED", "REVOKED"])
        )
        if agent_id:
            query = query.eq("agent_id", agent_id)
        order_field = "id" if agent_id == "self" and scope == "vault.owner" else "issued_at"
        rows = await asyncio.to_thread(
            lambda: query.order(order_field, desc=True).limit(1).execute().data or []
        )
    except DatabaseExecutionError as exc:
        if not service._is_missing_internal_access_events_error(exc):
            raise
        logger.warning(
            "internal_access_events_missing fallback=consent_audit action=is_token_active"
        )
        rows = await service._get_legacy_internal_rows(
            user_id,
            agent_id=agent_id,
            scope=scope,
            actions=["CONSENT_GRANTED", "REVOKED"],
            limit=1,
        )
    return rows


async def active_lineage_rows(
    service: Any, user_id: str, scope: str, agent_id: str | None
) -> list[dict]:
    is_internal_lookup = service._is_internal_event(
        agent_id=agent_id,
        action="CONSENT_GRANTED",
        scope=scope,
    )

    rows: list[dict]

    if is_internal_lookup:
        rows = await _internal_lineage_rows(service, user_id, scope, agent_id)
    elif agent_id == "personal_agent":
        response = await asyncio.to_thread(
            service._get_db().execute_raw,
            "SELECT action, expires_at, issued_at, token_id FROM consent_audit "
            "WHERE user_id = :user_id AND agent_id = :agent_id AND scope = :scope "
            "AND action IN ('CONSENT_GRANTED', 'REVOKED', 'CONSENT_DENIED') "
            "ORDER BY issued_at DESC, id DESC LIMIT 1",
            {"user_id": user_id, "agent_id": agent_id, "scope": scope},
        )
        rows = response.data or []
    elif not scope.startswith("attr."):
        query = (
            service._get_db()
            .table("consent_audit")
            .select("action,expires_at,issued_at,token_id,metadata")
            .eq("user_id", user_id)
            .eq("scope", scope)
            .in_("action", ["CONSENT_GRANTED", "REVOKED"])
        )
        if agent_id:
            query = query.eq("agent_id", agent_id)
        rows = await asyncio.to_thread(
            lambda: query.order("issued_at", desc=True).limit(1).execute().data or []
        )
    else:
        # Paid audit rows (including revocation of a paid request) never
        # supersede an established free grant for the same app and scope.
        from hushh_mcp.services.consent_commerce_ports import free_scope_lineage

        rows = await free_scope_lineage(service._get_db(), user_id, scope, agent_id)

    return rows
