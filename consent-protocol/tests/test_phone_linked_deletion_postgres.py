"""Phone-proven deletion of a number's holder, against disposable PostgreSQL only."""

from __future__ import annotations

import asyncio
import time
from types import SimpleNamespace
from unittest.mock import AsyncMock
from uuid import uuid4

import asyncpg
import pytest
from fastapi import HTTPException
from sqlalchemy import create_engine

import db.db_client as db_client
from hushh_mcp.services import actor_identity_service as identity
from hushh_mcp.services import phone_linked_deletion as linked
from hushh_mcp.services import phone_recovery_state
from hushh_mcp.services.account_deletion_lifecycle_service import (
    account_deletion_phone_digest,
    account_deletion_user_hash,
)
from hushh_mcp.services.account_personal_agent_erasure import (
    PERSONAL_AGENT_DEPROVISION_REQUIRED_CODE,
)
from hushh_mcp.services.account_service import AccountService
from tests.helpers.phone_conflict_browser import OWNERS, PHONE, _schema, _seed
from tests.helpers.phone_transfer_postgres import database_url as database_url

pytestmark = [pytest.mark.feature_auth_reliability, pytest.mark.trace_loop]

CODE = "123456"
SYNTHETIC_SMS_TOKEN = "own"
UNBOUND = "+16505550199"
MOVED = "+16505550109"
HOLDER, REQUESTER = OWNERS["previous"], OWNERS["receiving-a"]


@pytest.fixture
async def db(database_url, monkeypatch):
    pool = await asyncpg.create_pool(database_url, min_size=1, max_size=3, command_timeout=5)
    engine = create_engine(database_url, pool_size=2, max_overflow=1)
    try:
        await _schema(pool)
        await _seed(pool, files=False)
        for module in (phone_recovery_state, identity):
            monkeypatch.setattr(module, "get_pool", AsyncMock(return_value=pool))
        monkeypatch.setattr(db_client, "_engine", engine)
        monkeypatch.setattr(db_client, "_db_client", db_client.DatabaseClient(engine))
        service = identity.ActorIdentityService
        monkeypatch.setattr(service, "_ensure_actor_spine", AsyncMock())
        monkeypatch.setattr(service, "schedule_provision_personal_agent", lambda *_: None)
        monkeypatch.setattr(service, "_schedule_phone_resume", lambda *_: None)
        monkeypatch.setattr(service, "_sync_referral_qualification_best_effort", AsyncMock())
        for name, value in {
            "ENVIRONMENT": "uat",
            "AUTH_PHONE_RECOVERY_ENABLED": "true",
            "HUSHH_UAT_PHONE_TEST_NUMBERS": f"{PHONE},{UNBOUND}",
            "HUSHH_UAT_PHONE_TEST_CODE": CODE,
        }.items():
            monkeypatch.setenv(name, value)
        for name in (
            "APP_RUNTIME_PROFILE",
            "HUSHH_DEPLOY_ENV",
            "HUSHH_PHONE_LINKED_DELETION_ENABLED",
            "REVIEWER_UID",
            "REVIEWER_COUNTERPART_UID",
            "UAT_SMOKE_USER_ID",
            "KAI_TEST_USER_ID",
        ):
            monkeypatch.delenv(name, raising=False)
        yield SimpleNamespace(pool=pool, engine=engine)
    finally:
        engine.dispose()
        await pool.close()


async def _value(db, sql, *args):
    async with db.pool.acquire() as conn:
        return await conn.fetchval(sql, *args)


async def _holder(db):
    return await _value(
        db,
        "SELECT user_id FROM actor_identity_cache WHERE phone_number=$1 AND phone_verified",
        PHONE,
    )


