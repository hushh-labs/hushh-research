"""Resolve commerce identity from existing consent authority, never buyer input.

This adapter joins the existing developer/person request contracts. It stores no
information and introduces no second consent authority. Use the caller's current
transaction connection when preparing an export so key checks share its fence.
"""

from __future__ import annotations

import json
from contextlib import asynccontextmanager
from datetime import UTC, datetime
from typing import Any
from uuid import UUID

from db.connection import get_pool
from hushh_mcp.consent.export_envelope import (
    connector_key_fingerprint,
    scope_handle_for_machine_scope,
)
from hushh_mcp.consent.requestable_scope_policy import is_scope_requestable_by_others
from hushh_mcp.consent.scope_generator import get_scope_generator


class CommerceRequestError(ValueError):
    """A safe, fixed public error code; never contains identity or private values."""


def _metadata(value: Any) -> dict:
    if isinstance(value, dict):
        return value
    if isinstance(value, str):
        result = json.loads(value)
        return result if isinstance(result, dict) else {}
    return {}


async def validate_tariff_scope(owner_user_id: str, scope_handle: str, machine_scope: str) -> None:
    if not machine_scope.startswith("attr.") or not is_scope_requestable_by_others(machine_scope):
        raise CommerceRequestError("scope_unavailable")
    entries = await get_scope_generator().get_available_scope_entries(owner_user_id)
    if not any(
        entry.get("scope") == machine_scope
        and entry.get("materialization_state") != "empty"
        and scope_handle
        == (
            entry.get("registry_handle")
            or scope_handle_for_machine_scope(owner_user_id, machine_scope)
        )
        for entry in entries
    ):
        raise CommerceRequestError("scope_unavailable")


async def authoritative_scope_handle(
    owner_user_id: str,
    machine_scope: str,
    *,
    connection: Any = None,
) -> str:
    """Resolve the exact eligible scope through canonical discovery on caller custody."""
    if not machine_scope.startswith("attr.") or not is_scope_requestable_by_others(machine_scope):
        raise CommerceRequestError("scope_unavailable")
    entries = await get_scope_generator().get_available_scope_entries(
        owner_user_id, connection=connection
    )
    entry = next((item for item in entries if item.get("scope") == machine_scope), None)
    if entry is None or entry.get("materialization_state") == "empty":
        raise CommerceRequestError("scope_unavailable")
    return str(
        entry.get("registry_handle") or scope_handle_for_machine_scope(owner_user_id, machine_scope)
    )


async def resolve_commerce_request(
    request_id: str,
    viewer_user_id: str,
    *,
    require_payer: bool = False,
    connection: Any = None,
) -> dict:
    if not request_id or len(request_id) > 200:
        raise CommerceRequestError("request_unavailable")
    if connection is None:
        pool = await get_pool()
        async with pool.acquire() as conn:
            return await resolve_commerce_request(
                request_id, viewer_user_id, require_payer=require_payer, connection=conn
            )
    row = await connection.fetchrow(
        """SELECT user_id, agent_id, scope, action, metadata, expires_at,
                  poll_timeout_at, issued_at
           FROM consent_audit WHERE request_id=$1
             AND action IN ('REQUESTED','CONSENT_PAID_APPROVED','CONSENT_PAID_FUNDED','CONSENT_GRANTED',
                            'CONSENT_DENIED','REVOKED','CANCELLED','TIMEOUT')
           ORDER BY issued_at DESC,id DESC LIMIT 1""",
        request_id,
    )
    if row is None:
        return await _marketplace_request(connection, request_id, viewer_user_id, require_payer)
    event = dict(row)
    metadata = _metadata(event.get("metadata"))
    if metadata.get("request_source") == "marketplace":
        if event["action"] in {"REVOKED", "CANCELLED", "TIMEOUT", "CONSENT_DENIED"}:
            raise CommerceRequestError("request_unavailable")
        result = await _marketplace_request(connection, request_id, viewer_user_id, require_payer)
        result["consent_action"] = str(event["action"])
        return result
    owner = str(event["user_id"])
    app_id = str(metadata.get("developer_app_id") or "")
    payer, key, duration, purpose = await _recipient_binding(
        connection,
        request_id=request_id,
        event=event,
        metadata=metadata,
        owner=owner,
        app_id=app_id,
    )
    _viewer(owner, payer, viewer_user_id, require_payer)
    if event["action"] in {"REVOKED", "CANCELLED", "TIMEOUT", "CONSENT_DENIED"}:
        raise CommerceRequestError("request_unavailable")
    return _binding(
        request_id=request_id,
        owner=owner,
        payer=payer,
        app_id=app_id,
        machine_scope=str(event["scope"]),
        metadata=metadata,
        key=key,
        duration=duration,
        purpose=purpose,
        action=str(event["action"]),
        deadline=metadata.get("approval_timeout_at") or event.get("poll_timeout_at"),
        agent_id=str(event["agent_id"]),
        handle=await authoritative_scope_handle(owner, str(event["scope"]), connection=connection),
    )


