"""Canonical owner authorization, funding and cancellation transitions.

All callers retain paid_admission's public facade. These transitions compose
canonical consent and commercial accounting in the caller's locked transaction.
"""

from __future__ import annotations

import json
from typing import Any

from hushh_mcp.consent.paid_admission import _metadata, _request_lock, is_paid_grant


async def _pool():
    # Preserve the facade's injected pool port for canonical callers/tests.
    from hushh_mcp.consent.paid_admission import get_pool

    return await get_pool()


async def approve_paid_request(
    owner_user_id: str,
    request_id: str,
    duration_seconds: int,
    idempotency_key: str,
    *,
    connection: Any = None,
) -> dict | None:
    """Freeze owner-approved terms before buyer confirmation; return None for free."""
    if connection is None:
        pool = await _pool()
        async with pool.acquire() as conn, conn.transaction():
            return await approve_paid_request(
                owner_user_id, request_id, duration_seconds, idempotency_key, connection=conn
            )
    from hushh_mcp.services.scope_commerce.service import COMMERCE_GATE, ScopeCommerceService
    from hushh_mcp.services.scope_commerce_requests import resolve_commerce_request

    await connection.execute("SELECT pg_advisory_xact_lock($1)", COMMERCE_GATE)
    await _request_lock(connection, request_id)
    binding = await resolve_commerce_request(request_id, owner_user_id, connection=connection)
    if binding["owner_user_id"] != owner_user_id:
        raise PermissionError("request_unavailable")
    service = ScopeCommerceService()
    existing = await service.lookup_by_request(request_id, conn=connection)
    if existing:
        quote = await service.get_quote_by_request(request_id, conn=connection)
        frozen_duration = int((quote or {}).get("durationSeconds") or 0)
        if duration_seconds != frozen_duration:
            raise ValueError("approved_duration_is_immutable")
        return {
            "status": existing["status"],
            "commercial_required": True,
            "purchase": dict(existing),
            "quote": quote,
            "request_id": request_id,
        }
    tariff = await service.get_tariff(
        owner_user_id=owner_user_id,
        scope_handle=binding["scope_handle"],
        machine_scope=binding["machine_scope"],
        conn=connection,
    )
    if not tariff or not int(tariff.get("priceCents") or tariff.get("price_cents") or 0):
        if is_paid_grant(binding["metadata"]):
            raise ValueError("paid_authorization_unavailable")
        return None
    if duration_seconds <= 0 or duration_seconds > binding["duration_seconds"]:
        raise ValueError("approved_duration_exceeds_request")
    if binding["consent_action"] not in {"REQUESTED", "pending"}:
        raise ValueError("request_not_pending")
    deadline = binding.get("request_deadline")
    if deadline and deadline <= await connection.fetchval("SELECT clock_timestamp()"):
        raise ValueError("request_expired")
    return await _freeze_authorization(
        connection, binding, duration_seconds, idempotency_key, service
    )


async def _freeze_authorization(
    connection: Any, binding: dict, duration_seconds: int, idempotency_key: str, service: Any
) -> dict:
    from hushh_mcp.services.consent_db import ConsentDBService

    owner_user_id, request_id = binding["owner_user_id"], binding["request_id"]
    deadline = binding.get("request_deadline")
    domain = binding["machine_scope"].split(".")[1]
    await connection.execute(
        "SELECT pg_advisory_xact_lock(hashtextextended($1,0))", owner_user_id + ":" + domain
    )
    manifest_revision = await connection.fetchval(
        "SELECT manifest_version FROM pkm_manifests WHERE user_id=$1 AND domain=$2 FOR SHARE",
        owner_user_id,
        domain,
    )
    if not manifest_revision:
        raise ValueError("scope_unavailable")
    quote = await service.quote(
        owner_user_id=owner_user_id,
        buyer_app_id=binding["buyer_app_id"],
        payer_user_id=binding["payer_user_id"],
        scope_handle=binding["scope_handle"],
        machine_scope=binding["machine_scope"],
        duration_seconds=duration_seconds,
        recipient_key_fingerprint=binding["recipient_key_fingerprint"],
        idempotency_key=idempotency_key,
        request_id=request_id,
        purpose=binding["purpose"],
        refresh_policy=binding["refresh_policy"],
        scope_manifest_revision=manifest_revision,
        request_deadline=deadline,
        conn=connection,
    )
    quote_id = str(quote.get("quote_id") or quote.get("quoteId"))
    purchase = await service.approve_quote(
        owner_user_id=owner_user_id, quote_id=quote_id, request_id=request_id, conn=connection
    )
    purchase_id = str(purchase.get("purchase_id") or purchase.get("purchaseId"))
    metadata = {
        **binding["metadata"],
        "commercial_required": True,
        "commerce_quote_id": quote_id,
        "commerce_purchase_id": purchase_id,
        "approved_duration_seconds": duration_seconds,
        "request_id": request_id,
        "commerce_status": "awaiting_payment",
    }
    if binding["consent_action"] == "pending":
        await connection.execute(
            """UPDATE marketplace_access_requests SET status='approved', resolved_at=now(),
                 metadata=$2::jsonb WHERE id::text=$1 AND status='pending'""",
            request_id,
            json.dumps(metadata),
        )
    await ConsentDBService().insert_event(
        user_id=owner_user_id,
        agent_id=binding["agent_id"],
        scope=binding["machine_scope"],
        action="CONSENT_PAID_APPROVED",
        request_id=request_id,
        metadata=metadata,
        connection=connection,
    )
    return {
        "status": "approved_awaiting_payment",
        "commercial_required": True,
        "quote": quote,
        "purchase": purchase,
        "request_id": request_id,
    }


