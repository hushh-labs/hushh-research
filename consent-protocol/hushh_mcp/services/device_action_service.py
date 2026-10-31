"""Single-use own-device revocation admission; the existing writer owns effects."""

import math
from collections.abc import Awaitable, Callable
from typing import Any
from uuid import uuid4

from asyncpg import UniqueViolationError

from hushh_mcp.services import device_action_proof
from hushh_mcp.services.phone_recovery_continuation import ready
from hushh_mcp.services.phone_recovery_state import (
    binding,
    bound_owner_drafts,
    phone_hint,
    refuse,
    require_producer_enabled,
    same_binding,
    transaction,
)


async def prepare(user_id: str, device: str, continuation: str | None) -> dict[str, Any]:
    require_producer_enabled()
    operation = str(uuid4())
    async with transaction() as conn:
        await bound_owner_drafts(conn, "account_device_actions", user_id)
        current = await binding(conn, user_id)
        if not current:
            raise refuse("DEVICE_ACTION_LINKED_PHONE_REQUIRED", 403)
        if continuation:
            state, _, _ = await ready(conn, user_id, continuation, action="revoke")
            if state != "ready":
                raise refuse("PHONE_RECOVERY_PREVIOUS_SIGN_IN_REQUIRED", 403)
        exists = await conn.fetchval(
            "SELECT EXISTS(SELECT 1 FROM trusted_devices WHERE user_id=$1 AND device_id=$2 AND status='active')",
            user_id,
            device,
        )
        if not exists:
            raise refuse("TRUSTED_DEVICE_NOT_FOUND", 404)
        row = await conn.fetchrow(
            """INSERT INTO account_device_actions
            (operation_id,user_id,device_id,phone_digest,binding_revision,generation,continuation_id,expires_at)
            VALUES($1::uuid,$2,$3,$4,$5,$6,$7::uuid,clock_timestamp()+INTERVAL '5 minutes')
            RETURNING created_at,expires_at,EXTRACT(EPOCH FROM clock_timestamp()) AS server_now""",
            operation,
            user_id,
            device,
            current["phone_digest"],
            current["binding_revision"],
            current["generation"],
            continuation,
        )
    challenge = device_action_proof.fixture_challenge(current["phone"])
    result = {
        "operation_id": operation,
        "state": "prepared",
        "expires_at": row["expires_at"].isoformat(),
        "phone_hint": phone_hint(current),
        "transport": "configured_test" if challenge else "sms",
        "proof_wait_ms": max(
            0,
            min(
                1000,
                math.ceil(
                    (math.ceil(row["created_at"].timestamp()) - float(row["server_now"])) * 1000
                ),
            ),
        ),
    }
    if challenge:
        result["test_verification_id"] = challenge
    return result


async def _load(conn: Any, user_id: str, operation: str, device: str | None = None):
    row = await conn.fetchrow(
        "SELECT *,expires_at>clock_timestamp() AS live FROM account_device_actions WHERE operation_id=$1::uuid AND user_id=$2 FOR UPDATE",
        operation,
        user_id,
    )
    if not row or (device is not None and row["device_id"] != device):
        raise refuse("DEVICE_ACTION_NOT_FOUND", 404)
    return row


def _receipt(row: Any) -> dict[str, Any]:
    result = {
        "operation_id": str(row["operation_id"]),
        "state": row["state"],
        "device_id": row["device_id"],
    }
    if row["state"] == "cancelled":
        result.update(state="not_started", code="DEVICE_ACTION_NOT_STARTED")
    if row["state"] == "completed":
        result.update(success=True, podBindingVersion=row["pod_binding_version"])
    return result


async def _require_binding(conn: Any, row: Any, user_id: str):
    current = await binding(conn, user_id)
    if not row["live"] or not same_binding(row, current):
        raise refuse("DEVICE_ACTION_STALE", 409)
    if row["continuation_id"]:
        state, _, _ = await ready(conn, user_id, str(row["continuation_id"]), action="revoke")
        if state != "ready":
            raise refuse("PHONE_RECOVERY_PREVIOUS_SIGN_IN_REQUIRED", 403)
    return current


