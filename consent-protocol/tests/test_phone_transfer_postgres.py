"""Phone transfer boundaries against disposable PostgreSQL, never a runtime DB."""

from __future__ import annotations

import asyncio
import os
import re
from pathlib import Path
from unittest.mock import AsyncMock, patch
from uuid import uuid4

import asyncpg
import pytest
from fastapi import HTTPException
from sqlalchemy import create_engine

from hushh_mcp.services import actor_identity_service as identity
from hushh_mcp.services import phone_transfer_service as transfer
from hushh_mcp.services.account_deletion_lifecycle_service import account_deletion_user_hash
from tests.pkm_conformance import postgres_harness

ROOT = Path(__file__).resolve().parents[1]
PHONE = "+16505550101"
pytestmark = [pytest.mark.feature_auth_reliability, pytest.mark.trace_loop]


@pytest.fixture(scope="module")
def database_url():
    if postgres_harness.find_pg_bin() is None:
        if os.getenv("REQUIRE_PHONE_TRANSFER_POSTGRES") == "1" or os.getenv("CI") == "true":
            pytest.fail("Phone transfer verification requires disposable PostgreSQL")
        pytest.skip("local PostgreSQL unavailable")
    server = postgres_harness.TempPostgres()
    try:
        with patch.object(postgres_harness, "MIGRATIONS", []):
            server.start()
        server.execute("CREATE TABLE actor_profiles(user_id text PRIMARY KEY)")
        server.execute("""CREATE TABLE actor_identity_cache(user_id text PRIMARY KEY REFERENCES actor_profiles(user_id),
            display_name text,email text,phone_number text,custom_photo_url text,photo_url text,email_verified boolean,
            phone_verified boolean,source text,last_synced_at timestamptz,created_at timestamptz,updated_at timestamptz)""")
        server.execute(
            "CREATE UNIQUE INDEX phone_owner ON actor_identity_cache(phone_number) WHERE phone_verified=TRUE"
        )
        server.execute(
            "CREATE TABLE internal_access_events(id bigserial PRIMARY KEY,token_id text,user_id text,agent_id text,scope text,action text,issued_at bigint,metadata jsonb)"
        )
        server.execute(
            "CREATE TABLE account_generations(identity_hash text,owner_hash text,identity_uid text,owner_id text,generation bigint,retired_at timestamptz)"
        )
        sql = (ROOT / "db/migrations/419_account_generations.sql").read_text()
        server.execute(
            sql[
                sql.index(
                    "CREATE TABLE IF NOT EXISTS public.account_firebase_mutations"
                ) : sql.index(
                    "CREATE OR REPLACE FUNCTION public.guard_account_firebase_mutation_receipt"
                )
            ]
        )
        lifecycle_sql = (ROOT / "db/migrations/201_account_deletion_tombstones.sql").read_text()
        full_pgcrypto = server.execute(
            "SELECT EXISTS(SELECT 1 FROM pg_available_extensions WHERE name='pgcrypto')"
        )[0][0]
        if not full_pgcrypto:
            if os.getenv("CI") == "true":
                pytest.fail(
                    "CI must provide PostgreSQL with pgcrypto; never substitute release prerequisites"
                )
            # The portable local binary has core SHA-256 but lacks extension
            # packaging. Same hash semantics for this neighbour only; this is
            # not full release-schema qualification. CI uses migration verbatim.
            server.execute(
                "CREATE FUNCTION digest(value bytea, algorithm text) RETURNS bytea LANGUAGE sql IMMUTABLE AS $$ SELECT CASE WHEN algorithm='sha256' THEN sha256(value) END $$"
            )
            server.execute(
                "CREATE FUNCTION digest(value text, algorithm text) RETURNS bytea LANGUAGE sql IMMUTABLE AS $$ SELECT digest(convert_to(value,'UTF8'),algorithm) $$"
            )
            lifecycle_sql = lifecycle_sql.replace("CREATE EXTENSION IF NOT EXISTS pgcrypto;", "")
        server.execute(lifecycle_sql)
        files_sql = (ROOT / "db/migrations/420_private_agent_lifecycle_foundation.sql").read_text()
        files_start = files_sql.index('CREATE TABLE IF NOT EXISTS public."shared_files_storage"')
        server.execute(files_sql[files_start : files_sql.index(");", files_start) + 2])
        for constraint in re.findall(
            r'EXECUTE \$object\$(ALTER TABLE public\."shared_files_storage" ADD CONSTRAINT .*?;)\$object\$;',
            files_sql,
        ):
            server.execute(constraint)
        server.apply_file(ROOT / "db/migrations/424_account_phone_transfers.sql")
        yield f"postgresql://hushh@/postgres?host={server.dir}&port={server.port}"
    finally:
        server.stop()


