"""Disposable PostgreSQL and preserved-information fixture for phone contracts."""

from __future__ import annotations

import os
import re
from pathlib import Path
from unittest.mock import patch
from uuid import uuid4

import pytest

from hushh_mcp.services import phone_transfer_service as transfer
from tests.pkm_conformance import postgres_harness

ROOT = Path(__file__).resolve().parents[2]
PHONE = "+16505550101"


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
        server.apply_file(ROOT / "db/migrations/425_account_phone_transfers.sql")
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
