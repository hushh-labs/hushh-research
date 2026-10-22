"""Marketplace consent locks, current recipient binding and encrypted delivery.

MarketplaceRequestService remains the canonical public facade. This adapter
shares its caller-owned transactions and central paid admission authority.
"""

from __future__ import annotations

import json
from typing import Any
from uuid import UUID

from hushh_mcp.services.marketplace_request_service import (
    _DEFAULT_KEY_ALGORITHM,
    _envelope_row,
    _parse_metadata,
    _request_unexpired,
    _row_to_request,
)


async def lock_request(conn, request_id, *, owner_user_id=None, buyer_user_id=None):
    try:
        request_uuid = UUID(str(request_id))
    except ValueError:
        return None
    await conn.execute(
        "SELECT pg_advisory_xact_lock(hashtextextended($1,0))",
        "consent-request:" + str(request_id),
    )
    row = await conn.fetchrow(
        "SELECT * FROM marketplace_access_requests WHERE id=$1 FOR UPDATE", request_uuid
    )
    if not row:
        return None
    row = dict(row)
    if owner_user_id is not None and str(row["owner_user_id"]) != owner_user_id:
        return None
    if buyer_user_id is not None and str(row.get("buyer_user_id") or "") != buyer_user_id:
        return None
    return row


async def exact_scope(conn, row):
    from hushh_mcp.consent.export_envelope import scope_handle_for_machine_scope
    from hushh_mcp.consent.requestable_scope_policy import is_scope_requestable_by_others

    metadata = _parse_metadata(row.get("metadata"))
    machine_scope = metadata.get("machine_scope")
    if not machine_scope:
        entry = await conn.fetchrow(
            "SELECT summary_projection FROM pkm_scope_registry WHERE user_id=$1 AND domain=$2 AND scope_handle=$3 AND exposure_enabled AND visibility_posture <> 'private' FOR SHARE",
            row["owner_user_id"],
            row["domain"],
            row.get("scope_handle"),
        )
        path = (
            _parse_metadata(entry["summary_projection"]).get("top_level_scope_path")
            if entry
            else None
        )
        if not path:
            raise ValueError("An exact published scope is required.")
        machine_scope = "attr." + row["domain"] + "." + path + ".*"
    if not is_scope_requestable_by_others(machine_scope) or not machine_scope.startswith(
        "attr." + row["domain"] + "."
    ):
        raise ValueError("The requested scope is unavailable.")
    return machine_scope, str(
        row.get("scope_handle")
        or scope_handle_for_machine_scope(str(row["owner_user_id"]), machine_scope)
    )


async def tariff(conn, row, handle, machine_scope):
    from asyncpg import UndefinedTableError

    from hushh_mcp.consent.paid_admission import is_paid_grant

    try:
        # A missing optional migration must not abort the free transaction.
        async with conn.transaction():
            tariff = await conn.fetchrow(
                "SELECT price_cents FROM scope_commerce_tariffs WHERE owner_user_id=$1 AND scope_handle=$2 AND machine_scope=$3 ORDER BY revision DESC LIMIT 1",
                row["owner_user_id"],
                handle,
                machine_scope,
            )
    except UndefinedTableError:
        if is_paid_grant(_parse_metadata(row.get("metadata"))):
            raise ValueError("Paid access is unavailable.") from None
        return None
    return dict(tariff) if tariff else None


async def active_recipient(conn, buyer_user_id):
    await conn.execute(
        "SELECT pg_advisory_xact_lock(hashtextextended($1,0))",
        "marketplace-recipient:" + buyer_user_id,
    )
    row = await conn.fetchrow(
        "SELECT * FROM marketplace_recipient_keys WHERE user_id=$1 AND status='active' ORDER BY created_at DESC LIMIT 1 FOR SHARE",
        buyer_user_id,
    )
    return dict(row) if row else None


async def store_locked_envelope(service: Any, conn, row, envelope):
    buyer = str(row.get("buyer_user_id") or "")
    if not buyer:
        raise ValueError("A registered recipient is required.")
    recipient = await service._active_recipient(conn, buyer)
    if not recipient or envelope.get("recipientKeyId") != recipient["key_id"]:
        raise ValueError("The recipient key changed.")
    scope, _ = await service._exact_scope(conn, row)
    metadata = _parse_metadata(envelope.get("metadata"))
    if metadata.get("scope") != scope or metadata.get("request_id") not in {
        None,
        str(row["id"]),
    }:
        raise ValueError("The encrypted export must bind the exact approved scope.")
    if envelope.get("algorithm", _DEFAULT_KEY_ALGORITHM) != recipient["algorithm"]:
        raise ValueError("The recipient algorithm changed.")
    stored = await conn.fetchrow(
        """INSERT INTO marketplace_delivery_envelopes(request_id,owner_user_id,buyer_user_id,recipient_key_id,algorithm,ciphertext,iv,sender_ephemeral_public_key_jwk,metadata)
           VALUES($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9::jsonb) RETURNING *""",
        row["id"],
        row["owner_user_id"],
        buyer,
        recipient["key_id"],
        recipient["algorithm"],
        envelope["ciphertext"],
        envelope["iv"],
        json.dumps(envelope["senderEphemeralPublicKeyJwk"]),
        json.dumps(metadata),
    )
    await conn.execute(
        "UPDATE marketplace_access_requests SET latest_envelope_id=$2 WHERE id=$1",
        row["id"],
        stored["id"],
    )
    return _envelope_row(dict(stored))