@pytest.mark.parametrize("transport", ["sms", "configured_test"])
async def test_explicit_disable_blocks_new_and_historical_operations(db, monkeypatch, transport):
    monkeypatch.setenv("HUSHH_PHONE_LINKED_DELETION_ENABLED", "false")
    operation = str(uuid4())
    async with db.pool.acquire() as conn:
        await conn.execute(
            "INSERT INTO account_phone_linked_deletions(operation_id,requester_user_id,requester_hash,phone_digest,transport,expires_at) VALUES($1::uuid,$2,$3,$4,$5,clock_timestamp()+INTERVAL '5 minutes')",
            operation,
            REQUESTER,
            account_deletion_user_hash(REQUESTER),
            account_deletion_phone_digest(PHONE),
            transport,
        )
        before = await conn.fetchrow("SELECT * FROM actor_identity_cache WHERE user_id=$1", HOLDER)
    delete = AsyncMock()
    for attempt in (
        linked.prepare(REQUESTER, PHONE),
        linked.confirm(
            REQUESTER,
            operation,
            PHONE,
            phone_id_token="synthetic-sms-proof" if transport == "sms" else None,
            test_code=CODE if transport == "configured_test" else None,
            delete=delete,
        ),
    ):
        with pytest.raises(HTTPException) as error:
            await attempt
        assert error.value.detail["code"] == "PHONE_LINKED_DELETION_UNAVAILABLE"
    delete.assert_not_awaited()
    async with db.pool.acquire() as conn:
        assert (
            await conn.fetchrow("SELECT * FROM actor_identity_cache WHERE user_id=$1", HOLDER)
            == before
        )
        assert await conn.fetchval("SELECT count(*) FROM account_deletion_tombstones") == 0
    # Existing prepared receipts remain readable/cancellable, never confirmable.
    assert (await linked.status(REQUESTER, operation))["state"] == "prepared"
    assert (await linked.cancel(REQUESTER, operation))["state"] == "cancelled"


async def test_claim_never_takes_a_number_from_a_live_or_provisional_holder(db):
    service = identity.ActorIdentityService()
    async with db.pool.acquire() as conn:
        await conn.execute(
            """INSERT INTO account_deletion_tombstones(user_id_hash,cleanup_intent_kind,
            expected_phone_digest,firebase_uid) VALUES($1,'phone_orphan',$2,$3)""",
            account_deletion_user_hash(HOLDER),
            account_deletion_phone_digest(PHONE),
            HOLDER,
        )
    # A provisional phone-orphan intent can be cancelled, so it never releases.
    assert not await service.can_claim_test_phone(user_id=REQUESTER, phone_number=PHONE)
    with pytest.raises(identity.ActorIdentityPhoneClaimConflictError):
        await service.claim_verified_phone(user_id=REQUESTER, phone_number=PHONE)
    async with db.pool.acquire() as conn:
        await conn.execute("DELETE FROM account_deletion_tombstones")
    assert (await AccountService().delete_account(HOLDER, target="both"))["success"] is True
    # Background provider hydration carries no OTP and stays strict.
    await service.upsert_identity(
        user_id=OWNERS["wrong"], phone_number=PHONE, phone_verified=True, source="firebase"
    )
    assert await _holder(db) == HOLDER

    # Only proper full-account deletion releases a number for a new explicit claim.
    claimed = await service.claim_verified_phone(user_id=REQUESTER, phone_number=PHONE)
    assert claimed["phone_verified"] is True
    assert await _holder(db) == REQUESTER


@pytest.mark.parametrize("historical_state", ["pending", "action_required"])
async def test_historical_receipts_are_requester_scoped_and_settle_only_after_deletion(
    db, historical_state
):
    operation = str(uuid4())
    async with db.pool.acquire() as conn:
        await conn.execute(
            """INSERT INTO account_phone_linked_deletions
            (operation_id,requester_user_id,requester_hash,target_user_id,target_hash,
            phone_digest,binding_revision,generation,transport,proof_event_digest,
            state,expires_at,dispatched_at)
            VALUES($1::uuid,$2,$3,$4,$5,$6,0,0,'sms',$7,$8,
            clock_timestamp()+INTERVAL '5 minutes',clock_timestamp())""",
            operation,
            REQUESTER,
            account_deletion_user_hash(REQUESTER),
            HOLDER,
            account_deletion_user_hash(HOLDER),
            account_deletion_phone_digest(PHONE),
            "a" * 64,
            historical_state,
        )
    with pytest.raises(HTTPException) as error:
        await linked.status(OWNERS["wrong"], operation)
    assert error.value.status_code == 404
    assert (await linked.status(REQUESTER, operation))["state"] == historical_state
    assert (await AccountService().delete_account(HOLDER, target="both"))["success"] is True
    assert (await linked.status(REQUESTER, operation))["state"] == "admitted"
    assert (await linked.status(REQUESTER, operation))["state"] == "admitted"


