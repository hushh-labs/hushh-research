"""Blocked erasure rolls back on real, disposable PostgreSQL."""

from __future__ import annotations

import asyncio
import os
from pathlib import Path
from unittest.mock import patch

import pytest

from tests.pkm_conformance import postgres_harness

ROOT = Path(__file__).resolve().parents[1]


@pytest.fixture(scope="module")
def database_url():
    explicit = os.getenv("ACCOUNT_DELETION_POSTGRES_URL")
    if explicit and os.getenv("RUN_ACCOUNT_DELETION_POSTGRES_REHEARSAL") == "1":
        yield explicit
        return
    if postgres_harness.find_pg_bin() is None:
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
    from time import monotonic
    from unittest.mock import AsyncMock, patch

    from sqlalchemy import create_engine

    from hushh_mcp.services import account_deletion_lifecycle_service as lifecycle
    from hushh_mcp.services import account_service as account
    from hushh_mcp.services.account_deletion_provider_cleanup import ProviderCredentialSnapshot

    uid = "synthetic_blocked_erasure"
    await deletion_conn.execute("CREATE TABLE one_adk_sessions (user_id TEXT PRIMARY KEY)")
    await deletion_conn.execute("INSERT INTO actor_profiles(user_id) VALUES($1)", uid)
    await deletion_conn.execute("INSERT INTO one_adk_sessions(user_id) VALUES($1)", uid)
    holder = writer_conn.transaction()
    await holder.start()
    engine = create_engine(database_url)
    release = AsyncMock()
    service = account.AccountService()

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
            result = await asyncio.wait_for(
                service._settle_full_account_transaction(uid, requested_target="both"),
                timeout=6,
            )
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
        engine.dispose()
