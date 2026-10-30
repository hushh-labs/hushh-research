"""Phone-proven deletion of the account holding a verified number.

A fresh real SMS proof (or, in UAT only, the configured fixture code) authorizes
the existing full-account erasure of the number's current verified holder.
Preparation is opaque: nothing about the holder is decided or revealed before
the proof verifies. The requester then claims the number through the existing
phone writers, which never treat an admitted deletion as an owner. This policy
stays off in every environment unless explicitly enabled.
"""

from __future__ import annotations

import hashlib
import logging
import os
import time
from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from typing import Any
from uuid import uuid4

from asyncpg import UniqueViolationError
from fastapi import HTTPException
from sqlalchemy import text
from starlette.concurrency import run_in_threadpool

from hushh_mcp.services.account_deletion_lifecycle_service import (
    account_deletion_phone_digest,
    account_deletion_user_hash,
)
from hushh_mcp.services.phone_recovery_state import (
    binding,
    refuse,
    require_producer_enabled,
    same_binding,
    transaction,
)
from hushh_mcp.services.user_identifier_service import normalize_phone_identifier

logger = logging.getLogger(__name__)

DeletePort = Callable[[str, Callable[[Any], None]], Awaitable[dict[str, Any]]]
_SELECT = """SELECT *,expires_at>clock_timestamp() AS live,
    dispatched_at<clock_timestamp()-INTERVAL '30 seconds' AS stale
    FROM account_phone_linked_deletions WHERE operation_id=$1::uuid AND requester_hash=$2"""
_SELECT_FOR_UPDATE = """SELECT *,expires_at>clock_timestamp() AS live,
    dispatched_at<clock_timestamp()-INTERVAL '30 seconds' AS stale
    FROM account_phone_linked_deletions WHERE operation_id=$1::uuid AND requester_hash=$2
    FOR UPDATE"""
_PRUNE = """DELETE FROM account_phone_linked_deletions WHERE operation_id IN
    (SELECT operation_id FROM account_phone_linked_deletions
     WHERE (state IN ('prepared','cancelled') AND expires_at<clock_timestamp()-INTERVAL '1 hour')
        OR (state IN ('admitted','refused','pending','action_required')
            AND expires_at<clock_timestamp()-INTERVAL '90 days')
     ORDER BY expires_at LIMIT 100)"""
# A rate limit, not a lock: an unsettled receipt never blocks the requester for good.
_OPEN_DRAFTS = """SELECT count(*) FROM account_phone_linked_deletions WHERE requester_hash=$1 AND
    created_at>clock_timestamp()-INTERVAL '5 minutes'"""
_INSERT = """INSERT INTO account_phone_linked_deletions
    (operation_id,requester_user_id,requester_hash,target_user_id,target_hash,phone_digest,
     binding_revision,generation,transport,expires_at)
    VALUES($1::uuid,$2,$3,$4,$5,$6,$7,$8,$9,clock_timestamp()+INTERVAL '5 minutes')
    RETURNING operation_id,expires_at,transport"""
_REFUSE = """UPDATE account_phone_linked_deletions SET state='refused',result_code=$2
    WHERE operation_id=$1::uuid AND state='prepared'"""
_PENDING = """UPDATE account_phone_linked_deletions SET state='pending',proof_event_digest=$2,
    dispatched_at=clock_timestamp() WHERE operation_id=$1::uuid AND state='prepared'"""
_FINISH = """UPDATE account_phone_linked_deletions SET state=$2,result_code=$3
    WHERE operation_id=$1::uuid AND state IN ('pending','action_required')"""
_FAILED_PROOF = """UPDATE account_phone_linked_deletions SET failed_proof_count=failed_proof_count+1,
    state=CASE WHEN failed_proof_count+1>=5 THEN 'cancelled' ELSE state END,
    result_code=CASE WHEN failed_proof_count+1>=5 THEN 'PHONE_LINKED_DELETION_ATTEMPTS_EXCEEDED'
                     ELSE result_code END
    WHERE operation_id=$1::uuid AND requester_hash=$2 AND state='prepared'"""
_CANCEL = """UPDATE account_phone_linked_deletions SET state='cancelled'
    WHERE operation_id=$1::uuid AND requester_hash=$2 AND state='prepared'"""
_ADMITTED = """SELECT EXISTS(SELECT 1 FROM account_deletion_tombstones
    WHERE user_id_hash=$1 AND cleanup_intent_kind='full_account')"""


@dataclass(frozen=True)
class _Proof:
    method: str
    digest: str
    uid: str | None


def _production_runtime() -> bool:
    return any(
        str(os.getenv(name) or "").strip().lower() in {"prod", "production"}
        for name in ("ENVIRONMENT", "HUSHH_DEPLOY_ENV", "APP_RUNTIME_PROFILE")
    )


