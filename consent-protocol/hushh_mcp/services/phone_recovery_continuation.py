"""Opaque recovery navigation, deliberately separate from account authority."""

from typing import Any
from uuid import uuid4

from hushh_mcp.services.account_deletion_lifecycle_service import account_deletion_phone_digest
from hushh_mcp.services.phone_recovery_state import (
    binding,
    bound_owner_drafts,
    phone_hint,
    refuse,
    require_producer_enabled,
    same_binding,
    transaction,
)
from hushh_mcp.services.user_identifier_service import normalize_phone_identifier


async def create(user_id: str, action: str, phone: str) -> dict[str, Any]:
    require_producer_enabled()
    normalized = normalize_phone_identifier(phone) if phone.startswith("+") else None
    if not normalized:
        raise refuse("PHONE_RECOVERY_INVALID_NUMBER", 422)
    operation = str(uuid4())
    async with transaction() as conn:
        await bound_owner_drafts(conn, "account_phone_recovery_continuations", user_id)
        target = await conn.fetchval(
            "SELECT user_id FROM actor_identity_cache WHERE phone_number=$1 AND phone_verified=TRUE",
            normalized,
        )
        current = await binding(conn, target) if target and target != user_id else None
        row = await conn.fetchrow(
            """INSERT INTO account_phone_recovery_continuations
            (operation_id,requester_user_id,target_user_id,action,phone_digest,binding_revision,generation,expires_at)
            VALUES($1::uuid,$2,$3,$4,$5,$6,$7,clock_timestamp()+INTERVAL '15 minutes') RETURNING expires_at""",
            operation,
            user_id,
            target if current else None,
            action,
            account_deletion_phone_digest(normalized),
            current["binding_revision"] if current else None,
            current["generation"] if current else None,
        )
    return {
        "continuation_id": operation,
        "state": "awaiting_previous_sign_in",
        "expires_at": row["expires_at"].isoformat(),
    }


async def ready(conn: Any, user_id: str, operation: str, *, action: str | None = None):
    row = await conn.fetchrow(
        "SELECT *,expires_at>clock_timestamp() AS live FROM account_phone_recovery_continuations WHERE operation_id=$1::uuid",
        operation,
    )
    if not row or row["target_user_id"] != user_id or row["requester_user_id"] == user_id:
        return "awaiting_previous_sign_in", None, None
    if not row["live"]:
        return "expired", None, None
    current = await binding(conn, user_id)
    if not same_binding(row, current) or (action and row["action"] != action):
        return "stale", None, None
    return "ready", row, current


async def read(user_id: str, operation: str) -> dict[str, Any]:
    async with transaction() as conn:
        state, row, current = await ready(conn, user_id, operation)
    result = {"continuation_id": operation, "state": state}
    if row is not None and current is not None:
        result.update(
            action=row["action"],
            expires_at=row["expires_at"].isoformat(),
            phone_hint=phone_hint(current),
        )
    return result


async def require_ready(user_id: str, operation: str, *, action: str) -> None:
    async with transaction() as conn:
        state, _, _ = await ready(conn, user_id, operation, action=action)
        if state != "ready":
            raise refuse("PHONE_RECOVERY_PREVIOUS_SIGN_IN_REQUIRED", 403)
