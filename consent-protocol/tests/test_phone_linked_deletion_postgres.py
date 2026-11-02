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
async def test_other_email_cannot_prepare_or_confirm_deletion_even_with_an_old_operation(
    db, monkeypatch, transport
):
    monkeypatch.setenv("HUSHH_PHONE_LINKED_DELETION_ENABLED", "true")
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
