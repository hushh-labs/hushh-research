"""Bounded metadata shared by recovery navigation and own-device action proofs."""

from contextlib import asynccontextmanager
from typing import Any

from fastapi import HTTPException

from db.connection import get_pool
from hushh_mcp.services.account_deletion_lifecycle_service import (
    AccountDeletionLifecycleService,
    account_deletion_phone_digest,
)


def refuse(code: str, status: int = 409) -> HTTPException:
    return HTTPException(
        status_code=status,
        detail={"code": code},
        headers={"Cache-Control": "private, no-store"},
    )


def require_producer_enabled() -> None:
    from api.middlewares.auth_reliability_trace import request_feature_enabled

    if not request_feature_enabled("AUTH_PHONE_RECOVERY_ENABLED"):
        raise refuse("PHONE_RECOVERY_UNAVAILABLE", 503)


@asynccontextmanager
async def transaction():
    pool = await get_pool()
    async with pool.acquire() as conn:
        async with conn.transaction():
            await conn.execute("SET LOCAL lock_timeout='3000ms'")
            await conn.execute("SET LOCAL statement_timeout='5000ms'")
            yield conn


async def binding(conn: Any, user_id: str) -> dict[str, Any] | None:
    active = await AccountDeletionLifecycleService.active_projection_user_ids(
        conn, user_ids=[user_id]
    )
    if user_id not in active:
        return None
    row = await conn.fetchrow(
        """SELECT phone_number,phone_binding_revision FROM actor_identity_cache
        WHERE user_id=$1 AND phone_verified=TRUE FOR SHARE""",
        user_id,
    )
    if not row or not row["phone_number"]:
        return None
    generation = await conn.fetchval(
        "SELECT generation FROM account_generations WHERE owner_id=$1 AND retired_at IS NULL",
        user_id,
    )
    return {
        "phone": row["phone_number"],
        "phone_digest": account_deletion_phone_digest(row["phone_number"]),
        "binding_revision": row["phone_binding_revision"],
        "generation": generation or 0,
    }


def same_binding(row: Any, current: dict[str, Any] | None) -> bool:
    if not current:
        return False
    return all(
        row[key] == current[key] for key in ("phone_digest", "binding_revision", "generation")
    )


def phone_hint(current: dict[str, Any]) -> str:
    return "••" + current["phone"][-2:]


_DRAFT_QUERIES = {
    "account_phone_recovery_continuations": (
        "DELETE FROM account_phone_recovery_continuations WHERE operation_id IN "
        "(SELECT operation_id FROM account_phone_recovery_continuations "
        "WHERE expires_at<clock_timestamp()-INTERVAL '1 hour' ORDER BY expires_at LIMIT 100)",
        "SELECT count(*) FROM account_phone_recovery_continuations "
        "WHERE requester_user_id=$1 AND expires_at>clock_timestamp()",
    ),
    "account_device_actions": (
        "DELETE FROM account_device_actions WHERE operation_id IN "
        "(SELECT operation_id FROM account_device_actions "
        "WHERE ((state IN ('prepared','cancelled') AND expires_at<clock_timestamp()-INTERVAL '1 hour') "
        "OR (state='completed' AND expires_at<clock_timestamp()-INTERVAL '7 days')) "
        "ORDER BY expires_at LIMIT 100)",
        "SELECT count(*) FROM account_device_actions WHERE user_id=$1 AND "
        "(state IN ('pending','action_required') OR created_at>clock_timestamp()-INTERVAL '5 minutes')",
    ),
}


async def bound_owner_drafts(conn: Any, table: str, owner: str) -> None:
    # Relation names and query structure are static; only the owner is bound.
    if table not in _DRAFT_QUERIES:
        raise ValueError("unknown recovery draft family")
    prune, count_query = _DRAFT_QUERIES[table]
    await conn.execute(
        "SELECT pg_advisory_xact_lock(hashtextextended($1,0))", f"phone-recovery:{owner}"
    )
    await conn.execute(prune)
    count = await conn.fetchval(count_query, owner)
    if count >= 5:
        raise refuse("PHONE_RECOVERY_LIMIT_REACHED", 429)
