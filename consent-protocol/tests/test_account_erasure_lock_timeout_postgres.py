"""Blocked erasure rolls back on real, disposable PostgreSQL."""

from __future__ import annotations

import asyncio
import os
from pathlib import Path
from time import monotonic
from unittest.mock import AsyncMock, patch

import pytest
from sqlalchemy import create_engine

from hushh_mcp.services import account_deletion_lifecycle_service as lifecycle
from hushh_mcp.services import account_service as account
from hushh_mcp.services.account_deletion_provider_cleanup import ProviderCredentialSnapshot
from tests.pkm_conformance import postgres_harness

ROOT = Path(__file__).resolve().parents[1]


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


async def test_real_blocked_erasure_rolls_back_and_releases_session_barrier(database_url):
    import asyncpg

    deletion = await asyncpg.connect(database_url)
    holder = await asyncpg.connect(database_url)
    try:
        await deletion.execute("CREATE TABLE actor_profiles (user_id TEXT PRIMARY KEY)")
        await deletion.execute("CREATE TABLE IF NOT EXISTS vault_keys (user_id TEXT PRIMARY KEY)")
        await deletion.execute(
            (ROOT / "db/migrations/201_account_deletion_tombstones.sql").read_text(encoding="utf-8")
        )
        await _assert_blocked_erasure_rolls_back(database_url, deletion, holder)
    finally:
        await holder.close()
        await deletion.close()


async def _assert_blocked_erasure_rolls_back(database_url, deletion_conn, writer_conn) -> None:
    """A stuck DELETE must release the UID barriers without erasing the account."""
    uid = "synthetic_blocked_erasure"
    await deletion_conn.execute("CREATE TABLE one_adk_sessions (user_id TEXT PRIMARY KEY)")
    await deletion_conn.execute("INSERT INTO actor_profiles(user_id) VALUES($1)", uid)
    await deletion_conn.execute("INSERT INTO one_adk_sessions(user_id) VALUES($1)", uid)
    holder = writer_conn.transaction()
    await holder.start()
    engine = create_engine(database_url)
    release = AsyncMock()
    service = account.AccountService()
    erasure = None

    def delete_blocked_row(conn, *, params, **_kwargs):
        service._delete_user_rows_if_table_exists(
            conn, table_name="one_adk_sessions", params=params
        )

    try:
        # A row lock alone does not acquire the account's lifecycle barrier.
        # The erasure can therefore insert its tombstone, then block on DELETE.
        await writer_conn.fetchval(
            "SELECT user_id FROM one_adk_sessions WHERE user_id=$1 FOR UPDATE", uid
        )
        with (
            patch.object(account, "get_db_connection", engine.begin),
            patch.object(lifecycle, "get_db_connection", engine.begin),
            patch.object(account, "guard_answer_erasure"),
            patch.object(account, "list_connection_graph_viewer_ids", return_value=set()),
            patch.object(
                account,
                "snapshot_provider_credentials_in_transaction",
                return_value=ProviderCredentialSnapshot(user_id=uid),
            ),
            patch.object(account, "release_provider_grants_after_erasure", release),
            patch.object(service, "_delete_personal_agent_state"),
            patch.object(service, "_clear_external_connector_data"),
            patch.object(service, "_clear_live_memory_source_journal"),
            patch.object(
                service, "_table_exists", side_effect=lambda _, name: name == "one_adk_sessions"
            ),
            patch.object(service, "_delete_optional_user_tables", side_effect=delete_blocked_row),
        ):
            started = monotonic()
            erasure = asyncio.create_task(
                service._settle_full_account_transaction(uid, requested_target="both"),
            )
            completed, _ = await asyncio.wait({erasure}, timeout=6)
            assert completed, "blocked erasure exceeded its SQL deadline"
            result = await erasure
            assert monotonic() - started < 6
            assert result["success"] is False
            assert result["account_deleted"] is False
            assert "lock timeout" in result["error"]
            assert not await asyncio.to_thread(
                lifecycle.AccountDeletionLifecycleService.is_tombstoned, uid
            )
            release.assert_not_awaited()
        assert (
            await deletion_conn.fetchval(
                "SELECT count(*) FROM actor_profiles WHERE user_id=$1", uid
            )
            == 1
        )
        assert (
            await deletion_conn.fetchval(
                "SELECT count(*) FROM one_adk_sessions WHERE user_id=$1", uid
            )
            == 1
        )
    finally:
        await holder.rollback()
        if erasure is not None:
            await erasure
        engine.dispose()