async def seed(pool, *, fail_write=False):
    async with pool.acquire() as conn:
        await conn.execute(
            "TRUNCATE account_deletion_tombstones,account_generations,account_phone_transfers,account_phone_auth_fences,account_firebase_mutations,internal_access_events,actor_identity_cache,actor_profiles,vault_keys,pkm_data CASCADE"
        )
        await conn.executemany(
            "INSERT INTO actor_profiles(user_id) VALUES($1)",
            [(x,) for x in ("previous", "receiving-a", "receiving-b")],
        )
        await conn.execute(
            "INSERT INTO actor_identity_cache(user_id,phone_number,phone_verified,display_name,email) VALUES('previous',$1,TRUE,'Preserved','private@example.test')",
            PHONE,
        )
        await conn.execute(
            "INSERT INTO pkm_data(user_id,encrypted_data_ciphertext) VALUES('previous','unchanged-ciphertext')"
        )
        await conn.execute(
            "INSERT INTO vault_keys(user_id,vault_status) VALUES('previous','locked')"
        )
        await conn.execute(
            "INSERT INTO shared_files_storage(user_id,bucket,prefix) VALUES('previous','fixture-ciphertext-bucket','opaque-library-prefix')"
        )
        before = await conn.fetchrow("SELECT * FROM pkm_data WHERE user_id='previous'")
        intents = []
        for index, owner in enumerate(("receiving-a", "receiving-b")):
            operation = str(uuid4())
            event = f"fresh-event-{index}"
            await conn.execute(
                """INSERT INTO account_phone_transfers(operation_id,user_id,previous_user_id,previous_revision,
                phone_digest,proof_digest,expires_at,proof_identity_uid,authority_project,proof_owner_id)
                VALUES($1::uuid,$2,'previous',0,$3,$4,NOW()+INTERVAL '5 minutes','previous','synthetic-auth','previous')""",
                operation,
                owner,
                transfer.account_deletion_phone_digest(PHONE),
                transfer.proof_digest(event),
            )
            intents.append(
                transfer.ConfirmedTransfer(
                    operation,
                    transfer.proof_digest(event),
                    "previous",
                    "previous",
                    0,
                    "synthetic-auth",
                    "previous",
                )
            )
        if fail_write:
            await conn.execute(
                "ALTER TABLE actor_identity_cache ADD CONSTRAINT fail_receiving_claim CHECK(user_id <> 'receiving-a')"
            )
        return intents, before


async def test_two_concurrent_confirmations_preserve_information_and_retire_only_phone(
    database_url, monkeypatch
):
    pool = await asyncpg.create_pool(database_url, min_size=1, max_size=2, command_timeout=5)
    engine = create_engine(database_url)
    monkeypatch.setattr(identity, "get_pool", AsyncMock(return_value=pool))
    monkeypatch.setattr(identity.ActorIdentityService, "_ensure_actor_spine", AsyncMock())
    monkeypatch.setattr(
        identity.ActorIdentityService, "_sync_referral_qualification_best_effort", AsyncMock()
    )
    monkeypatch.setattr(transfer, "get_db_connection", engine.begin)
    try:
        intents, before = await seed(pool)
        async with pool.acquire() as conn:
            before_files = await conn.fetchrow(
                "SELECT * FROM shared_files_storage WHERE user_id='previous'"
            )
        results = await asyncio.wait_for(
            asyncio.gather(
                *(
                    identity.ActorIdentityService().claim_verified_phone(
                        user_id=owner, phone_number=PHONE, transfer=intent
                    )
                    for owner, intent in zip(("receiving-a", "receiving-b"), intents, strict=True)
                ),
                return_exceptions=True,
            ),
            8,
        )
        assert sum(isinstance(result, dict) for result in results) == 1
        async with pool.acquire() as conn:
            assert (
                await conn.fetchval(
                    "SELECT count(*) FROM actor_identity_cache WHERE phone_number=$1 AND phone_verified=TRUE",
                    PHONE,
                )
                == 1
            )
            assert (
                await conn.fetchval(
                    "SELECT phone_number FROM actor_identity_cache WHERE user_id='previous'"
                )
                is None
            )
            assert (
                await conn.fetchval(
                    "SELECT display_name FROM actor_identity_cache WHERE user_id='previous'"
                )
                == "Preserved"
            )
            assert await conn.fetchrow("SELECT * FROM pkm_data WHERE user_id='previous'") == before
            assert (
                await conn.fetchval("SELECT vault_status FROM vault_keys WHERE user_id='previous'")
                == "locked"
            )
            assert (
                await conn.fetchrow("SELECT * FROM shared_files_storage WHERE user_id='previous'")
                == before_files
            )
            assert await conn.fetchval("SELECT count(*) FROM account_firebase_mutations") == 1
            assert (
                await conn.fetchval(
                    "SELECT count(*) FROM account_phone_transfers WHERE state='committed'"
                )
                == 1
            )
            assert (
                await conn.fetchval(
                    "SELECT count(*) FROM internal_access_events WHERE action='REVOKED'"
                )
                == 1
            )
        with pytest.raises(HTTPException) as refused:
            transfer.assert_phone_admission(
                "previous",
                {
                    "uid": "previous",
                    "phone_number": PHONE,
                    "firebase": {"sign_in_provider": "phone"},
                },
            )
        assert refused.value.detail["code"] == "AUTH_PHONE_ACCESS_REVOKED"
        transfer.assert_phone_admission(
            "previous", {"uid": "previous", "firebase": {"sign_in_provider": "google.com"}}
        )
        with pytest.raises(HTTPException) as phone_only:
            transfer.assert_phone_admission(
                "previous",
                {
                    "uid": "previous",
                    "phone_number": "+16505550202",
                    "firebase": {"sign_in_provider": "phone"},
                },
            )
        assert phone_only.value.detail["code"] == "AUTH_INDEPENDENT_SIGN_IN_REQUIRED"
    finally:
        engine.dispose()
        await pool.close()


