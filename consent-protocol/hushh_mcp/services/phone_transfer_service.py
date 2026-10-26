"""Owner-bound phone-link transfer using the canonical identity writer.

Proofs live only in request memory. SQL commits the binding, admission fence,
capability revocation and consumed intent together. Firebase unlink uses the
existing generation-bound remote-mutation journal; it never deletes an identity.
"""

from __future__ import annotations

import asyncio
import hmac
import logging
import time
from dataclasses import dataclass
from typing import Any
from uuid import uuid4

from starlette.concurrency import run_in_threadpool

from db.connection import get_pool
from db.db_client import get_db_connection
from hushh_mcp.services import account_firebase_mutations as mutations
from hushh_mcp.services import phone_transfer_authority as authority
from hushh_mcp.services.account_deletion_lifecycle_service import account_deletion_phone_digest

# Compatibility facade: callers retain the original transfer service contract.
PhoneTransferInProgressError = authority.PhoneTransferInProgressError
assert_erasure_ready = authority.assert_erasure_ready
check_provider = authority.check_provider
proof_digest = authority.proof_digest
refuse = authority.refuse
require_fresh_sms_claims = authority.require_fresh_sms_claims

logger = logging.getLogger(__name__)


async def _bound_prepared_intents(conn: Any, user_id: str) -> None:
    await conn.execute(
        "DELETE FROM account_phone_transfers WHERE (state='prepared' AND expires_at < NOW()) OR (state='completed' AND notice_status='settled' AND completed_at < NOW()-INTERVAL '7 days')"
    )
    # Bound outstanding intents per claimant; proof verification precedes this write.
    count = await conn.fetchval(
        "SELECT count(*) FROM account_phone_transfers WHERE user_id=$1 AND state='prepared' AND expires_at>NOW()",
        user_id,
    )
    if count >= 5:
        raise refuse("PHONE_TRANSFER_STALE", 429)


async def prepare(
    user_id: str, phone: str, token: str, proof_uid: str, app: Any, *, proof_valid_until: float
) -> dict[str, Any]:
    from api.middlewares.auth_reliability_trace import request_feature_enabled, request_trace_span

    if not request_feature_enabled("AUTH_PHONE_RECOVERY_ENABLED"):
        raise refuse("PHONE_TRANSFER_PROVIDER_UNAVAILABLE", 503)
    pool = await get_pool()
    async with pool.acquire() as conn:
        old = await conn.fetchrow(
            "SELECT user_id,phone_binding_revision FROM actor_identity_cache WHERE phone_number=$1 AND phone_verified=TRUE",
            phone,
        )
    if not old or old["user_id"] == user_id:
        raise refuse("PHONE_TRANSFER_STALE")
    with request_trace_span("provider"):
        independent_signin = await run_in_threadpool(check_provider, app, phone, proof_uid)
    if proof_valid_until <= time.time():
        raise refuse("PHONE_TRANSFER_STALE", 401)
    operation_id = str(uuid4())
    async with pool.acquire() as conn:
        async with conn.transaction():
            await _bound_prepared_intents(conn, user_id)
            from hushh_mcp.services.account_deletion_lifecycle_service import (
                AccountDeletionLifecycleService,
                account_deletion_user_hash,
            )
            from hushh_mcp.services.actor_identity_service import ActorIdentityService

            proof_identity = await conn.fetchrow(
                "SELECT owner_id,generation FROM account_generations WHERE identity_hash=$1 ORDER BY generation DESC LIMIT 1",
                account_deletion_user_hash(proof_uid),
            )
            proof_owner = proof_identity["owner_id"] if proof_identity else proof_uid
            generation = proof_identity["generation"] if proof_identity else 0
            owners = {user_id, old["user_id"], proof_owner}
            if (
                await AccountDeletionLifecycleService.active_projection_user_ids(
                    conn, user_ids=owners
                )
                != owners
            ):
                raise refuse("PHONE_TRANSFER_STALE")
            await ActorIdentityService._ensure_actor_spine(conn, user_id)
            revision = (
                await conn.fetchval(
                    "SELECT phone_binding_revision FROM actor_identity_cache WHERE user_id=$1",
                    user_id,
                )
                or 0
            )
            if not await conn.fetchval(
                "SELECT clock_timestamp() < to_timestamp($1)", proof_valid_until
            ):
                raise refuse("PHONE_TRANSFER_STALE", 401)
            row = await conn.fetchrow(
                """INSERT INTO account_phone_transfers
                (operation_id,user_id,previous_user_id,previous_revision,phone_digest,proof_digest,expires_at,requester_revision,proof_identity_uid,proof_generation,authority_project,proof_owner_id,unlink_required)
                VALUES($1::uuid,$2,$3,$4,$5,$6,LEAST(NOW()+INTERVAL '5 minutes',to_timestamp($13)),$7,$8,$9,$10,$11,$12)
                ON CONFLICT(proof_digest) DO NOTHING RETURNING expires_at""",
                operation_id,
                user_id,
                old["user_id"],
                old["phone_binding_revision"],
                account_deletion_phone_digest(phone),
                proof_digest(token),
                revision,
                proof_uid,
                generation,
                app.project_id,
                proof_owner,
                proof_owner != user_id and independent_signin,
                proof_valid_until,
            )
            if not row:
                raise refuse("PHONE_TRANSFER_STALE")
    return {"transfer_id": operation_id, "expires_at": row["expires_at"].isoformat()}


