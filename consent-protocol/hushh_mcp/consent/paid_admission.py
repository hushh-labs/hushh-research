"""Server-paid admission policy and stable consent lifecycle facade.

Free grants never depend on optional commercial storage. Known paid grants must
satisfy canonical purchase/recipient/request authority and database activation time.
"""

from __future__ import annotations

import json
from datetime import datetime
from typing import Any

from db.connection import get_pool


def _metadata(value: Any) -> dict:
    if isinstance(value, dict):
        return value
    if isinstance(value, str):
        parsed = json.loads(value)
        return parsed if isinstance(parsed, dict) else {}
    return {}


def is_paid_grant(metadata: dict | None) -> bool:
    metadata = metadata or {}
    return metadata.get("commercial_required") is True or bool(metadata.get("commerce_purchase_id"))


async def paid_grant_is_admitted(
    token: str, metadata: dict | None, *, connection: Any = None
) -> bool:
    """Only server ledger linkage enables the commercial lookup; paid fails closed."""
    if not is_paid_grant(metadata):
        return True
    if connection is None:
        try:
            pool = await get_pool()
            async with pool.acquire() as conn, conn.transaction():
                await conn.execute("SELECT pg_advisory_xact_lock($1)", 2690001)
                return await paid_grant_is_admitted(token, metadata, connection=conn)
        except Exception:
            return False
    from hushh_mcp.services.scope_commerce.service import ScopeCommerceService
    from hushh_mcp.services.scope_commerce_requests import resolve_commerce_request

    try:
        service = ScopeCommerceService()
        await service._environment(connection)
        purchase = await service.lookup_by_consent_token(token, conn=connection)
        if not purchase:
            return False
        purchase = dict(purchase)
        expected_purchase = str((metadata or {}).get("commerce_purchase_id") or "")
        if not expected_purchase or str(purchase.get("purchase_id")) != expected_purchase:
            return False
        now = purchase.get("admission_now") or await connection.fetchval("SELECT clock_timestamp()")
        start, end = purchase.get("activation_at"), purchase.get("expires_at")
        if isinstance(start, str):
            start = datetime.fromisoformat(start.replace("Z", "+00:00"))
        if isinstance(end, str):
            end = datetime.fromisoformat(end.replace("Z", "+00:00"))
        if (
            purchase.get("erased_at")
            or purchase.get("status") != "staged"
            or not start
            or not end
            or not start <= now < end
        ):
            return False
        binding = await resolve_commerce_request(
            str(purchase["request_id"]), str(purchase["owner_user_id"]), connection=connection
        )
        return all(
            str(binding.get(key) or "") == str(purchase.get(key) or "")
            for key in (
                "owner_user_id",
                "payer_user_id",
                "buyer_app_id",
                "machine_scope",
                "scope_handle",
                "recipient_key_fingerprint",
            )
        ) and binding["consent_action"] in {"CONSENT_GRANTED", "approved"}
    except Exception:
        # Missing migration, key rotation, revoked authority and storage failure
        # all deny a known paid grant. No feature flag can turn it into free.
        return False


async def _request_lock(conn: Any, request_id: str) -> None:
    await conn.execute(
        "SELECT pg_advisory_xact_lock(hashtextextended($1,0))", "consent-request:" + request_id
    )


async def approve_paid_request(
    owner_user_id: str,
    request_id: str,
    duration_seconds: int,
    idempotency_key: str,
    *,
    connection: Any = None,
) -> dict | None:
    from hushh_mcp.consent.paid_requests import approve_paid_request as approve

    return await approve(
        owner_user_id, request_id, duration_seconds, idempotency_key, connection=connection
    )


async def maybe_approve_paid_request(
    *,
    owner_user_id: str,
    request_id: str,
    machine_scope: str,
    metadata: dict,
    duration_seconds: int,
) -> dict | None:
    from hushh_mcp.consent.paid_requests import maybe_approve_paid_request as approve

    return await approve(
        owner_user_id=owner_user_id,
        request_id=request_id,
        machine_scope=machine_scope,
        metadata=metadata,
        duration_seconds=duration_seconds,
    )


async def verify_source_revisions(
    conn: Any, owner_user_id: str, machine_scope: str, revisions: dict
) -> None:
    from hushh_mcp.consent.paid_exports import verify_source_revisions as verify

    await verify(conn, owner_user_id, machine_scope, revisions)


async def finalize_paid_export(conn: Any, purchase: dict) -> dict:
    from hushh_mcp.consent.paid_exports import finalize_paid_export as finalize

    return await finalize(conn, purchase)