async def test_failed_transfer_rolls_back_binding_consumption_and_revocation(
    database_url, monkeypatch
):
    pool = await asyncpg.create_pool(database_url, min_size=1, max_size=2, command_timeout=5)
    monkeypatch.setattr(identity, "get_pool", AsyncMock(return_value=pool))
    monkeypatch.setattr(identity.ActorIdentityService, "_ensure_actor_spine", AsyncMock())
    try:
        intents, before = await seed(pool, fail_write=True)
        result = await identity.ActorIdentityService().claim_verified_phone(
            user_id="receiving-a", phone_number=PHONE, transfer=intents[0]
        )
        assert result is None
        async with pool.acquire() as conn:
            assert (
                await conn.fetchval(
                    "SELECT phone_number FROM actor_identity_cache WHERE user_id='previous'"
                )
                == PHONE
            )
            assert await conn.fetchrow("SELECT * FROM pkm_data WHERE user_id='previous'") == before
            for table in (
                "account_phone_auth_fences",
                "account_firebase_mutations",
                "internal_access_events",
            ):
                assert await conn.fetchval(f"SELECT count(*) FROM {table}") == 0
            assert (
                await conn.fetchval(
                    "SELECT count(*) FROM account_phone_transfers WHERE state<>'prepared'"
                )
                == 0
            )
            await conn.execute(
                "ALTER TABLE actor_identity_cache DROP CONSTRAINT fail_receiving_claim"
            )
    finally:
        await pool.close()


@pytest.mark.parametrize("age,fixture", [(301, False), (-1, False), (0, True)])
def test_transfer_requires_fresh_real_sms(monkeypatch, age, fixture):
    monkeypatch.setattr(transfer.time, "time", lambda: 1000)
    monkeypatch.setenv("HUSHH_PROD_PHONE_TEST_NUMBERS", PHONE if fixture else "")
    with pytest.raises(HTTPException):
        transfer.require_fresh_sms_claims({"auth_time": 1000 - age}, PHONE)
    monkeypatch.setenv("HUSHH_PROD_PHONE_TEST_NUMBERS", "")
    transfer.require_fresh_sms_claims({"auth_time": 1000}, PHONE)