async def confirm(
    user_id: str,
    device: str,
    operation: str,
    *,
    phone_id_token: str | None,
    test_code: str | None,
    revoke: Callable[[str, str], Awaitable[dict[str, Any]]],
) -> dict[str, Any]:
    async with transaction() as conn:
        row = await _load(conn, user_id, operation, device)
        if row["state"] != "prepared":
            return _receipt(row)
        require_producer_enabled()
        current = await _require_binding(conn, row, user_id)
        created = row["created_at"].timestamp()
    digest = await device_action_proof.verify(
        user_id,
        operation,
        current["phone"],
        created,
        phone_id_token=phone_id_token,
        test_code=test_code,
    )
    try:
        async with transaction() as conn:
            row = await _load(conn, user_id, operation, device)
            if row["state"] != "prepared":
                return _receipt(row)
            await _require_binding(conn, row, user_id)
            await conn.execute(
                """UPDATE account_device_actions SET state='pending',proof_event_digest=$2,
                dispatched_at=clock_timestamp() WHERE operation_id=$1::uuid""",
                operation,
                digest,
            )
    except UniqueViolationError:
        raise refuse("DEVICE_ACTION_PROOF_ALREADY_USED", 409) from None
    # Admission is durable BEFORE dispatch. Retrying this exact operation reads
    # status and can never repeat the primary revocation after a lost response.
    return await _dispatch(user_id, device, operation, revoke)


async def _dispatch(user_id: str, device: str, operation: str, revoke: Any) -> dict[str, Any]:
    try:
        receipt = await revoke(device, user_id)
        version = receipt.get("podBindingVersion")
        if (
            receipt.get("success") is not True
            or not isinstance(version, int)
            or isinstance(version, bool)
        ):
            raise ValueError("canonical revocation receipt unavailable")
    except Exception:
        async with transaction() as conn:
            await conn.execute(
                "UPDATE account_device_actions SET state='action_required' WHERE operation_id=$1::uuid AND state='pending'",
                operation,
            )
            return _receipt(await _load(conn, user_id, operation, device))
    async with transaction() as conn:
        await conn.execute(
            "UPDATE account_device_actions SET state='completed',pod_binding_version=$2 WHERE operation_id=$1::uuid AND state IN ('pending','action_required')",
            operation,
            version,
        )
        return _receipt(await _load(conn, user_id, operation, device))


async def status(user_id: str, operation: str, *, reconcile: Any = None) -> dict[str, Any]:
    async with transaction() as conn:
        row = await _load(conn, user_id, operation)
        if row["state"] == "pending":
            old = await conn.fetchval(
                "SELECT dispatched_at<clock_timestamp()-INTERVAL '30 seconds' FROM account_device_actions WHERE operation_id=$1::uuid",
                operation,
            )
            if old:
                await conn.execute(
                    "UPDATE account_device_actions SET state='action_required' WHERE operation_id=$1::uuid AND state='pending'",
                    operation,
                )
                row = await _load(conn, user_id, operation)
        if row["state"] == "prepared":
            current = await binding(conn, user_id)
            state = (
                "expired"
                if not row["live"]
                else "prepared"
                if same_binding(row, current)
                else "stale"
            )
            return {**_receipt(row), "state": state}
        result = _receipt(row)
    if reconcile and result["state"] in {"pending", "action_required"}:
        return await _reconcile(user_id, operation, result, reconcile)
    return result


async def cancel(user_id: str, operation: str) -> dict[str, Any]:
    async with transaction() as conn:
        row = await _load(conn, user_id, operation)
        if row["state"] == "prepared":
            # Confirmation takes the same row lock after phone verification.
            # Once cancelled, that late proof cannot admit a primary effect.
            await conn.execute(
                "UPDATE account_device_actions SET state='cancelled' WHERE operation_id=$1::uuid AND state='prepared'",
                operation,
            )
            row = await _load(conn, user_id, operation)
        return _receipt(row)


async def _reconcile(user_id: str, operation: str, result: dict, reconcile: Any) -> dict[str, Any]:
    try:
        receipt = await reconcile(result["device_id"], user_id)
        version = receipt.get("podBindingVersion") if receipt else None
        if (
            receipt
            and receipt.get("success") is True
            and isinstance(version, int)
            and not isinstance(version, bool)
        ):
            async with transaction() as conn:
                await conn.execute(
                    "UPDATE account_device_actions SET state='completed',pod_binding_version=$2 WHERE operation_id=$1::uuid AND state IN ('pending','action_required')",
                    operation,
                    version,
                )
                return _receipt(await _load(conn, user_id, operation))
    except Exception:
        pass
    # A still-active row cannot prove an earlier dispatcher will never run.
    # Keep its consumed event and report support, never dispatch revoke again.
    return {**result, "code": "DEVICE_ACTION_SUPPORT_REQUIRED"}


async def pending_for_owner(user_id: str) -> list[dict[str, Any]]:
    async with transaction() as conn:
        rows = await conn.fetch(
            """SELECT * FROM account_device_actions WHERE user_id=$1 AND
            (state IN ('pending','action_required') OR (state='prepared' AND expires_at>clock_timestamp()) OR
             (state='completed' AND expires_at>clock_timestamp()-INTERVAL '7 days'))
            ORDER BY created_at DESC LIMIT 20""",
            user_id,
        )
        return [_receipt(row) for row in rows]