async def _recipient_binding(
    connection: Any,
    *,
    request_id: str,
    event: dict,
    metadata: dict,
    owner: str,
    app_id: str,
) -> tuple[str, Any, int, str]:
    """Resolve payer and current key through the existing app/person authority."""
    person = await connection.fetchrow(
        """SELECT b.requester_user_id,b.subject_user_id,b.requester_principal,
                  b.connector_key_id,b.duration_seconds,b.purpose
           FROM one_information_request_items i
           JOIN one_information_request_bundles b ON b.bundle_id=i.bundle_id
           WHERE i.request_id=$1""",
        request_id,
    )
    if person:
        if (
            app_id != "agent_one"
            or str(person["subject_user_id"]) != owner
            or str(person["requester_principal"]) != str(event["agent_id"])
        ):
            raise CommerceRequestError("request_unavailable")
        payer = str(person["requester_user_id"])
        key = await connection.fetchrow(
            """SELECT connector_key_id,connector_public_key,connector_wrapping_alg
               FROM one_kyc_client_connectors
               WHERE user_id=$1 AND connector_key_id=$2 AND status='active'""",
            payer,
            person["connector_key_id"],
        )
        duration = int(person["duration_seconds"])
        purpose = str(person["purpose"])
    else:
        app = await connection.fetchrow(
            "SELECT owner_firebase_uid,agent_id,status FROM developer_apps WHERE app_id=$1",
            app_id,
        )
        if not app or app["status"] != "active" or app["agent_id"] != event["agent_id"]:
            raise CommerceRequestError("request_unavailable")
        payer = str(app["owner_firebase_uid"] or "")
        if not payer:
            raise CommerceRequestError("payer_delegation_required")
        key = await connection.fetchrow(
            """SELECT connector_key_id,connector_public_key,connector_wrapping_alg
               FROM developer_connector_keys WHERE app_id=$1 AND status='active'""",
            app_id,
        )
        duration = int(metadata.get("expiry_hours") or 24) * 3600
        purpose = str(metadata.get("reason") or "")
    return payer, key, duration, purpose


def _viewer(owner: str, payer: str, viewer: str, require_payer: bool) -> None:
    if viewer != payer and (require_payer or viewer != owner):
        raise CommerceRequestError("request_unavailable")
    if owner == payer:
        raise CommerceRequestError("request_unavailable")


def _binding(
    *,
    request_id: str,
    owner: str,
    payer: str,
    app_id: str,
    machine_scope: str,
    metadata: dict,
    key: Any,
    duration: int,
    purpose: str,
    action: str,
    deadline: Any,
    agent_id: str,
    handle: str,
) -> dict:
    if (
        not machine_scope.startswith("attr.")
        or not is_scope_requestable_by_others(machine_scope)
        or not key
        or key["connector_wrapping_alg"] != "X25519-AES256-GCM"
    ):
        raise CommerceRequestError("recipient_or_scope_unavailable")
    try:
        fingerprint = connector_key_fingerprint(str(key["connector_public_key"]))
    except ValueError:
        raise CommerceRequestError("recipient_or_scope_unavailable") from None
    if metadata.get("scope_handle") != handle:
        raise CommerceRequestError("scope_unavailable")
    if metadata.get("recipient_key_fingerprint") != fingerprint:
        raise CommerceRequestError("recipient_key_changed")
    if metadata.get("connector_key_id") != str(key["connector_key_id"]):
        raise CommerceRequestError("recipient_key_changed")
    deadline_dt = None
    if deadline:
        deadline_dt = datetime.fromtimestamp(int(deadline) / 1000, UTC)
    return {
        "request_id": request_id,
        "owner_user_id": owner,
        "payer_user_id": payer,
        "buyer_app_id": app_id,
        "agent_id": agent_id,
        "machine_scope": machine_scope,
        "scope_handle": handle,
        "recipient_key_fingerprint": fingerprint,
        "connector_public_key": str(key["connector_public_key"]),
        "connector_key_id": str(key["connector_key_id"]),
        "connector_wrapping_alg": str(key["connector_wrapping_alg"]),
        "duration_seconds": duration,
        "purpose": purpose,
        "refresh_policy": metadata.get("refresh_policy") or "snapshot",
        "request_deadline": deadline_dt,
        "consent_action": action,
        "metadata": metadata,
    }