@pytest.mark.parametrize(
    "change", ["previous_aba", "receiving_revision", "expired", "replayed", "generation"]
)
async def test_stale_authority_cannot_move_a_binding(database_url, monkeypatch, change):
    pool = await asyncpg.create_pool(database_url, min_size=1, max_size=2, command_timeout=5)
    monkeypatch.setattr(identity, "get_pool", AsyncMock(return_value=pool))
    monkeypatch.setattr(identity.ActorIdentityService, "_ensure_actor_spine", AsyncMock())
    try:
        intents, before = await seed(pool)
        async with pool.acquire() as conn:
            if change == "previous_aba":
                await conn.execute(
                    "UPDATE actor_identity_cache SET phone_number=NULL,phone_verified=FALSE WHERE user_id='previous'"
                )
                await conn.execute(
                    "UPDATE actor_identity_cache SET phone_number=$1,phone_verified=TRUE WHERE user_id='previous'",
                    PHONE,
                )
            elif change == "receiving_revision":
                await conn.execute(
                    "INSERT INTO actor_identity_cache(user_id,phone_binding_revision) VALUES('receiving-a',1)"
                )
            elif change == "expired":
                await conn.execute(
                    "UPDATE account_phone_transfers SET created_at=NOW()-INTERVAL '10 minutes',expires_at=NOW()-INTERVAL '1 minute'"
                )
            elif change == "replayed":
                await conn.execute(
                    "UPDATE account_phone_transfers SET state='completed' WHERE operation_id=$1::uuid",
                    intents[0].operation_id,
                )
            else:
                await conn.execute(
                    "INSERT INTO account_generations(identity_hash,owner_id,generation) VALUES($1,'replacement-generation',1)",
                    account_deletion_user_hash("previous"),
                )
        if change == "generation":
            assert (
                await identity.ActorIdentityService().claim_verified_phone(
                    user_id="receiving-a", phone_number=PHONE, transfer=intents[0]
                )
                is None
            )
        else:
            with pytest.raises(HTTPException):
                await identity.ActorIdentityService().claim_verified_phone(
                    user_id="receiving-a", phone_number=PHONE, transfer=intents[0]
                )
        async with pool.acquire() as conn:
            assert (
                await conn.fetchval(
                    "SELECT phone_number FROM actor_identity_cache WHERE user_id='previous'"
                )
                == PHONE
            )
            assert await conn.fetchrow("SELECT * FROM pkm_data WHERE user_id='previous'") == before
            assert await conn.fetchval("SELECT count(*) FROM account_firebase_mutations") == 0
            assert await conn.fetchval("SELECT count(*) FROM internal_access_events") == 0
    finally:
        await pool.close()


async def test_pending_provider_work_blocks_erasure_and_rollback_removes_only_workflow(
    database_url, monkeypatch
):
    pool = await asyncpg.create_pool(database_url, min_size=1, max_size=2, command_timeout=5)
    monkeypatch.setattr(identity, "get_pool", AsyncMock(return_value=pool))
    monkeypatch.setattr(identity.ActorIdentityService, "_ensure_actor_spine", AsyncMock())
    monkeypatch.setattr(
        identity.ActorIdentityService, "_sync_referral_qualification_best_effort", AsyncMock()
    )
    try:
        intents, _ = await seed(pool)
        assert await identity.ActorIdentityService().claim_verified_phone(
            user_id="receiving-a", phone_number=PHONE, transfer=intents[0]
        )
        engine = create_engine(database_url)
        try:
            for owner in ("previous", "receiving-a"):
                with engine.begin() as sync_conn:
                    from hushh_mcp.services.account_deletion_lifecycle_service import (
                        AccountDeletionLifecycleService,
                    )

                    AccountDeletionLifecycleService._lock_user_ids_in_transaction(
                        sync_conn, user_ids=(owner,)
                    )
                    with pytest.raises(transfer.PhoneTransferInProgressError):
                        transfer.assert_erasure_ready(
                            sync_conn,
                            owner,
                            lambda _conn, table: table == "account_phone_transfers",
                        )
        finally:
            engine.dispose()
        async with pool.acquire() as conn:
            for owner in ("previous", "receiving-a"):
                with pytest.raises(asyncpg.CheckViolationError, match="PHONE_TRANSFER_IN_PROGRESS"):
                    await conn.execute("DELETE FROM actor_profiles WHERE user_id=$1", owner)
            # The exact rollback remains blocked by any unsettled reservation.
            rollback = (
                ROOT / "db/migrations/rollback/424_account_phone_transfers.rollback.sql"
            ).read_text()
            with pytest.raises(asyncpg.RaiseError, match="reconciliation required"):
                await conn.execute(rollback)
            await conn.execute("UPDATE account_phone_transfers SET state='completed'")
            await conn.execute(rollback)
            assert not await conn.fetchval(
                "SELECT EXISTS(SELECT 1 FROM pg_trigger WHERE tgname='pending_phone_transfer_erasure')"
            )
            assert await conn.fetchval("SELECT count(*) FROM account_phone_auth_fences") == 1
            await conn.execute("DELETE FROM actor_identity_cache WHERE user_id='receiving-b'")
            await conn.execute("DELETE FROM actor_profiles WHERE user_id='receiving-b'")
            # Restore the isolated fixture for any later case.
            await conn.execute((ROOT / "db/migrations/424_account_phone_transfers.sql").read_text())
    finally:
        await pool.close()