def _deleting(calls, before=None):
    """The route's port: the existing full-account admission, recheck included."""

    async def delete(owner, admission_check):
        calls.append(owner)
        if before:
            await before(owner)
        return await AccountService().delete_account(
            owner, target="both", admission_check=admission_check
        )

    return delete


@pytest.fixture
def sms(db, monkeypatch):
    """Real-number transport; each token maps to one recorded Firebase phone proof."""
    import api.utils.firebase_admin as firebase_admin
    import api.utils.phone_claim_proof as claim_proof
    from hushh_mcp.services import phone_transfer_authority

    monkeypatch.delenv("HUSHH_UAT_PHONE_TEST_NUMBERS")
    proofs = {"own": (PHONE, "phone-session", int(time.time()))}

    async def verify(token, *, proof_metadata, **_):
        phone, uid, stamp = proofs[token]
        proof_metadata.update(event=f"{uid}:{phone}:{stamp}", valid_until=stamp + 300)
        return phone, uid

    monkeypatch.setattr(claim_proof, "verify_phone_claim_id_token", verify)
    monkeypatch.setattr(phone_transfer_authority, "assert_real_sms_provider", lambda *_: None)
    monkeypatch.setattr(firebase_admin, "get_firebase_auth_app", lambda: object())
    recovery = AsyncMock(return_value=False)
    monkeypatch.setattr(linked, "_recovery_required", recovery)
    return SimpleNamespace(proofs=proofs, recovery=recovery)


async def _sms_confirm(operation, token, delete):
    return await linked.confirm(
        REQUESTER, operation, PHONE, phone_id_token=token, test_code=None, delete=delete
    )


async def _confirm(operation, delete, phone=PHONE):
    return await linked.confirm(
        REQUESTER,
        operation,
        phone,
        phone_id_token=SYNTHETIC_SMS_TOKEN,
        test_code=None,
        delete=delete,
    )


async def test_one_sms_event_authorizes_one_dispatch_for_its_own_number(db, sms):
    now = int(time.time())
    sms.proofs.update(
        own=(PHONE, "phone-session", now),
        refreshed=(PHONE, "phone-session", now),
        other=(UNBOUND, "phone-session", now),
    )
    first, second = await linked.prepare(REQUESTER, PHONE), await linked.prepare(REQUESTER, PHONE)
    assert first["transport"] == second["transport"] == "sms"
    calls = []
    with pytest.raises(HTTPException) as foreign:
        await _sms_confirm(first["operation_id"], "other", _deleting(calls))
    assert foreign.value.detail["code"] == "PHONE_LINKED_DELETION_FRESH_SMS_REQUIRED"
    paused = AsyncMock(return_value={"success": False, "error_code": "ACCOUNT_DELETION_PAUSED"})
    assert (await _sms_confirm(first["operation_id"], "own", paused))["state"] == "refused"
    # A refreshed JWT is the same authentication event: it never authorizes again.
    with pytest.raises(HTTPException) as replay:
        await _sms_confirm(second["operation_id"], "refreshed", _deleting(calls))
    assert replay.value.detail["code"] == "PHONE_LINKED_DELETION_PROOF_ALREADY_USED"
    paused.assert_awaited_once()
    assert calls == [] and await _holder(db) == HOLDER


async def test_an_unclaimable_phone_identity_is_refused_before_any_deletion(db, sms):
    sms.proofs["own"] = (PHONE, "phone-only", int(time.time()))
    sms.recovery.return_value = True
    prepared = await linked.prepare(REQUESTER, PHONE)
    calls = []
    result = await _sms_confirm(prepared["operation_id"], "own", _deleting(calls))
    assert result["code"] == "PHONE_LINKED_DELETION_RECOVERY_REQUIRED" and calls == []
    sms.recovery.assert_awaited_once_with("phone-only", PHONE)


