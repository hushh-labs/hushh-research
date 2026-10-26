"""Current production cleanup boundaries on disposable PostgreSQL.

These focused cases and the SQL fixture come from deployed 7d5546e471.
The fixture is NOT a release migration: restoration never replays the database.
"""

from __future__ import annotations

import asyncio
import json
import os
from contextlib import asynccontextmanager
from pathlib import Path
from unittest.mock import AsyncMock, patch
from uuid import uuid4

import pytest
from sqlalchemy import create_engine

from tests.pkm_conformance import postgres_harness

ROOT = Path(__file__).resolve().parents[1]
pytestmark = [pytest.mark.feature_account_deletion, pytest.mark.trace_loop]


def _release_sql(name: str) -> str:
    return "\n".join(
        line
        for line in (ROOT.parent / "deploy/account-deletion" / name).read_text().splitlines()
        if not line.startswith("\\")
    )


@pytest.fixture(scope="module")
def database_url():
    # These tests create and drop public tables. Never accept a caller's runtime
    # URL: even an opted-in rehearsal must not erase existing recovery records.
    if postgres_harness.find_pg_bin() is None:
        if os.getenv("REQUIRE_ACCOUNT_DELETION_POSTGRES") == "1":
            pytest.fail("Account deletion gate requires disposable PostgreSQL")
        pytest.skip("local PostgreSQL unavailable")
    server = postgres_harness.TempPostgres()
    try:
        with patch.object(postgres_harness, "MIGRATIONS", []):
            server.start()
        yield f"postgresql://hushh@/postgres?host={server.dir}&port={server.port}"
    finally:
        server.stop()


@asynccontextmanager
async def _release_database(database_url, monkeypatch):
    """Isolate concurrency fixtures inside the disposable cluster only."""
    import asyncpg

    from hushh_mcp.services import account_deletion_release_admission as admission

    name = "release_" + uuid4().hex
    admin = await asyncpg.connect(database_url)
    await admin.execute(f'CREATE DATABASE "{name}"')
    url = database_url.replace("/postgres?", f"/{name}?")
    conn = await asyncpg.connect(url)
    await conn.execute("""
        CREATE TABLE actor_profiles(user_id text PRIMARY KEY);
        CREATE TABLE vault_keys(user_id text PRIMARY KEY);
        CREATE TABLE account_deletion_tombstones(
            erasure_phase text, cleanup_status text, provider_cleanup_receipt jsonb,
            cleanup_intent_kind text DEFAULT 'full_account', provider_cleanup_inventory jsonb DEFAULT '{}');
    """)

    @asynccontextmanager
    async def connect():
        lease = await asyncpg.connect(url)
        try:
            yield lease
        finally:
            await lease.close(timeout=3)

    monkeypatch.setattr(admission, "_connect", connect)
    try:
        yield conn, url
    finally:
        await conn.close()
        await admin.execute(f'DROP DATABASE "{name}" WITH (FORCE)')
        await admin.close()


async def test_release_fence_refuses_worker_and_sql_before_cleanup(database_url, monkeypatch):
    from hushh_mcp.services import account_deletion_provider_worker as worker
    from hushh_mcp.services import account_deletion_release_admission as admission

    async with _release_database(database_url, monkeypatch) as (conn, url):
        # The real installer also proves compatibility before journal migration.
        await conn.execute(
            "ALTER TABLE account_deletion_tombstones DROP COLUMN provider_cleanup_receipt"
        )
        await conn.execute(_release_sql("install_release_fence.sql"))
        load = AsyncMock()
        monkeypatch.setattr(worker.journal, "load_grants", load)
        with pytest.raises(admission.AccountDeletionReleasePaused):
            await worker.run_claim(object())
        load.assert_not_awaited()

        def attempt_sql():
            engine = create_engine(url)
            try:
                with engine.begin() as tx:
                    admission.admit_erasure_transaction(tx)
                    pytest.fail("release admission reached erasure")
            finally:
                engine.dispose()

        with pytest.raises(Exception, match="temporarily unavailable"):
            await asyncio.to_thread(attempt_sql)
        await conn.execute(_release_sql("remove_release_fence.sql"))
        async with admission.release_admission() as lease:
            await lease.check()