async def maybe_approve_paid_request(
    *,
    owner_user_id: str,
    request_id: str,
    machine_scope: str,
    metadata: dict,
    duration_seconds: int,
) -> dict | None:
    if not machine_scope.startswith("attr."):
        return None
    known_paid = is_paid_grant(metadata)
    pool = await _pool()
    if pool.__class__.__module__.startswith("db.offline"):
        async with pool.acquire() as conn:
            present = await conn.fetchval(
                "SELECT name FROM sqlite_master WHERE type='table' AND name='scope_commerce_tariffs'"
            )
        if known_paid or present:
            raise ValueError("offline_paid_authority_unavailable")
        return None
    from asyncpg import UndefinedTableError

    from hushh_mcp.services.scope_commerce.service import ScopeCommerceService
    from hushh_mcp.services.scope_commerce_requests import authoritative_scope_handle

    try:
        handle = await authoritative_scope_handle(owner_user_id, machine_scope)
        tariff = await ScopeCommerceService().get_tariff(
            owner_user_id=owner_user_id,
            scope_handle=handle,
            machine_scope=machine_scope,
        )
    except UndefinedTableError:
        if known_paid:
            raise ValueError("paid_authorization_unavailable") from None
        return None
    if not known_paid and (not tariff or not int(tariff.get("priceCents") or 0)):
        return None
    from hushh_mcp.consent.paid_admission import approve_paid_request as approve

    return await approve(owner_user_id, request_id, duration_seconds, "owner-approve:" + request_id)


async def record_paid_funded(conn: Any, purchase: dict) -> None:
    """Reservation callback: durable owner preparation notice in the same commit."""
    from hushh_mcp.services.consent_db import ConsentDBService
    from hushh_mcp.services.scope_commerce_requests import resolve_commerce_request

    request_id, owner = str(purchase["request_id"]), str(purchase["owner_user_id"])
    await _request_lock(conn, request_id)
    binding = await resolve_commerce_request(request_id, owner, connection=conn)
    metadata = {
        **binding["metadata"],
        "commercial_required": True,
        "commerce_purchase_id": str(purchase["purchase_id"]),
        "request_id": request_id,
        "commerce_status": "reserved",
    }
    if binding["metadata"].get("request_source") == "marketplace":
        await conn.execute(
            "UPDATE marketplace_access_requests SET metadata=$2::jsonb WHERE id::text=$1 AND status='approved'",
            request_id,
            json.dumps(metadata),
        )
    await ConsentDBService().insert_event(
        user_id=owner,
        agent_id=binding["agent_id"],
        scope=binding["machine_scope"],
        action="CONSENT_PAID_FUNDED",
        request_id=request_id,
        metadata=metadata,
        connection=conn,
    )
    source_ref = "paid-funded:" + str(purchase["purchase_id"])
    feed_metadata = {
        key: metadata[key]
        for key in ("commercial_required", "commerce_purchase_id", "request_id", "commerce_status")
    }
    feed_metadata.update(
        {
            "scope": binding["machine_scope"],
            "agent_id": binding["agent_id"],
            "reason": binding["purpose"][:2000],
        }
    )
    await conn.execute(
        """INSERT INTO feed_events(user_id,source_domain,event_type,metadata,source_row_id)
        SELECT $1,'consent','consent_requested',$2::jsonb,$3
        WHERE NOT EXISTS(SELECT 1 FROM feed_events WHERE user_id=$1 AND source_row_id=$3)""",
        owner,
        json.dumps(feed_metadata),
        source_ref,
    )


async def validate_free_grant_commit(conn: Any, owner_user_id: str, machine_scope: str) -> None:
    """Under the ledger transaction, a tariff cannot race legacy free approval."""
    from asyncpg import UndefinedTableError

    from hushh_mcp.services.scope_commerce.service import COMMERCE_GATE, ScopeCommerceService
    from hushh_mcp.services.scope_commerce_requests import authoritative_scope_handle

    await conn.execute("SELECT pg_advisory_xact_lock($1)", COMMERCE_GATE)
    await conn.execute(
        "SELECT pg_advisory_xact_lock(hashtextextended($1,0))",
        owner_user_id + ":" + machine_scope.split(".")[1],
    )
    handle = await authoritative_scope_handle(owner_user_id, machine_scope, connection=conn)
    try:
        async with conn.transaction():
            tariff = await ScopeCommerceService().get_tariff(
                owner_user_id=owner_user_id,
                scope_handle=handle,
                machine_scope=machine_scope,
                conn=conn,
            )
    except UndefinedTableError:
        return
    if tariff and int(tariff.get("priceCents") or 0) > 0:
        raise PermissionError("paid_owner_authorization_required")