async def test_recheck_inside_admission_refuses_a_number_moved_before_commit(db, sms):
    prepared = await linked.prepare(REQUESTER, PHONE)
    calls = []

    async def move(owner):
        await _value(
            db, "UPDATE actor_identity_cache SET phone_number=$1 WHERE user_id=$2", MOVED, owner
        )

    result = await _confirm(prepared["operation_id"], _deleting(calls, before=move))
    assert result["state"] == "refused" and result["code"] == "PHONE_LINKED_DELETION_STALE"
    assert calls == [HOLDER]
    # The refusal ran under the admission locks and rolled back the tombstone.
    assert not await _value(db, "SELECT count(*) FROM account_deletion_tombstones")


async def test_uncertain_dispatch_settles_only_from_the_durable_tombstone(db, sms):
    prepared = await linked.prepare(REQUESTER, PHONE)
    lost = AsyncMock(side_effect=ConnectionError("lost admission response"))
    result = await _confirm(prepared["operation_id"], lost)
    assert result["state"] == "action_required"
    assert result["code"] == "PHONE_LINKED_DELETION_SUPPORT_REQUIRED"
    assert (await linked.status(REQUESTER, prepared["operation_id"]))["state"] == "action_required"
    # The lost request had in fact admitted the deletion.
    assert (await AccountService().delete_account(HOLDER, target="both"))["success"] is True
    assert (await linked.status(REQUESTER, prepared["operation_id"]))["state"] == "admitted"
    lost.assert_awaited_once()


async def test_receipts_are_scoped_to_their_requester(db, sms):
    prepared = await linked.prepare(REQUESTER, PHONE)
    await _confirm(prepared["operation_id"], _deleting([]))
    row = await _value(
        db,
        "SELECT row(requester_hash,target_hash) FROM account_phone_linked_deletions "
        "WHERE operation_id=$1::uuid",
        prepared["operation_id"],
    )
    assert tuple(row) == (account_deletion_user_hash(REQUESTER), account_deletion_user_hash(HOLDER))
    assert (await linked.status(REQUESTER, prepared["operation_id"]))["state"] == "admitted"
    for owner, operation in (
        (OWNERS["wrong"], prepared["operation_id"]),
        (REQUESTER, str(uuid4())),
    ):
        with pytest.raises(HTTPException) as hidden:
            await linked.status(owner, operation)
        assert hidden.value.status_code == 404
    with pytest.raises(HTTPException):
        await linked.cancel(OWNERS["wrong"], prepared["operation_id"])


async def test_confirm_never_rebinds_the_operation_to_another_number(db, sms):
    prepared = await linked.prepare(REQUESTER, PHONE)
    calls = []
    with pytest.raises(HTTPException) as stale:
        await _confirm(prepared["operation_id"], _deleting(calls), phone=UNBOUND)
    assert stale.value.status_code == 409
    assert stale.value.detail["code"] == "PHONE_LINKED_DELETION_STALE"
    assert calls == [] and await _holder(db) == HOLDER


async def test_requester_limit_is_a_window_not_a_permanent_lock(db):
    for _ in range(5):
        await linked.prepare(REQUESTER, PHONE)
    with pytest.raises(HTTPException) as limited:
        await linked.prepare(REQUESTER, PHONE)
    assert limited.value.status_code == 429
    # Unsettled receipts from an earlier window never block the requester again.
    await _value(
        db,
        """UPDATE account_phone_linked_deletions SET state='action_required',
        proof_event_digest=md5(operation_id::text)||md5(operation_id::text),
        dispatched_at=clock_timestamp()-INTERVAL '10 minutes',
        created_at=created_at-INTERVAL '10 minutes',expires_at=expires_at-INTERVAL '10 minutes'""",
    )
    assert (await linked.prepare(REQUESTER, PHONE))["state"] == "prepared"


@pytest.mark.parametrize(
    "code", [PERSONAL_AGENT_DEPROVISION_REQUIRED_CODE, "ACCOUNT_DELETION_CLEANUP_UNAVAILABLE"]
)
async def test_a_returned_erasure_refusal_is_definite(db, sms, code):
    prepared = await linked.prepare(REQUESTER, PHONE)
    refused = AsyncMock(
        return_value={"success": False, "account_deleted": False, "error_code": code}
    )
    result = await _confirm(prepared["operation_id"], refused)
    assert result == {"operation_id": prepared["operation_id"], "state": "refused", "code": code}
    assert await _holder(db) == HOLDER