async def test_release_installer_serializes_workers_and_preserves_lost_session_uncertainty(
    database_url, monkeypatch
):
    import asyncpg

    from hushh_mcp.services import account_deletion_release_admission as admission

    async with _release_database(database_url, monkeypatch) as (conn, url):
        installer = await asyncpg.connect(url)
        task = None
        try:
            async with admission.release_admission() as lease:
                task = asyncio.create_task(
                    installer.execute(_release_sql("install_release_fence.sql"))
                )
                for _ in range(100):
                    if await conn.fetchval(
                        "SELECT cardinality(pg_blocking_pids($1))>0", installer.get_server_pid()
                    ):
                        break
                    await asyncio.sleep(0.01)
                assert not task.done(), "installer crossed a worker's active effect boundary"
                assert await conn.fetchval(
                    "SELECT cardinality(pg_blocking_pids($1))>0", installer.get_server_pid()
                )
                await lease.check()
            await asyncio.wait_for(task, 3)
            with pytest.raises(admission.AccountDeletionReleasePaused):
                async with admission.release_admission():
                    pytest.fail("worker crossed an installed fence")
            await conn.execute(_release_sql("remove_release_fence.sql"))

            async with admission.release_admission() as lease:
                await conn.execute("""INSERT INTO account_deletion_tombstones(erasure_phase,cleanup_status,provider_cleanup_receipt) VALUES(
                    'provider_cleanup','retry', '{"items":{"grant":{"revocation":"dispatched"}}}')""")
                lease._connection.terminate()
                with pytest.raises(admission.AccountDeletionReleasePaused):
                    await lease.check()
                # Session disappearance cannot certify an in-flight HTTP effect.
                with pytest.raises(
                    asyncpg.ObjectNotInPrerequisiteStateError, match="require settlement"
                ):
                    await installer.execute(_release_sql("install_release_fence.sql"))
                await installer.execute("ROLLBACK")
            assert not await conn.fetchval(admission._FENCED)
            await conn.execute("DELETE FROM account_deletion_tombstones")
            await conn.execute("CREATE TABLE shared_files_storage(state text)")
            await conn.execute("INSERT INTO shared_files_storage VALUES('erasing')")
            with pytest.raises(
                asyncpg.ObjectNotInPrerequisiteStateError, match="Files effects require settlement"
            ):
                await installer.execute(_release_sql("install_release_fence.sql"))
            await installer.execute("ROLLBACK")
            assert not await conn.fetchval(admission._FENCED)
        finally:
            if task is not None and not task.done():
                task.cancel()
                await asyncio.gather(task, return_exceptions=True)
            await installer.close()


async def test_shared_provider_sql_requires_exact_local_approval_and_no_dispatched_effects(
    database_url, monkeypatch
):
    async with _release_database(database_url, monkeypatch) as (conn, _url):
        import asyncpg

        await conn.execute("""INSERT INTO account_deletion_tombstones(erasure_phase,cleanup_status,provider_cleanup_receipt)
            VALUES('provider_cleanup','legacy','{"version":1,"items":{}}')""")
        await conn.execute(
            (
                ROOT / "tests/fixtures/account_cleanup/423_account_shared_provider_authority.sql"
            ).read_text()
        )
        ref, owner_hash, cleanup_id = "a" * 64, "sha256:" + "b" * 64, uuid4()
        inventory = {
            ref: {
                "revision": "c" * 64,
                "groupDigest": "d" * 64,
                "revocationSupport": "required",
                "watchRequired": True,
                "authorityScope": "retain_shared_google",
            }
        }
        digest = await conn.fetchval(
            "SELECT encode(sha256(convert_to($1::jsonb::text,'UTF8')),'hex')", json.dumps(inventory)
        )
        receipt = {
            "version": 2,
            "cleanupId": str(cleanup_id),
            "ownerHash": owner_hash,
            "inventorySha256": digest,
            "localErasureAccepted": True,
            "items": {
                ref: {
                    **inventory[ref],
                    "revocation": "local_erasure_approved",
                    "watchOutcome": "retained_shared",
                }
            },
        }

        async def qualified(value):
            return await conn.fetchval(
                "SELECT account_provider_cleanup_qualified($1::jsonb,$2::jsonb,$3,$4)",
                json.dumps(value),
                json.dumps(inventory),
                owner_hash,
                cleanup_id,
            )

        assert await qualified(receipt)
        with pytest.raises(asyncpg.InsufficientPrivilegeError, match="current cleanup producer"):
            await conn.execute("""INSERT INTO account_deletion_tombstones(erasure_phase,cleanup_status,provider_cleanup_receipt)
                VALUES('provider_cleanup','pending','{"version":1,"items":{}}')""")
        with pytest.raises(asyncpg.InsufficientPrivilegeError, match="legacy provider cleanup"):
            await conn.execute("""UPDATE account_deletion_tombstones SET
                provider_cleanup_receipt=provider_cleanup_receipt||'{"dispatch":"attempted"}'::jsonb
                WHERE cleanup_status='legacy'""")
        pending = {
            **receipt,
            "localErasureAccepted": False,
            "items": {ref: {**inventory[ref], "revocation": "pending", "watchOutcome": "pending"}},
        }
        await conn.execute(
            """INSERT INTO account_deletion_tombstones(erasure_phase,cleanup_status,
            provider_cleanup_receipt,provider_cleanup_inventory) VALUES('provider_cleanup','pending',$1::jsonb,$2::jsonb)""",
            json.dumps(pending),
            json.dumps(inventory),
        )
        for phase, value in [
            ("refresh", {"state": "dispatched"}),
            ("watchOutcome", "dispatched"),
            ("revocation", "dispatched"),
        ]:
            dispatched = {**pending, "items": {ref: {**pending["items"][ref], phase: value}}}
            with pytest.raises(asyncpg.InsufficientPrivilegeError, match="cannot be dispatched"):
                await conn.execute(
                    "UPDATE account_deletion_tombstones SET provider_cleanup_receipt=$1::jsonb WHERE cleanup_status='pending'",
                    json.dumps(dispatched),
                )
        for change in [
            {"localErasureAccepted": False},
            {"inventorySha256": "e" * 64},
            {"items": {ref: {**receipt["items"][ref], "revocation": "revoked"}}},
            {"items": {ref: {**receipt["items"][ref], "watchOutcome": "dispatched"}}},
            {"items": {ref: {**receipt["items"][ref], "refresh": {"state": "uncertain"}}}},
            {"items": {ref: {**receipt["items"][ref], "authorityScope": "exclusive"}}},
        ]:
            assert not await qualified({**receipt, **change})