async def record_paid_funded(conn: Any, purchase: dict) -> None:
    from hushh_mcp.consent.paid_requests import record_paid_funded as record

    await record(conn, purchase)


async def validate_free_grant_commit(conn: Any, owner_user_id: str, machine_scope: str) -> None:
    from hushh_mcp.consent.paid_requests import validate_free_grant_commit as validate

    await validate(conn, owner_user_id, machine_scope)


async def end_paid_purchase(
    actor_user_id: str, purchase_id: str, *, as_owner: bool, connection: Any = None
) -> dict:
    from hushh_mcp.consent.paid_requests import end_paid_purchase as end

    return await end(actor_user_id, purchase_id, as_owner=as_owner, connection=connection)


async def exact_paid_scope_admission(
    db: Any, user_id: str, scope: str, agent_id: str | None, token: str
) -> bool | None:
    """None delegates established free lineage; an exact paid grant never does."""
    from hushh_mcp.services.consent_commerce_ports import exact_scope_grant

    grant = await exact_scope_grant(db, user_id, scope, agent_id, token)
    metadata = _metadata(grant.get("metadata")) if grant else {}
    if is_paid_grant(metadata):
        return await paid_grant_is_admitted(token, metadata)
    return None


def _latest_external_grants(
    service: Any, rows: list[dict], agent_id: str | None, scope: str | None
) -> list[dict]:
    from hushh_mcp.services.consent_event_authority import event_is_newer

    # Free lineage and independent purchased terms share one audit source.
    latest_per_agent_scope = {}
    paid_request_ids = {
        str(row.get("request_id"))
        for row in rows or []
        if service._parse_metadata(row.get("metadata")).get("commercial_required") is True
    }
    for row in rows:
        if not service._is_external_audit_row(row):
            continue
        row_metadata = service._parse_metadata(row.get("metadata"))
        row_scope = row.get("scope")
        row_agent_id = row.get("agent_id") or ""
        if row.get("action") == "CONSENT_DENIED" and row_agent_id != "personal_agent":
            continue
        if not row_scope:
            continue

        if agent_id and row_agent_id != agent_id:
            continue
        if scope and row_scope != scope:
            continue

        if (
            row_metadata.get("commercial_required") is True
            and row.get("action") == "CONSENT_GRANTED"
        ):
            key = (row_agent_id, row_scope, str(row.get("token_id")))
        elif str(row.get("request_id")) in paid_request_ids:
            continue
        else:
            key = (row_agent_id, row_scope)
        if key not in latest_per_agent_scope:
            latest_per_agent_scope[key] = row
            continue

        if event_is_newer(row, latest_per_agent_scope[key]):
            latest_per_agent_scope[key] = row

    return list(latest_per_agent_scope.values())


async def active_external_grants(
    service: Any,
    rows: list[dict],
    user_id: str,
    agent_id: str | None,
    scope: str | None,
    now_ms: int,
) -> list[dict]:
    from hushh_mcp.consent.pkm_scope_policy import is_source_library_pkm_scope

    # Filter to only active (CONSENT_GRANTED and not expired)
    results = []
    for row in _latest_external_grants(service, rows, agent_id, scope):
        if row.get("action") == "CONSENT_GRANTED":
            if is_source_library_pkm_scope(str(row.get("scope") or "")):
                continue
            expires_at = row.get("expires_at")
            from hushh_mcp.consent.paid_admission import is_paid_grant, paid_grant_is_admitted

            metadata = service._parse_metadata(row.get("metadata"))
            if is_paid_grant(metadata) or expires_at is None or expires_at > now_ms:
                token_id = row.get("token_id")
                if not await paid_grant_is_admitted(str(token_id or ""), metadata):
                    continue
                results.append(
                    {
                        "id": (
                            token_id[:20] + "..."
                            if token_id and len(token_id) > 20
                            else str(row.get("id"))
                        ),
                        "user_id": row.get("user_id") or user_id,
                        "scope": row.get("scope"),
                        "developer": row.get("agent_id"),
                        "agent_id": row.get("agent_id"),
                        "issued_at": row.get("issued_at"),
                        "expires_at": expires_at,
                        "time_remaining_ms": ((expires_at - now_ms) if expires_at else 0),
                        "request_id": row.get("request_id"),
                        "token_id": token_id,
                        "metadata": service._parse_metadata(row.get("metadata")) or None,
                    }
                )

    return results