async def _marketplace_request(
    conn: Any, request_id: str, viewer: str, require_payer: bool
) -> dict:
    try:
        request_uuid = UUID(request_id)
    except ValueError:
        raise CommerceRequestError("request_unavailable") from None
    row = await conn.fetchrow("SELECT * FROM marketplace_access_requests WHERE id=$1", request_uuid)
    if not row or not row["buyer_user_id"]:
        raise CommerceRequestError("request_unavailable")
    owner, payer = str(row["owner_user_id"]), str(row["buyer_user_id"])
    _viewer(owner, payer, viewer, require_payer)
    if row["status"] in {"denied", "expired", "revoked"}:
        raise CommerceRequestError("request_unavailable")
    metadata = _metadata(row["metadata"])
    # Legacy P-256 envelopes remain a separate free compatibility flow. Paid
    # marketplace requests must bind the same registered X25519 connector as
    # person requests; never reinterpret a JWK as canonical key material.
    key = await conn.fetchrow(
        """SELECT connector_key_id,connector_public_key,connector_wrapping_alg
           FROM one_kyc_client_connectors
           WHERE user_id=$1 AND connector_key_id=$2 AND status='active'""",
        payer,
        metadata.get("connector_key_id"),
    )
    scope = str(metadata.get("machine_scope") or "")
    metadata["scope_handle"] = row["scope_handle"]
    return _binding(
        request_id=request_id,
        owner=owner,
        payer=payer,
        app_id="agent_one",
        machine_scope=scope,
        metadata=metadata,
        key=key,
        duration=int(metadata.get("duration_seconds") or int(row["duration_days"]) * 86400),
        purpose=str(row["message"] or ""),
        action=str(row["status"]),
        deadline=None,
        agent_id=str(metadata.get("requester_principal") or ""),
        handle=await authoritative_scope_handle(owner, scope, connection=conn),
    )


async def fetch_active_buyer_connector_and_person_ref(
    buyer_user_id: str,
    connector_key_id: str,
    *,
    pool_getter: Any = None,
) -> tuple[Any, Any]:
    getter = pool_getter or get_pool
    pool = await getter()
    async with pool.acquire() as conn:
        key = await conn.fetchrow(
            "SELECT connector_key_id,connector_public_key,connector_wrapping_alg "
            "FROM one_kyc_client_connectors "
            "WHERE user_id=$1 AND connector_key_id=$2 AND status='active'",
            buyer_user_id,
            connector_key_id,
        )
        person_ref = await conn.fetchval(
            "SELECT public_person_ref FROM actor_profiles "
            "WHERE user_id=$1 AND public_profile_status='active'",
            buyer_user_id,
        )
    return key, person_ref


async def fetch_seller_account_and_withdrawals(
    user_id: str,
    *,
    pool_getter: Any = None,
) -> tuple[dict[str, Any], list[Any]]:
    getter = pool_getter or get_pool
    pool = await getter()
    async with pool.acquire() as conn:
        row = await conn.fetchrow(
            "SELECT account_id,country,eligible "
            "FROM scope_commerce_seller_accounts WHERE user_id=$1",
            user_id,
        )
        withdrawals = await conn.fetch(
            """SELECT withdrawal_id,status,net_cents,fee_micro_usd,settled_micro_usd,created_at
               FROM scope_commerce_withdrawals WHERE user_id=$1
               ORDER BY created_at DESC LIMIT 20""",
            user_id,
        )
    return (dict(row) if row else {}, list(withdrawals))


async def fetch_quote_request_id(
    quote_id: UUID,
    payer_user_id: str,
    *,
    pool_getter: Any = None,
) -> str | None:
    getter = pool_getter or get_pool
    pool = await getter()
    async with pool.acquire() as conn:
        row = await conn.fetchrow(
            "SELECT request_id FROM scope_commerce_quotes WHERE quote_id=$1 AND payer_user_id=$2",
            quote_id,
            payer_user_id,
        )
    return str(row["request_id"]) if row else None


_CONNECTED_COUNTERPART_SQL = """SELECT p.user_id,p.public_person_ref,i.display_name
    FROM connections c JOIN actor_profiles p ON p.user_id=$2
    LEFT JOIN actor_identity_cache i ON i.user_id=p.user_id
    WHERE c.user_a_id=LEAST($1::text,$2::text)
      AND c.user_b_id=GREATEST($1::text,$2::text) AND c.status='active'
      AND p.public_profile_status='active'
      AND NOT EXISTS (SELECT 1 FROM account_deletion_tombstones t
        WHERE t.user_id_hash='sha256:' || encode(sha256(convert_to(p.user_id,'UTF8')),'hex'))
    LIMIT 1"""