@dataclass
class ConfirmedTransfer:
    operation_id: str
    proof_digest: str
    previous_user_id: str
    proof_uid: str
    generation: int
    project: str
    proof_owner_id: str
    unlink_required: bool = True
    permit: mutations.FirebaseMutationPermit | None = None


async def lock_transfer(conn: Any, user_id: str, transfer: ConfirmedTransfer) -> None:
    await conn.execute("SET LOCAL lock_timeout='3000ms'")
    await conn.execute("SET LOCAL statement_timeout='5000ms'")
    from hushh_mcp.services.account_deletion_lifecycle_service import (
        AccountDeletionLifecycleService,
    )

    owners = {user_id, transfer.previous_user_id, transfer.proof_owner_id}
    if (
        await AccountDeletionLifecycleService.active_projection_user_ids(conn, user_ids=owners)
        != owners
    ):
        raise refuse("PHONE_TRANSFER_STALE")
    # Identity-generation dispatch fence precedes phone and row locks.
    transfer.permit = await mutations.reserve_phone_unlink(
        conn,
        owner_id=transfer.previous_user_id,
        identity_uid=transfer.proof_uid,
        generation=transfer.generation,
        authority_project=transfer.project,
        proof_owner_id=transfer.proof_owner_id,
        reserve=transfer.unlink_required,
    )