def enabled() -> bool:
    """Explicit opt-in only; the default delete flow requires the previous owner."""
    explicit = str(os.getenv("HUSHH_PHONE_LINKED_DELETION_ENABLED") or "").strip().lower()
    if explicit:
        return explicit in {"1", "true", "yes", "on"}
    return False


def _require_enabled() -> None:
    if not enabled():
        raise refuse("PHONE_LINKED_DELETION_UNAVAILABLE", 503)
    require_producer_enabled()


def _normalized(phone: str) -> str:
    normalized = normalize_phone_identifier(phone) if str(phone or "").startswith("+") else None
    if not normalized:
        raise refuse("PHONE_RECOVERY_INVALID_NUMBER", 422)
    return normalized


def fixture_transport(owner: str, phone: str) -> bool:
    """A shared fixture code is possession only for UAT fixture numbers."""
    from hushh_mcp.services import phone_test_transport as fixtures
    from hushh_mcp.services.dev_reviewer_phone_transport import (
        configured_dev_reviewer_phone_transport,
    )

    if _production_runtime() or not (
        fixtures._is_uat_environment() or fixtures._isolated_phone_fixture_enabled()
    ):
        return False
    reviewer = configured_dev_reviewer_phone_transport()
    if reviewer is not None and reviewer.admits(owner, phone):
        return False
    return bool(fixtures._configured_uat_phone_test_code()) and (
        phone in fixtures._configured_uat_phone_test_numbers()
    )


def _receipt(row: Any) -> dict[str, Any]:
    state = row["state"]
    if state == "prepared" and not row["live"]:
        state = "expired"
    result: dict[str, Any] = {"operation_id": str(row["operation_id"]), "state": state}
    code = row["result_code"] or (
        "PHONE_LINKED_DELETION_SUPPORT_REQUIRED" if state == "action_required" else None
    )
    if code:
        result["code"] = code
    return result


async def _row(conn: Any, owner: str, operation: str, *, lock: bool = False) -> Any:
    row = await conn.fetchrow(
        _SELECT_FOR_UPDATE if lock else _SELECT, operation, account_deletion_user_hash(owner)
    )
    if not row:
        raise refuse("PHONE_LINKED_DELETION_NOT_FOUND", 404)
    return row


async def prepare(owner: str, phone: str) -> dict[str, Any]:
    """Open one opaque operation; the response never depends on who holds the number."""
    _require_enabled()
    normalized = _normalized(phone)
    requester = account_deletion_user_hash(owner)
    async with transaction() as conn:
        await conn.execute(
            "SELECT pg_advisory_xact_lock(hashtextextended($1,0))",
            f"phone-linked-deletion:{requester}",
        )
        await conn.execute(_PRUNE)
        if await conn.fetchval(_OPEN_DRAFTS, requester) >= 5:
            raise refuse("PHONE_RECOVERY_LIMIT_REACHED", 429)
        holder = await conn.fetchval(
            "SELECT user_id FROM actor_identity_cache WHERE phone_number=$1 AND phone_verified=TRUE",
            normalized,
        )
        current = await binding(conn, holder) if holder and holder != owner else None
        if current and current["phone"] != normalized:
            current = None
        row = await conn.fetchrow(
            _INSERT,
            str(uuid4()),
            owner,
            requester,
            holder if current else None,
            account_deletion_user_hash(holder) if current else None,
            account_deletion_phone_digest(normalized),
            current["binding_revision"] if current else None,
            current["generation"] if current else None,
            "configured_test" if fixture_transport(owner, normalized) else "sms",
        )
    return {
        "operation_id": str(row["operation_id"]),
        "state": "prepared",
        "expires_at": row["expires_at"].isoformat(),
        "phone_hint": "••" + normalized[-2:],
        "transport": row["transport"],
    }


async def confirm(
    owner: str,
    operation: str,
    phone: str,
    *,
    phone_id_token: str | None,
    test_code: str | None,
    delete: DeletePort,
) -> dict[str, Any]:
    _require_enabled()
    normalized = _normalized(phone)
    async with transaction() as conn:
        row = await _row(conn, owner, operation)
    if row["state"] != "prepared" or not row["live"]:
        return _receipt(row)
    if account_deletion_phone_digest(normalized) != row["phone_digest"]:
        raise refuse("PHONE_LINKED_DELETION_STALE", 409)
    proof = await _verify_proof(
        owner, operation, normalized, row["transport"], phone_id_token, test_code
    )
    # Holder facts are decided only after possession is proven.
    if proof.uid and await _recovery_required(proof.uid, normalized):
        return await _refuse(owner, operation, "PHONE_LINKED_DELETION_RECOVERY_REQUIRED")
    if row["target_hash"] is None:
        return await _refuse(owner, operation, "PHONE_LINKED_ACCOUNT_NOT_FOUND")
    refused = await _admit(owner, operation, row, proof)
    if refused is not None:
        return refused
    return await _dispatch(owner, operation, row, delete)