async def test_receiving_identity_keeps_its_existing_provider_credential(database_url, monkeypatch):
    pool = await asyncpg.create_pool(database_url, min_size=1, max_size=2, command_timeout=5)
    monkeypatch.setattr(identity, "get_pool", AsyncMock(return_value=pool))
    monkeypatch.setattr(identity.ActorIdentityService, "_ensure_actor_spine", AsyncMock())
    monkeypatch.setattr(
        identity.ActorIdentityService, "_sync_referral_qualification_best_effort", AsyncMock()
    )
    try:
        intents, before = await seed(pool)
        intent = intents[0]
        intent.proof_uid = intent.proof_owner_id = "receiving-a"
        intent.unlink_required = False
        async with pool.acquire() as conn:
            await conn.execute(
                "UPDATE account_phone_transfers SET proof_identity_uid='receiving-a',proof_owner_id='receiving-a',unlink_required=FALSE WHERE operation_id=$1::uuid",
                intent.operation_id,
            )
        assert await identity.ActorIdentityService().claim_verified_phone(
            user_id="receiving-a", phone_number=PHONE, transfer=intent
        )
        async with pool.acquire() as conn:
            assert (
                await conn.fetchval(
                    "SELECT state FROM account_phone_transfers WHERE operation_id=$1::uuid",
                    intent.operation_id,
                )
                == "completed"
            )
            assert await conn.fetchval("SELECT count(*) FROM account_firebase_mutations") == 0
            assert await conn.fetchval("SELECT count(*) FROM account_phone_auth_fences") == 0
            assert await conn.fetchrow("SELECT * FROM pkm_data WHERE user_id='previous'") == before
    finally:
        await pool.close()


async def test_status_cannot_release_a_live_or_uncertain_provider_dispatch(
    database_url, monkeypatch
):
    from types import SimpleNamespace

    from firebase_admin import auth

    pool = await asyncpg.create_pool(database_url, min_size=1, max_size=2, command_timeout=5)
    monkeypatch.setattr(identity, "get_pool", AsyncMock(return_value=pool))
    monkeypatch.setattr(transfer, "get_pool", AsyncMock(return_value=pool))
    monkeypatch.setattr(identity.ActorIdentityService, "_ensure_actor_spine", AsyncMock())
    monkeypatch.setattr(
        identity.ActorIdentityService, "_sync_referral_qualification_best_effort", AsyncMock()
    )
    monkeypatch.setattr(
        identity.ActorIdentityService,
        "get_many",
        AsyncMock(return_value={"receiving-a": {"user_id": "receiving-a", "phone_verified": True}}),
    )
    remote_lookup = AsyncMock(return_value=SimpleNamespace(phone_number=None))
    settle = AsyncMock()
    monkeypatch.setattr(auth, "get_user", remote_lookup)
    monkeypatch.setattr(transfer.mutations, "settle", settle)
    try:
        intents, _ = await seed(pool)
        assert await identity.ActorIdentityService().claim_verified_phone(
            user_id="receiving-a", phone_number=PHONE, transfer=intents[0]
        )
        async with pool.acquire() as conn:
            await conn.execute(
                "UPDATE account_phone_transfers SET effect_state='dispatched',committed_at=clock_timestamp()-INTERVAL '1 minute' WHERE operation_id=$1::uuid",
                intents[0].operation_id,
            )
        for effect in ("dispatched", "uncertain"):
            async with pool.acquire() as conn:
                await conn.execute(
                    "UPDATE account_phone_transfers SET effect_state=$2 WHERE operation_id=$1::uuid",
                    intents[0].operation_id,
                    effect,
                )
            result = await transfer.status(
                "receiving-a", intents[0].operation_id, SimpleNamespace(project_id="synthetic-auth")
            )
            assert result["transfer_status"] == "action_required"
        settle.assert_not_called()
        remote_lookup.assert_not_called()
        async with pool.acquire() as conn:
            assert (
                await conn.fetchval("SELECT state FROM account_firebase_mutations") == "dispatched"
            )
            assert (
                await conn.fetchval(
                    "SELECT state FROM account_phone_transfers WHERE operation_id=$1::uuid",
                    intents[0].operation_id,
                )
                == "committed"
            )
            await conn.execute(
                "UPDATE account_firebase_mutations SET state='succeeded',settled_at=clock_timestamp()"
            )
        result = await transfer.status(
            "receiving-a", intents[0].operation_id, SimpleNamespace(project_id="synthetic-auth")
        )
        assert result["transfer_status"] == "completed"
    finally:
        await pool.close()