async def consume(conn: Any, user_id: str, phone: str, transfer: ConfirmedTransfer) -> None:
    # Same per-phone serialization as every canonical verified-phone writer.
    await conn.execute(
        "SELECT pg_advisory_xact_lock(hashtextextended($1,0))",
        f"actor_identity_phone_claim:{phone}",
    )
    row = await conn.fetchrow(
        "SELECT * FROM account_phone_transfers WHERE operation_id=$1::uuid FOR UPDATE",
        transfer.operation_id,
    )
    if (
        not row
        or row["user_id"] != user_id
        or row["state"] != "prepared"
        or not hmac.compare_digest(row["proof_digest"], transfer.proof_digest)
        or not hmac.compare_digest(row["phone_digest"], account_deletion_phone_digest(phone))
    ):
        raise refuse("PHONE_TRANSFER_STALE")
    if not await conn.fetchval(
        "SELECT expires_at>clock_timestamp() FROM account_phone_transfers WHERE operation_id=$1::uuid",
        transfer.operation_id,
    ):
        raise refuse("PHONE_TRANSFER_STALE")
    bindings = await conn.fetch(
        "SELECT user_id,phone_number,phone_verified,phone_binding_revision FROM actor_identity_cache WHERE user_id=$1 OR phone_number=$2 ORDER BY user_id FOR UPDATE",
        user_id,
        phone,
    )
    if not any(
        b["user_id"] == row["previous_user_id"]
        and b["phone_number"] == phone
        and b["phone_verified"] is True
        and b["phone_binding_revision"] == row["previous_revision"]
        for b in bindings
    ):
        raise refuse("PHONE_TRANSFER_STALE")
    current_revision = next(
        (b["phone_binding_revision"] for b in bindings if b["user_id"] == user_id), 0
    )
    if current_revision != row["requester_revision"]:
        raise refuse("PHONE_TRANSFER_STALE")
    from hushh_mcp.services.account_deletion_lifecycle_service import account_deletion_user_hash

    if transfer.proof_owner_id != user_id:
        await conn.execute(
            "INSERT INTO account_phone_auth_fences(identity_hash,phone_digest) VALUES($1,$2) ON CONFLICT DO NOTHING",
            account_deletion_user_hash(transfer.proof_uid),
            row["phone_digest"],
        )
    # Existing owner-token lineage lock also serializes grants. Never erase information.
    revoked_owners = {row["previous_user_id"]}
    if transfer.proof_owner_id != user_id:
        # Retire pre-admitted capabilities even if their profile write has not
        # landed yet. The event store intentionally has no profile FK.
        revoked_owners.add(transfer.proof_owner_id)
    for owner in sorted(revoked_owners):
        await conn.execute(
            "SELECT pg_advisory_xact_lock(hashtextextended($1,0))", f"vault-owner-renewal:{owner}"
        )
    for owner in sorted(revoked_owners):
        await conn.execute(
            """INSERT INTO internal_access_events(token_id,user_id,agent_id,scope,action,issued_at,metadata)
            VALUES($1,$2,'self','vault.owner','REVOKED',
              (EXTRACT(EPOCH FROM clock_timestamp())*1000)::bigint,'{"reason":"phone_transferred"}'::jsonb)""",
            f"phone-transfer:{transfer.operation_id}:{owner}",
            owner,
        )
    permit = transfer.permit
    await conn.execute(
        """UPDATE account_phone_transfers SET state=$4,effect_state=$5,committed_at=clock_timestamp(),
        completed_at=CASE WHEN $4='completed' THEN clock_timestamp() END,mutation_id=$2::uuid,mutation_nonce=$3::uuid WHERE operation_id=$1::uuid""",
        transfer.operation_id,
        permit.operation_id if permit else None,
        permit.settlement_nonce if permit else None,
        "committed" if transfer.unlink_required else "completed",
        "reserved" if transfer.unlink_required else "completed",
    )


def assert_phone_admission(owner_id: str, claims: Any) -> None:
    from hushh_mcp.services.phone_transfer_authority import assert_phone_admission as admit

    admit(owner_id, claims, get_db_connection=get_db_connection)


async def confirm(
    user_id: str, phone: str, token: str, proof_uid: str, operation_id: str, app: Any
) -> dict[str, Any]:
    from api.middlewares.auth_reliability_trace import request_feature_enabled, request_trace_span

    if not request_feature_enabled("AUTH_PHONE_RECOVERY_ENABLED"):
        raise refuse("PHONE_TRANSFER_PROVIDER_UNAVAILABLE", 503)
    pool = await get_pool()
    async with pool.acquire() as conn:
        row = await conn.fetchrow(
            "SELECT * FROM account_phone_transfers WHERE operation_id=$1::uuid AND user_id=$2",
            operation_id,
            user_id,
        )
    if not row or not hmac.compare_digest(row["proof_digest"], proof_digest(token)):
        raise refuse("PHONE_TRANSFER_STALE")
    if row["state"] != "prepared":
        raise refuse("PHONE_TRANSFER_STALE")
    if row["proof_identity_uid"] != proof_uid or row["authority_project"] != app.project_id:
        raise refuse("PHONE_TRANSFER_STALE")
    with request_trace_span("provider"):
        independent_signin = await run_in_threadpool(check_provider, app, phone, proof_uid)
    if row["unlink_required"] and not independent_signin:
        raise refuse("PHONE_TRANSFER_RECOVERY_REQUIRED", 403)
    from hushh_mcp.services.actor_identity_service import ActorIdentityService

    transfer = ConfirmedTransfer(
        operation_id,
        proof_digest(token),
        row["previous_user_id"],
        proof_uid,
        row["proof_generation"],
        app.project_id,
        row["proof_owner_id"],
        row["unlink_required"],
    )
    with request_trace_span("persist"):
        identity = await ActorIdentityService().claim_verified_phone(
            user_id=user_id, phone_number=phone, transfer=transfer
        )
    if not identity:
        raise refuse("PHONE_TRANSFER_PROVIDER_UNAVAILABLE", 503)
    with request_trace_span("provider"):
        state = await dispatch(operation_id, app)
    return {"success": True, "identity": identity, "phone_verified": True, "transfer_status": state}


