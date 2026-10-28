"""Phone-proven deletion of a number's holder, against disposable PostgreSQL only."""

from __future__ import annotations

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
        monkeypatch.setenv("HUSHH_PHONE_LINKED_DELETION_ENABLED", "true")
        for name in (
            "APP_RUNTIME_PROFILE",
            "HUSHH_DEPLOY_ENV",
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


def _shape(result):
    return {
        k: v for k, v in result.items() if k not in {"operation_id", "expires_at", "phone_hint"}
    }


async def _value(db, sql, *args):
    async with db.pool.acquire() as conn:
        return await conn.fetchval(sql, *args)


async def _holder(db):
    return await _value(
        db,
        "SELECT user_id FROM actor_identity_cache WHERE phone_number=$1 AND phone_verified",
        PHONE,
    )


async def _confirm(operation, delete, phone=PHONE, code=CODE):
    return await linked.confirm(
        REQUESTER, operation, phone, phone_id_token=None, test_code=code, delete=delete
    )


async def test_preparation_is_opaque_until_possession_is_proven(db):
    bound = await linked.prepare(REQUESTER, PHONE)
    unbound = await linked.prepare(REQUESTER, UNBOUND)
    assert _shape(bound) == _shape(unbound) == {"state": "prepared", "transport": "configured_test"}
    calls = []
    result = await _confirm(unbound["operation_id"], _deleting(calls), phone=UNBOUND)
    assert result["state"] == "refused" and result["code"] == "PHONE_LINKED_ACCOUNT_NOT_FOUND"
    assert calls == [] and await _holder(db) == HOLDER


async def test_fixture_code_deletes_the_holder_once_and_the_requester_claims_the_number(db):
    prepared = await linked.prepare(REQUESTER, PHONE)
    calls = []
    with pytest.raises(HTTPException) as wrong:
        await _confirm(prepared["operation_id"], _deleting(calls), code="000000")
    assert wrong.value.status_code == 401 and calls == []
    result = await _confirm(prepared["operation_id"], _deleting(calls))
    assert result == {"operation_id": prepared["operation_id"], "state": "admitted"}
    # A lost response replays the receipt; the erasure is never dispatched twice.
    assert await _confirm(prepared["operation_id"], _deleting(calls)) == result
    assert await linked.status(REQUESTER, prepared["operation_id"]) == result
    assert calls == [HOLDER]
    assert (
        await _value(
            db,
            "SELECT cleanup_intent_kind FROM account_deletion_tombstones WHERE user_id_hash=$1",
            account_deletion_user_hash(HOLDER),
        )
        == "full_account"
    )
    # The admitted deletion releases the number to the requester's ordinary claim.
    service = identity.ActorIdentityService()
    assert await service.can_claim_test_phone(user_id=REQUESTER, phone_number=PHONE)
    claimed = await service.claim_verified_phone(
        user_id=REQUESTER, phone_number=PHONE, source="uat_test_phone_claim"
    )
    assert claimed["phone_verified"] is True and await _holder(db) == REQUESTER


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


@pytest.mark.parametrize("change", ["binding", "protected", "production"])
async def test_changed_or_protected_holder_is_never_deleted(db, monkeypatch, change):
    prepared = await linked.prepare(REQUESTER, PHONE)
    calls = []
    if change == "binding":
        await _value(
            db, "UPDATE actor_identity_cache SET phone_number=$1 WHERE user_id=$2", MOVED, HOLDER
        )
    elif change == "protected":
        monkeypatch.setenv("REVIEWER_UID", HOLDER)
    else:
        # A production runtime profile wins over a stray UAT environment label.
        monkeypatch.setenv("APP_RUNTIME_PROFILE", "production")
        monkeypatch.setenv("HUSHH_PHONE_LINKED_DELETION_ENABLED", "true")
    attempt = _confirm(prepared["operation_id"], _deleting(calls))
    if change == "production":
        # A shared fixture code is never possession in production.
        with pytest.raises(HTTPException) as refused:
            await attempt
        assert refused.value.detail["code"] == "PHONE_LINKED_DELETION_REAL_SMS_REQUIRED"
    else:
        result = await attempt
        assert result["state"] == "refused"
        assert (
            result["code"]
            == {
                "binding": "PHONE_LINKED_DELETION_STALE",
                "protected": "PHONE_LINKED_ACCOUNT_PROTECTED",
            }[change]
        )
    assert calls == []
    assert not await _value(db, "SELECT count(*) FROM account_deletion_tombstones")


async def test_recheck_inside_admission_refuses_a_number_moved_before_commit(db):
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


async def test_uncertain_dispatch_settles_only_from_the_durable_tombstone(db):
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


async def test_receipts_are_scoped_to_their_requester(db):
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


async def test_confirm_never_rebinds_the_operation_to_another_number(db):
    prepared = await linked.prepare(REQUESTER, PHONE)
    calls = []
    with pytest.raises(HTTPException) as stale:
        await _confirm(prepared["operation_id"], _deleting(calls), phone=UNBOUND)
    assert stale.value.status_code == 409
    assert stale.value.detail["code"] == "PHONE_LINKED_DELETION_STALE"
    assert calls == [] and await _holder(db) == HOLDER


async def test_five_wrong_fixture_codes_cancel_the_operation(db):
    prepared = await linked.prepare(REQUESTER, PHONE)
    calls = []
    for _ in range(5):
        with pytest.raises(HTTPException):
            await _confirm(prepared["operation_id"], _deleting(calls), code="000000")
    result = await _confirm(prepared["operation_id"], _deleting(calls))
    assert result["state"] == "cancelled"
    assert result["code"] == "PHONE_LINKED_DELETION_ATTEMPTS_EXCEEDED" and calls == []


@pytest.mark.parametrize(
    "code", [PERSONAL_AGENT_DEPROVISION_REQUIRED_CODE, "ACCOUNT_DELETION_CLEANUP_UNAVAILABLE"]
)
async def test_a_returned_erasure_refusal_is_definite(db, code):
    prepared = await linked.prepare(REQUESTER, PHONE)
    refused = AsyncMock(
        return_value={"success": False, "account_deleted": False, "error_code": code}
    )
    result = await _confirm(prepared["operation_id"], refused)
    assert result == {"operation_id": prepared["operation_id"], "state": "refused", "code": code}
    assert await _holder(db) == HOLDER


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


@pytest.fixture
def sms(db, monkeypatch):
    """Real-number transport; each token maps to one recorded Firebase phone proof."""
    import api.utils.firebase_admin as firebase_admin
    import api.utils.phone_claim_proof as claim_proof
    from hushh_mcp.services import phone_transfer_authority

    monkeypatch.delenv("HUSHH_UAT_PHONE_TEST_NUMBERS")
    proofs = {}

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