async def fetch_connected_counterpart_row(
    viewer: str,
    counterpart: str,
    *,
    check_tables: bool = False,
    pool_getter: Any = None,
) -> Any:
    getter = pool_getter or get_pool
    pool = await getter()
    async with pool.acquire() as conn:
        if check_tables:
            available = await conn.fetchval(
                """SELECT to_regclass('connections') IS NOT NULL
                AND to_regclass('actor_profiles') IS NOT NULL
                AND to_regclass('actor_identity_cache') IS NOT NULL
                AND to_regclass('account_deletion_tombstones') IS NOT NULL"""
            )
            if not available:
                return None
        return await conn.fetchrow(_CONNECTED_COUNTERPART_SQL, viewer, counterpart)


async def inspect_request_financial_history(
    request_id: str,
    user_id: str,
    *,
    service: Any,
    legacy_fallback: Any,
    pool_getter: Any = None,
) -> tuple[Any, dict[str, Any] | None]:
    getter = pool_getter or get_pool
    pool = await getter()
    async with pool.acquire() as conn:
        financial_schema = await conn.fetchval(
            "SELECT to_regclass('scope_commerce_purchases') IS NOT NULL"
        )
        if not financial_schema:
            return None, await legacy_fallback(conn, service, request_id, user_id)
        historical = await conn.fetchrow(
            """SELECT purchase_id,owner_user_id,payer_user_id FROM scope_commerce_purchases
               WHERE request_id=$1 AND (owner_user_id=$2 OR payer_user_id=$2)""",
            request_id,
            user_id,
        )
    return historical, None


async def resolve_owner_export_binding_on_conn(
    purchase_id: UUID,
    owner_user_id: str,
    conn: Any,
) -> dict[str, Any]:
    row = await conn.fetchrow(
        "SELECT request_id FROM scope_commerce_purchases WHERE purchase_id=$1 AND owner_user_id=$2",
        purchase_id,
        owner_user_id,
    )
    if not row:
        raise ValueError("purchase_unavailable")
    return dict(
        await resolve_commerce_request(str(row["request_id"]), owner_user_id, connection=conn)
    )


async def fetch_owner_export_binding(
    purchase_id: UUID,
    owner_user_id: str,
    *,
    pool_getter: Any = None,
) -> dict[str, Any]:
    getter = pool_getter or get_pool
    pool = await getter()
    async with pool.acquire() as conn:
        return await resolve_owner_export_binding_on_conn(purchase_id, owner_user_id, conn)


async def record_cost_acknowledgement_on_conn(
    conn: Any,
    binding: dict[str, Any],
    purchase_id: UUID,
    acknowledgement: Any,
    phase: str,
) -> None:
    if acknowledgement is None:
        return
    negative = await conn.fetchval(
        "SELECT fee_micro_usd>price_cents*10000 FROM scope_commerce_purchases WHERE purchase_id=$1",
        purchase_id,
    )
    if not negative:
        return
    metadata = {
        "commercial_required": True,
        "commerce_purchase_id": str(purchase_id),
        "version": acknowledgement.version,
        "binding": acknowledgement.binding,
        "phase": phase,
    }
    exists = await conn.fetchval(
        """SELECT EXISTS(SELECT 1 FROM consent_audit WHERE request_id=$1
        AND action='CONSENT_PAID_COST_ACKNOWLEDGED' AND metadata->>'binding'=$2
        AND metadata->>'phase'=$3 AND metadata->>'commerce_purchase_id'=$4)""",
        binding["request_id"],
        acknowledgement.binding,
        phase,
        str(purchase_id),
    )
    if not exists:
        from hushh_mcp.services.consent_db import ConsentDBService

        await ConsentDBService().insert_event(
            user_id=binding["owner_user_id"],
            agent_id=binding["agent_id"],
            scope=binding["machine_scope"],
            action="CONSENT_PAID_COST_ACKNOWLEDGED",
            request_id=binding["request_id"],
            metadata=metadata,
            connection=conn,
        )


@asynccontextmanager
async def locked_commerce_transaction(*, gate: int, pool_getter: Any = None):
    getter = pool_getter or get_pool
    pool = await getter()
    async with pool.acquire() as conn, conn.transaction():
        await conn.execute("SELECT pg_advisory_xact_lock($1)", gate)
        yield conn