async def dispatch(operation_id: str, app: Any) -> str:
    """Claim a reserved effect once. Uncertain dispatch is reconciled by reads."""
    from firebase_admin import auth

    from hushh_mcp.services.account_deletion_lifecycle_service import account_deletion_user_hash

    pool = await get_pool()
    async with pool.acquire() as conn:
        row = await conn.fetchrow(
            """UPDATE account_phone_transfers SET effect_state='dispatched'
            WHERE operation_id=$1::uuid AND state='committed' AND effect_state='reserved'
              AND authority_project=$2 RETURNING *""",
            operation_id,
            app.project_id,
        )
    if not row:
        async with pool.acquire() as conn:
            done = await conn.fetchval(
                "SELECT state='completed' FROM account_phone_transfers WHERE operation_id=$1::uuid",
                operation_id,
            )
        return "completed" if done is True else "in_progress"
    permit = mutations.FirebaseMutationPermit(
        str(row["mutation_id"]),
        account_deletion_user_hash(row["previous_user_id"]),
        account_deletion_user_hash(row["proof_identity_uid"]),
        str(row["mutation_nonce"]),
        row["proof_identity_uid"],
    )
    try:
        user = await run_in_threadpool(auth.get_user, permit.firebase_uid, app=app)
        phone = user.phone_number
        if phone is None:
            await run_in_threadpool(mutations.settle, permit, "succeeded")
        elif not hmac.compare_digest(account_deletion_phone_digest(phone), row["phone_digest"]):
            raise refuse("PHONE_TRANSFER_STALE")
        else:
            await mutations.run_prepared(
                permit, lambda uid: mutations.unlink_phone(app, uid, phone)
            )
        async with pool.acquire() as conn:
            await conn.execute(
                "UPDATE account_phone_transfers SET state='completed',effect_state='completed',completed_at=clock_timestamp() WHERE operation_id=$1::uuid AND state='committed'",
                operation_id,
            )
        return "completed"
    except Exception:
        async with pool.acquire() as conn:
            await conn.execute(
                "UPDATE account_phone_transfers SET effect_state='uncertain' WHERE operation_id=$1::uuid AND state='committed'",
                operation_id,
            )
        logger.warning("phone.transfer.unlink_pending")
        return "in_progress"


async def status(user_id: str, operation_id: str, app: Any) -> dict[str, Any]:
    """Reconcile local settlement only from an authoritative succeeded receipt.

    A provider read cannot prove an uncertain earlier POST has finished. Never
    release generation fences merely because a phone is momentarily absent.
    """
    from hushh_mcp.services.account_deletion_lifecycle_service import account_deletion_user_hash
    from hushh_mcp.services.actor_identity_service import ActorIdentityService

    pool = await get_pool()
    async with pool.acquire() as conn:
        async with conn.transaction():
            row = await conn.fetchrow(
                "SELECT * FROM account_phone_transfers WHERE operation_id=$1::uuid AND user_id=$2 FOR UPDATE",
                operation_id,
                user_id,
            )
            if not row:
                raise refuse("PHONE_TRANSFER_STALE", 404)
            if row["state"] == "prepared":
                return {
                    "success": False,
                    "transfer_status": "not_started",
                    "identity": None,
                    "phone_verified": False,
                }
            if row["authority_project"] != app.project_id:
                raise refuse("PHONE_TRANSFER_PROVIDER_UNAVAILABLE", 503)
            state = "completed" if row["state"] == "completed" else "in_progress"
            if state != "completed":
                receipt = await conn.fetchrow(
                    "SELECT state,owner_hash,identity_hash,settlement_nonce,authority_project FROM account_firebase_mutations WHERE operation_id=$1::uuid FOR UPDATE",
                    row["mutation_id"],
                )
                if (
                    receipt
                    and receipt["state"] == "succeeded"
                    and receipt["owner_hash"] == account_deletion_user_hash(row["previous_user_id"])
                    and receipt["identity_hash"]
                    == account_deletion_user_hash(row["proof_identity_uid"])
                    and str(receipt["settlement_nonce"]) == str(row["mutation_nonce"])
                    and receipt["authority_project"] == app.project_id
                ):
                    await conn.execute(
                        "UPDATE account_phone_transfers SET state='completed',effect_state='completed',completed_at=clock_timestamp() WHERE operation_id=$1::uuid",
                        operation_id,
                    )
                    state = "completed"
                elif (
                    row["effect_state"] in {"uncertain", "dispatched"}
                    and row["committed_at"]
                    and time.time() - row["committed_at"].timestamp() >= 30
                ):
                    state = "action_required"
    if state == "action_required":
        logger.error("phone.transfer.reconciliation_pending")
    identity = (await ActorIdentityService().get_many([user_id])).get(user_id)
    return {
        "success": True,
        "identity": identity,
        "phone_verified": bool(identity and identity.get("phone_verified")),
        "transfer_status": state,
    }