async def _finish_cleanup(owner):
    from hushh_mcp.services import account_deletion_provider_journal as journal

    claims = await asyncio.to_thread(journal.claim_due, limit=1)
    assert len(claims) == 1 and claims[0].owner_id == owner
    assert claims[0].inventory == {}  # This disposable owner has no external grants.
    assert await asyncio.to_thread(journal.is_ready, claims[0])
    result = await AccountService().finalize_provider_cleanup(claims[0])
    assert result["success"] is True and result["account_deleted"] is True


async def test_completed_erasure_preserves_the_receipt_and_consumed_sms_event(db, sms):
    prepared = await linked.prepare(REQUESTER, PHONE)
    unconsumed = await linked.prepare(REQUESTER, PHONE)
    calls = []
    result = await _confirm(prepared["operation_id"], _deleting(calls))
    assert result["state"] == "admitted" and calls == [HOLDER]
    await _finish_cleanup(HOLDER)
    with pytest.raises(HTTPException) as cancelled_by_erasure:
        await linked.status(REQUESTER, unconsumed["operation_id"])
    assert cancelled_by_erasure.value.status_code == 404
    assert not await _value(db, "SELECT count(*) FROM actor_profiles WHERE user_id=$1", HOLDER)
    assert not await _value(db, "SELECT count(*) FROM vault_keys WHERE user_id=$1", HOLDER)
    assert await linked.status(REQUESTER, prepared["operation_id"]) == result
    assert await _confirm(prepared["operation_id"], _deleting(calls)) == result
    assert calls == [HOLDER]
    async with db.pool.acquire() as conn:
        receipt = await conn.fetchrow(
            "SELECT requester_user_id,target_user_id,proof_event_digest FROM account_phone_linked_deletions WHERE operation_id=$1::uuid",
            prepared["operation_id"],
        )
    assert receipt["requester_user_id"] == REQUESTER
    assert receipt["target_user_id"] is None
    assert receipt["proof_event_digest"]
    # A replacement holder must not be deletable using the old authentication event.
    await identity.ActorIdentityService().claim_verified_phone(
        user_id=OWNERS["wrong"], phone_number=PHONE
    )
    replay = await linked.prepare(REQUESTER, PHONE)
    with pytest.raises(HTTPException) as refused:
        await _confirm(replay["operation_id"], _deleting(calls))
    assert refused.value.detail["code"] == "PHONE_LINKED_DELETION_PROOF_ALREADY_USED"
    assert await _holder(db) == OWNERS["wrong"] and calls == [HOLDER]
    # Erasing the requester also retains only the hashed, non-replayable receipt.
    assert (await AccountService().delete_account(REQUESTER, target="both"))["success"] is True
    await _finish_cleanup(REQUESTER)
    assert not await _value(
        db,
        "SELECT count(*) FROM account_phone_linked_deletions WHERE operation_id=$1::uuid",
        replay["operation_id"],
    )
    assert (
        await _value(
            db,
            "SELECT count(*) FROM account_phone_linked_deletions WHERE operation_id=$1::uuid",
            prepared["operation_id"],
        )
        == 1
    )
    assert (
        await _value(
            db,
            "SELECT requester_user_id FROM account_phone_linked_deletions WHERE operation_id=$1::uuid",
            prepared["operation_id"],
        )
        is None
    )


@pytest.mark.parametrize("stage", ["before_proof", "binding_lock", "final_admission"])
async def test_sms_deadline_is_rechecked_after_waits(db, sms, monkeypatch, stage):
    prepared = await linked.prepare(REQUESTER, PHONE)
    calls = []
    if stage == "before_proof":
        sms.proofs["own"] = (PHONE, "phone-session", int(time.time()) - 301)
        with pytest.raises(HTTPException) as refused:
            await _confirm(prepared["operation_id"], _deleting(calls))
        assert refused.value.detail["code"] == "PHONE_LINKED_DELETION_FRESH_SMS_REQUIRED"
    else:
        actual_verify = linked._verify_proof

        async def expired_after_verification(*args):
            proof = await actual_verify(*args)
            return linked._Proof(proof.method, proof.digest, proof.uid, time.time() - 1)

        if stage == "binding_lock":
            monkeypatch.setattr(linked, "_verify_proof", expired_after_verification)
            delete = _deleting(calls)
        else:
            actual_admission = linked._admission_check
            monkeypatch.setattr(
                linked, "_admission_check", lambda row, _: actual_admission(row, time.time() - 1)
            )
            delete = _deleting(calls)
        result = await _confirm(prepared["operation_id"], delete)
        assert result["state"] == "refused"
        assert result["code"] == "PHONE_LINKED_DELETION_FRESH_SMS_REQUIRED"
    assert await _holder(db) == HOLDER
    assert not await _value(db, "SELECT count(*) FROM account_deletion_tombstones")