async def get_delivered_envelope(
    service: Any, *, buyer_user_id: str, request_id: str
) -> dict | None:
    async with service._transaction() as conn:
        row = await service._lock_request(conn, request_id, buyer_user_id=buyer_user_id)
        if not row:
            return None
        request = _row_to_request(row)
        if row.get("status") != "approved":
            return {"request": request, "envelope": None}
        if _parse_metadata(row.get("metadata")).get("commercial_required"):
            from hushh_mcp.consent.paid_admission import paid_grant_is_admitted
            from hushh_mcp.services.consent_db import ConsentDBService

            grant = await conn.fetchrow(
                "SELECT token_id,metadata FROM consent_audit WHERE request_id=$1 AND action='CONSENT_GRANTED' ORDER BY issued_at DESC,id DESC LIMIT 1",
                request_id,
            )
            if not grant or not await paid_grant_is_admitted(
                str(grant["token_id"]), _parse_metadata(grant["metadata"]), connection=conn
            ):
                return {"request": request, "envelope": None, "encryptedExport": None}
            encrypted = await conn.fetchrow(
                "SELECT * FROM consent_exports WHERE consent_token=$1 AND expires_at>clock_timestamp() AND refresh_status='current'",
                grant["token_id"],
            )
            if not encrypted:
                return {"request": request, "envelope": None, "encryptedExport": None}
            encrypted = ConsentDBService()._normalize_export_row(dict(encrypted))
            package = {
                key: encrypted.get(key)
                for key in (
                    "encrypted_data",
                    "iv",
                    "tag",
                    "wrapped_key_bundle",
                    "scope",
                    "export_revision",
                    "export_generated_at",
                )
            }
            package.update(
                {
                    "status": "success",
                    "request_id": request_id,
                    "export_refresh_status": encrypted.get("refresh_status"),
                    "export_envelope": {
                        "version": encrypted.get("envelope_version"),
                        "export_id": encrypted.get("export_id"),
                        "aad": encrypted.get("envelope_aad"),
                        "aad_sha256": encrypted.get("envelope_aad_sha256"),
                        "ciphertext_sha256": encrypted.get("ciphertext_sha256"),
                        "ciphertext_bytes": encrypted.get("ciphertext_bytes"),
                    },
                }
            )
            return {"request": request, "envelope": None, "encryptedExport": package}
        if not _request_unexpired(row):
            return {"request": request, "envelope": None}
        if not row.get("latest_envelope_id"):
            return {"request": request, "envelope": None}
        recipient = await service._active_recipient(conn, buyer_user_id)
        if not recipient:
            return {"request": request, "envelope": None}
        envelope = await conn.fetchrow(
            "SELECT * FROM marketplace_delivery_envelopes WHERE id=$1 AND request_id=$2 AND owner_user_id=$3 AND buyer_user_id=$4 AND recipient_key_id=$5",
            row["latest_envelope_id"],
            row["id"],
            row["owner_user_id"],
            buyer_user_id,
            recipient["key_id"],
        )
        return {
            "request": request,
            "envelope": _envelope_row(dict(envelope)) if envelope else None,
        }


async def create_request(
    service: Any,
    payload: dict,
    request_id: str | None,
    buyer_user_id: str | None,
    metadata: dict | None,
) -> dict:
    if request_id:
        payload["id"] = request_id
        prior = await service._execute_query(
            service.db.table("marketplace_access_requests")
            .select("*")
            .eq("id", request_id)
            .eq("buyer_user_id", buyer_user_id)
            .limit(1)
        )
        prior_rows = getattr(prior, "data", None) or []
        if prior_rows:
            if _parse_metadata(prior_rows[0].get("metadata")).get("request_fingerprint") != (
                metadata or {}
            ).get("request_fingerprint"):
                raise ValueError("The request confirmation changed.")
            return _row_to_request(prior_rows[0])
    result = await service._execute_query(
        service.db.table("marketplace_access_requests").insert(payload)
    )
    rows = getattr(result, "data", None) or []
    return _row_to_request(rows[0]) if rows else _row_to_request(payload)