async def send_notices(operation_id: str) -> None:
    """Claim once before sending on the existing verified channels.

    Delivery uncertainty remains observable; it never authorizes a duplicate mail.
    """
    from hushh_mcp.services.support_email_service import send_verified_account_notice

    pool = await get_pool()
    async with pool.acquire() as conn:
        row = await conn.fetchrow(
            """UPDATE account_phone_transfers SET notice_status='dispatched',notice_dispatched_at=clock_timestamp()
            WHERE operation_id=$1::uuid AND state IN ('committed','completed') AND notice_status='pending'
            RETURNING user_id,previous_user_id""",
            operation_id,
        )
    if not row:
        return
    results = [
        await send_verified_account_notice(owner, "phone_link_changed")
        for owner in sorted({row["user_id"], row["previous_user_id"]})
    ]
    async with pool.acquire() as conn:
        await conn.execute(
            "UPDATE account_phone_transfers SET notice_status=$2 WHERE operation_id=$1::uuid AND notice_status='dispatched'",
            operation_id,
            "settled" if all(results) else "uncertain",
        )
    if not all(results):
        logger.error("phone.transfer.notification_pending")


async def recovery_loop(interval: float = 30) -> None:
    """Resume committed reservations; never replay a dispatched provider call."""
    from api.utils.firebase_admin import get_firebase_auth_app

    while True:
        try:
            app = get_firebase_auth_app()
            pool = await get_pool()
            async with pool.acquire() as conn:
                await conn.execute("""DELETE FROM account_phone_transfers WHERE operation_id IN
                    (SELECT operation_id FROM account_phone_transfers WHERE
                     (state='prepared' AND expires_at < NOW()) OR
                     (state='completed' AND notice_status='settled' AND completed_at < NOW()-INTERVAL '7 days')
                     LIMIT 100)""")
                interrupted_notices = await conn.fetchval(
                    """WITH retired AS (UPDATE account_phone_transfers SET notice_status='uncertain'
                    WHERE notice_status='dispatched' AND notice_dispatched_at < NOW()-INTERVAL '2 minutes'
                    AND authority_project=$1 RETURNING 1) SELECT count(*) FROM retired""",
                    app.project_id,
                )
                if interrupted_notices:
                    logger.error("phone.transfer.notification_pending")
                rows = await conn.fetch(
                    "UPDATE account_phone_transfers SET last_reconciled_at=clock_timestamp() WHERE operation_id IN (SELECT operation_id FROM account_phone_transfers WHERE (state='committed' OR (state='completed' AND notice_status='pending')) AND authority_project=$1 ORDER BY last_reconciled_at NULLS FIRST,committed_at LIMIT 10 FOR UPDATE SKIP LOCKED) RETURNING operation_id,user_id,effect_state,state",
                    app.project_id,
                )
            for row in rows:
                if row["state"] == "completed":
                    await send_notices(str(row["operation_id"]))
                elif row["effect_state"] == "reserved":
                    await dispatch(str(row["operation_id"]), app)
                else:
                    await status(row["user_id"], str(row["operation_id"]), app)
                await send_notices(str(row["operation_id"]))
        except asyncio.CancelledError:
            raise
        except Exception:
            logger.warning("phone.transfer.recovery_unavailable")
        await asyncio.sleep(interval)


async def assert_claim_available(user_id: str, phone: str) -> None:
    from hushh_mcp.services.actor_identity_service import ActorIdentityService

    if not await ActorIdentityService().can_claim_test_phone(user_id=user_id, phone_number=phone):
        raise refuse("PHONE_TRANSFER_CONFIRMATION_REQUIRED")