@pytest.mark.parametrize("change", ["binding", "protected", "generation", "expired_operation"])
async def test_changed_protected_or_expired_holder_is_not_deleted(db, sms, monkeypatch, change):
    prepared = await linked.prepare(REQUESTER, PHONE)
    if change == "binding":
        await _value(
            db, "UPDATE actor_identity_cache SET phone_number=$1 WHERE user_id=$2", MOVED, HOLDER
        )
    elif change == "protected":
        monkeypatch.setenv("REVIEWER_UID", HOLDER)
    elif change == "generation":
        await _value(
            db,
            "UPDATE account_phone_linked_deletions SET generation=generation+1 WHERE operation_id=$1::uuid",
            prepared["operation_id"],
        )
    else:
        await _value(
            db,
            "UPDATE account_phone_linked_deletions SET created_at=created_at-INTERVAL '10 minutes',expires_at=expires_at-INTERVAL '10 minutes' WHERE operation_id=$1::uuid",
            prepared["operation_id"],
        )
    calls = []
    result = await _confirm(prepared["operation_id"], _deleting(calls))
    assert result["state"] == ("expired" if change == "expired_operation" else "refused")
    assert calls == []
    assert not await _value(db, "SELECT count(*) FROM account_deletion_tombstones")


async def test_app_test_allowlist_still_requires_real_sms_for_deletion(db, sms, monkeypatch):
    monkeypatch.setenv("HUSHH_UAT_PHONE_TEST_NUMBERS", PHONE)
    prepared = await linked.prepare(REQUESTER, PHONE)
    assert prepared["transport"] == "sms"
    calls = []
    with pytest.raises(HTTPException) as refused:
        await linked.confirm(
            REQUESTER,
            prepared["operation_id"],
            PHONE,
            phone_id_token=None,
            test_code=CODE,
            delete=_deleting(calls),
        )
    assert refused.value.detail["code"] == "PHONE_LINKED_DELETION_REAL_SMS_REQUIRED"
    assert calls == [] and await _holder(db) == HOLDER
    assert (await _confirm(prepared["operation_id"], _deleting(calls)))["state"] == "admitted"
    assert calls == [HOLDER]


async def test_cancelled_operation_cannot_dispatch_with_a_fresh_proof(db, sms):
    prepared = await linked.prepare(REQUESTER, PHONE)
    assert (await linked.cancel(REQUESTER, prepared["operation_id"]))["state"] == "cancelled"
    calls = []
    assert (await _confirm(prepared["operation_id"], _deleting(calls)))["state"] == "cancelled"
    assert calls == [] and await _holder(db) == HOLDER


async def test_duplicate_confirmation_dispatches_once_and_never_claims_completed_erasure(db, sms):
    prepared = await linked.prepare(REQUESTER, PHONE)

    async def pending(*_):
        await asyncio.sleep(0)
        return {
            "success": True,
            "account_deleted": False,
            "cleanup_pending": True,
            "cleanup_operation": {"local_erasure_confirmation_required": True},
        }

    delete = AsyncMock(side_effect=pending)
    receipts = await asyncio.gather(*(_confirm(prepared["operation_id"], delete) for _ in range(2)))
    assert all(receipt["state"] in {"pending", "admitted"} for receipt in receipts)
    assert all("account_deleted" not in receipt for receipt in receipts)
    assert (await linked.status(REQUESTER, prepared["operation_id"]))["state"] == "admitted"
    assert await _holder(db) == HOLDER
    delete.assert_awaited_once()