async def end_paid_purchase(
    actor_user_id: str,
    purchase_id: str,
    *,
    as_owner: bool,
    connection: Any = None,
) -> dict:
    """Owner revocation or buyer cancellation composes consent and accounting."""
    from uuid import UUID

    from hushh_mcp.services.scope_commerce.domain import public
    from hushh_mcp.services.scope_commerce.service import COMMERCE_GATE, ScopeCommerceService

    if connection is None:
        pool = await _pool()
        async with pool.acquire() as conn, conn.transaction():
            return await end_paid_purchase(
                actor_user_id, purchase_id, as_owner=as_owner, connection=conn
            )
    await connection.execute("SELECT pg_advisory_xact_lock($1)", COMMERCE_GATE)
    row = await connection.fetchrow(
        "SELECT * FROM scope_commerce_purchases WHERE purchase_id=$1", UUID(purchase_id)
    )
    if not row:
        raise ValueError("purchase_unavailable")
    expected_actor = str(row["owner_user_id"] if as_owner else row["payer_user_id"])
    if actor_user_id != expected_actor:
        raise PermissionError("purchase_unavailable")
    request_id = str(row["request_id"])
    await _request_lock(connection, request_id)
    row = dict(
        await connection.fetchrow(
            "SELECT * FROM scope_commerce_purchases WHERE purchase_id=$1 FOR UPDATE",
            UUID(purchase_id),
        )
    )
    if row["status"] in {"revoked", "expired", "failed"}:
        return public(row)
    now = await connection.fetchval("SELECT clock_timestamp()")
    if not as_owner and row["status"] == "staged" and now >= row["activation_at"]:
        raise ValueError("buyer_cancellation_after_activation_denied")
    service = ScopeCommerceService()
    result = await service.revoke_purchase(
        owner_user_id=str(row["owner_user_id"]), purchase_id=purchase_id, conn=connection
    )
    await _record_purchase_end(connection, row, purchase_id, as_owner)
    return result


async def _record_purchase_end(
    connection: Any, row: dict, purchase_id: str, as_owner: bool
) -> None:
    from hushh_mcp.services.consent_db import ConsentDBService

    request_id = str(row["request_id"])
    prior = await connection.fetchrow(
        """SELECT agent_id,scope,metadata FROM consent_audit WHERE request_id=$1
           AND action IN ('REQUESTED','CONSENT_PAID_APPROVED','CONSENT_PAID_FUNDED','CONSENT_GRANTED')
           ORDER BY issued_at DESC,id DESC LIMIT 1""",
        request_id,
    )
    if prior:
        metadata = _metadata(prior["metadata"])
        agent_id, scope = str(prior["agent_id"]), str(prior["scope"])
    else:
        market = await connection.fetchrow(
            "SELECT metadata FROM marketplace_access_requests WHERE id::text=$1 FOR UPDATE",
            request_id,
        )
        metadata = _metadata(market["metadata"]) if market else {}
        agent_id = str(metadata.get("requester_principal") or "")
        scope = str(row["machine_scope"])
    metadata = {
        **metadata,
        "commercial_required": True,
        "commerce_purchase_id": purchase_id,
        "request_id": request_id,
        "commerce_status": "revoked",
    }
    if metadata.get("request_source") == "marketplace":
        await connection.execute(
            """UPDATE marketplace_access_requests SET status=$2,resolved_at=now(),
                 latest_envelope_id=NULL,metadata=$3::jsonb WHERE id::text=$1""",
            request_id,
            "revoked" if as_owner else "denied",
            json.dumps(metadata),
        )
    await ConsentDBService().insert_event(
        user_id=str(row["owner_user_id"]),
        agent_id=agent_id,
        scope=scope,
        action="REVOKED" if as_owner else "CANCELLED",
        request_id=request_id,
        metadata=metadata,
        connection=connection,
    )


async def admitted_request_status(row: dict[str, Any] | None) -> dict[str, Any] | None:
    if row is None:
        return None
    from hushh_mcp.consent.paid_admission import is_paid_grant, paid_grant_is_admitted

    metadata = _metadata(row.get("metadata"))
    if not is_paid_grant(metadata):
        return row
    from hushh_mcp.services.scope_commerce.service import ScopeCommerceService

    try:
        purchase = await ScopeCommerceService().lookup_by_request(str(row.get("request_id") or ""))
    except Exception:
        purchase = None
    row = {
        **row,
        "metadata": {
            **metadata,
            "commerce_status": purchase["status"] if purchase else "unavailable",
            "request_id": str(row.get("request_id") or ""),
        },
    }
    if row.get("action") == "CONSENT_GRANTED" and not await paid_grant_is_admitted(
        str(row.get("token_id") or ""), metadata
    ):
        row.update(action="CONSENT_PAID_APPROVED", token_id=None)
    return row
