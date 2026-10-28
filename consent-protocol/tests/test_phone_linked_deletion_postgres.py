"""Phone-proven deletion of a number's holder, against disposable PostgreSQL only."""

from __future__ import annotations

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


async def test_account_erasure_detaches_receipts_and_keeps_owner_scoping(db):
    prepared = await linked.prepare(REQUESTER, PHONE)
    await _confirm(prepared["operation_id"], _deleting([]))
    assert (await AccountService().delete_account(REQUESTER, target="both"))["success"] is True
    async with db.pool.acquire() as conn:
        # ON DELETE SET NULL at final erasure is this identity-detaching UPDATE,
        # which the write guard permits only after each account's tombstone.
        await conn.execute(
            "UPDATE account_phone_linked_deletions SET target_user_id=NULL,requester_user_id=NULL"
        )
        row = await conn.fetchrow(
            "SELECT target_hash,requester_hash,state FROM account_phone_linked_deletions "
            "WHERE operation_id=$1::uuid",
            prepared["operation_id"],
        )
    assert row["state"] == "admitted"
    assert row["target_hash"] == account_deletion_user_hash(HOLDER)
    assert row["requester_hash"] == account_deletion_user_hash(REQUESTER)
    assert (await linked.status(REQUESTER, prepared["operation_id"]))["state"] == "admitted"
    with pytest.raises(HTTPException):
        await linked.status(OWNERS["wrong"], prepared["operation_id"])
    with pytest.raises(HTTPException):
        await linked.status(REQUESTER, str(uuid4()))