def test_recovery_erasure_reference_indexes_replay_validate_and_roll_back(database_url):
    from sqlalchemy import text

    names = (
        "412_pkm_recovery_erasure_indexes.sql",
        "413_pkm_recovery_erasure_index.sql",
        "414_pkm_recovery_erasure_index.sql",
        "415_validate_pkm_recovery_erasure_indexes.sql",
    )
    engine = create_engine(database_url, isolation_level="AUTOCOMMIT")
    try:
        with engine.connect() as conn:
            for table, column in (
                ("pkm_domain_commits", "archived_revision_id"),
                ("pkm_upgrade_claims", "archived_revision_id"),
                ("pkm_upgrade_steps", "last_archived_revision_id"),
            ):
                conn.execute(text(f"CREATE TABLE {table} ({column} UUID)"))
            for _ in range(2):
                for name in names:
                    conn.execute(text((ROOT / "db/migrations" / name).read_text()))
            for name in reversed(names):
                down = name.replace(".sql", ".rollback.sql")
                conn.execute(text((ROOT / "db/migrations/rollback" / down).read_text()))
            assert (
                conn.execute(
                    text(
                        "SELECT count(*) FROM pg_indexes WHERE indexname IN ('idx_pkm_domain_commits_archived_revision', 'idx_pkm_upgrade_claims_archived_revision', 'idx_pkm_upgrade_steps_archived_revision')"
                    )
                ).scalar()
                == 0
            )
    finally:
        with engine.connect() as conn:
            conn.execute(
                text(
                    "DROP TABLE IF EXISTS pkm_domain_commits, pkm_upgrade_claims, pkm_upgrade_steps CASCADE"
                )
            )
        engine.dispose()


@pytest.mark.parametrize("rollback", [False, True], ids=["commit", "rollback"])
def test_large_recovery_history_erasure_is_bounded_atomic_and_owner_scoped(database_url, rollback):
    """Slow ciphertext removal must fit each SQL budget without partial commits."""
    from sqlalchemy import text

    engine = create_engine(database_url)
    service = account.AccountService()
    try:
        with engine.begin() as conn:
            conn.execute(
                text(
                    "CREATE TABLE pkm_domain_revisions (revision_id UUID PRIMARY KEY, user_id TEXT NOT NULL)"
                )
            )
            conn.execute(
                text(
                    "CREATE TABLE pkm_domain_revision_segments (revision_id UUID REFERENCES pkm_domain_revisions ON DELETE CASCADE, segment_id TEXT, ciphertext TEXT, PRIMARY KEY (revision_id, segment_id))"
                )
            )
            conn.execute(
                text(
                    "INSERT INTO pkm_domain_revisions VALUES ('00000000-0000-0000-0000-000000000001', 'departing'), ('00000000-0000-0000-0000-000000000002', 'peer')"
                )
            )
            conn.execute(
                text(
                    "INSERT INTO pkm_domain_revision_segments SELECT revision_id, n::TEXT, repeat('synthetic-ciphertext', 1024) FROM pkm_domain_revisions CROSS JOIN generate_series(1, 300) n"
                )
            )
            # A deterministic stand-in for expensive TOAST removal: the old
            # 300-row statement exceeds 700ms, while 100-row batches fit.
            conn.execute(
                text(
                    "CREATE FUNCTION slow_erasure() RETURNS TRIGGER LANGUAGE plpgsql AS $$ BEGIN PERFORM pg_sleep(0.004); RETURN OLD; END $$"
                )
            )
            conn.execute(
                text(
                    "CREATE TRIGGER slow_erasure BEFORE DELETE ON pkm_domain_revision_segments FOR EACH ROW EXECUTE FUNCTION slow_erasure()"
                )
            )
        try:
            with engine.begin() as conn:
                conn.execute(text("SET LOCAL statement_timeout='700ms'"))
                # Exercise the production account-erasure entrypoint and SQL,
                # including its loop, rather than a copied test-only query.
                service._delete_user_rows_if_table_exists(
                    conn, table_name="pkm_domain_revision_segments", params={"user_id": "departing"}
                )
                assert (
                    conn.execute(
                        text(
                            "SELECT count(*) FROM pkm_domain_revision_segments s JOIN pkm_domain_revisions r USING (revision_id) WHERE r.user_id='departing'"
                        )
                    ).scalar()
                    == 0
                )
                if rollback:
                    raise RuntimeError("synthetic later erasure failure")
        except RuntimeError:
            if not rollback:
                raise
        with engine.connect() as conn:
            counts = dict(
                conn.execute(
                    text(
                        "SELECT r.user_id, count(s.segment_id) FROM pkm_domain_revisions r LEFT JOIN pkm_domain_revision_segments s USING (revision_id) GROUP BY r.user_id"
                    )
                ).all()
            )
            assert counts == {"departing": 300 if rollback else 0, "peer": 300}
    finally:
        with engine.begin() as conn:
            conn.execute(
                text(
                    "DROP TABLE IF EXISTS pkm_domain_revision_segments, pkm_domain_revisions CASCADE"
                )
            )
            conn.execute(text("DROP FUNCTION IF EXISTS slow_erasure()"))
        engine.dispose()