async def _refuse(owner: str, operation: str, code: str) -> dict[str, Any]:
    async with transaction() as conn:
        await conn.execute(_REFUSE, operation, code)
        return _receipt(await _row(conn, owner, operation))


async def _admit(owner: str, operation: str, row: Any, proof: _Proof) -> dict[str, Any] | None:
    """Record durable admission BEFORE dispatch; a lost response can never replay it."""
    target = row["target_user_id"]
    try:
        async with transaction() as conn:
            # Shared owner barriers first, then the row lock: erasure of the
            # target takes those barriers before detaching this row.
            current = await binding(conn, target) if target else None
            locked = await _row(conn, owner, operation, lock=True)
            if locked["state"] != "prepared" or not locked["live"]:
                return _receipt(locked)
            code = None
            if current is None or locked["target_user_id"] != target:
                code = "PHONE_LINKED_ACCOUNT_NOT_FOUND"
            elif not same_binding(locked, current):
                code = "PHONE_LINKED_DELETION_STALE"
            elif await _protected(conn, target):
                code = "PHONE_LINKED_ACCOUNT_PROTECTED"
            if code:
                await conn.execute(_REFUSE, operation, code)
                return _receipt(await _row(conn, owner, operation))
            await conn.execute(_PENDING, operation, proof.digest)
    except UniqueViolationError:
        raise refuse("PHONE_LINKED_DELETION_PROOF_ALREADY_USED", 409) from None
    return None


async def _dispatch(owner: str, operation: str, row: Any, delete: DeletePort) -> dict[str, Any]:
    try:
        result = await delete(row["target_user_id"], _admission_check(row))
    except Exception as exc:
        logger.warning("phone_linked_deletion.dispatch_uncertain error=%s", type(exc).__name__)
        result = None
    returned = isinstance(result, dict)
    if returned and result.get("success") is True:
        state, code = "admitted", ""
    else:
        # Only the committed tombstone decides. A returned failure has finished
        # its transaction (definite); a raised one may still be committing.
        async with transaction() as conn:
            admitted = await conn.fetchval(_ADMITTED, row["target_hash"])
        code = str(result.get("error_code") or "ACCOUNT_DELETION_FAILED") if returned else ""
        state = "admitted" if admitted else "refused" if returned else "action_required"
        code = "" if admitted else code
    async with transaction() as conn:
        await conn.execute(_FINISH, operation, state, code or None)
        finished = await _row(conn, owner, operation)
    if finished["state"] == "admitted":
        from hushh_mcp.services.account_cleanup_runtime import wake_cleanup_worker

        wake_cleanup_worker()  # Erase the holder now, not at the next cleanup tick.
        logger.info(
            "phone_linked_deletion.admitted operation=%s requester=%s target=%s proof=%s",
            operation,
            finished["requester_hash"][-12:],
            finished["target_hash"][-12:],
            row["transport"],
        )
    return _receipt(finished)


def _admission_check(row: Any) -> Callable[[Any], None]:
    """Recheck the proven binding under the erasure's exclusive owner locks."""
    from hushh_mcp.services.account_service import AccountDeletionAdmissionRefused

    target = row["target_user_id"]
    expected = (row["phone_digest"], row["binding_revision"], row["generation"])

    def check(conn: Any) -> None:
        identity = (
            conn.execute(
                text(
                    """SELECT phone_number,phone_verified,phone_binding_revision
                    FROM actor_identity_cache WHERE user_id=:owner FOR SHARE"""
                ),
                {"owner": target},
            )
            .mappings()
            .first()
        )
        generation = conn.execute(
            text(
                "SELECT generation FROM account_generations WHERE owner_id=:owner AND retired_at IS NULL"
            ),
            {"owner": target},
        ).scalar()
        if (
            not identity
            or identity["phone_verified"] is not True
            or not identity["phone_number"]
            or (
                account_deletion_phone_digest(identity["phone_number"]),
                identity["phone_binding_revision"],
                generation or 0,
            )
            != expected
        ):
            raise AccountDeletionAdmissionRefused("PHONE_LINKED_DELETION_STALE")

    return check


async def _verify_proof(
    owner: str,
    operation: str,
    phone: str,
    transport: str,
    phone_id_token: str | None,
    test_code: str | None,
) -> _Proof:
    if bool(phone_id_token) == bool(test_code) or (transport == "configured_test") != bool(
        test_code
    ):
        raise refuse("PHONE_LINKED_DELETION_PROOF_REQUIRED", 403)
    if test_code:
        if not fixture_transport(owner, phone):
            raise refuse("PHONE_LINKED_DELETION_REAL_SMS_REQUIRED", 403)
        from hushh_mcp.services.phone_test_transport import (
            _create_uat_phone_test_verification_id,
            validate_phone_test_confirmation,
        )

        try:
            validate_phone_test_confirmation(
                owner, phone, _create_uat_phone_test_verification_id(phone), test_code
            )
        except HTTPException:
            async with transaction() as conn:
                await conn.execute(_FAILED_PROOF, operation, account_deletion_user_hash(owner))
            raise
        # Fixture proof is scoped to this requester's operation only.
        event = f"phone-linked-fixture:{owner}:{operation}"
        return _Proof("configured_test", hashlib.sha256(event.encode()).hexdigest(), None)
    event, uid = await _sms_event(phone_id_token or "", phone)
    return _Proof("sms", hashlib.sha256(event.encode()).hexdigest(), uid)


async def _sms_event(token: str, phone: str) -> tuple[str, str]:
    """Transfer-grade proof: real provider, fresh <=300 s, single authentication event."""
    from api.utils.firebase_admin import get_firebase_auth_app
    from api.utils.firebase_auth import refuse_foreign_review_mint
    from api.utils.phone_claim_proof import verify_phone_claim_id_token
    from hushh_mcp.services.phone_transfer_authority import assert_real_sms_provider

    metadata: dict[str, Any] = {}
    actual, uid = await verify_phone_claim_id_token(
        token,
        app_factory=get_firebase_auth_app,
        run_in_threadpool=run_in_threadpool,
        refuse_foreign_review_mint=refuse_foreign_review_mint,
        transfer=True,
        proof_metadata=metadata,
    )
    if actual != phone or not uid:
        raise refuse("PHONE_LINKED_DELETION_FRESH_SMS_REQUIRED", 403)
    await run_in_threadpool(assert_real_sms_provider, get_firebase_auth_app(), phone)
    if metadata["valid_until"] <= time.time():
        raise refuse("PHONE_LINKED_DELETION_FRESH_SMS_REQUIRED", 403)
    return f"phone-linked-sms:{metadata['event']}", uid


async def _recovery_required(uid: str, phone: str) -> bool:
    """A phone-only identity with account state can never be claimed by another owner."""
    from firebase_admin import auth

    from api.routes.account import _is_safe_phone_only_firebase_user
    from api.utils.firebase_admin import get_firebase_auth_app
    from db.db_client import get_db_connection
    from hushh_mcp.services.account_deletion_lifecycle_service import (
        AccountDeletionLifecycleService,
    )

    try:
        record = await run_in_threadpool(auth.get_user, uid, app=get_firebase_auth_app())
    except Exception as exc:
        if exc.__class__.__name__ == "UserNotFoundError":
            return False
        raise refuse("PHONE_LINKED_DELETION_VERIFICATION_UNAVAILABLE", 503) from None
    if not _is_safe_phone_only_firebase_user(record, phone):
        return False

    def has_account_state() -> bool:
        with get_db_connection() as conn:
            return AccountDeletionLifecycleService._has_guarded_account_state_in_transaction(
                conn, user_id=uid
            )

    return await run_in_threadpool(has_account_state)


async def _protected(conn: Any, target: str) -> bool:
    """Shared release and reviewer fixtures are never deletable by phone proof."""
    from api.routes import health
    from hushh_mcp.services.dev_reviewer_phone_transport import (
        configured_dev_reviewer_phone_transport,
    )

    reviewer = configured_dev_reviewer_phone_transport()
    protected = {
        health._resolve_reviewer_uid(),
        health._resolve_reviewer_counterpart_uid(),
        reviewer.owner if reviewer else "",
    } - {""}
    if not protected:
        return False
    identity = await conn.fetchval(
        "SELECT identity_uid FROM account_generations WHERE owner_id=$1 AND retired_at IS NULL",
        target,
    )
    return target in protected or identity in protected


async def status(owner: str, operation: str) -> dict[str, Any]:
    """Read progress and settle only from the durable tombstone; never re-dispatch."""
    async with transaction() as conn:
        row = await _row(conn, owner, operation)
        if row["state"] in {"pending", "action_required"}:
            if await conn.fetchval(_ADMITTED, row["target_hash"]):
                await conn.execute(_FINISH, operation, "admitted", None)
            elif row["state"] == "pending" and row["stale"]:
                await conn.execute(_FINISH, operation, "action_required", row["result_code"])
            row = await _row(conn, owner, operation)
        return _receipt(row)


async def cancel(owner: str, operation: str) -> dict[str, Any]:
    async with transaction() as conn:
        await conn.execute(_CANCEL, operation, account_deletion_user_hash(owner))
        return _receipt(await _row(conn, owner, operation))
