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
pytestmark = [pytest.mark.feature_account_deletion, pytest.mark.trace_loop]


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


def _seed_erasure_spine(conn):
    from sqlalchemy import text

    conn.execute(
        text(
            "CREATE TABLE actor_profiles (user_id TEXT PRIMARY KEY, personas TEXT[] DEFAULT ARRAY['investor'], last_active_persona TEXT DEFAULT 'investor', investor_marketplace_opt_in BOOLEAN DEFAULT false)"
        )
    )
    conn.execute(text("CREATE TABLE vault_keys (user_id TEXT PRIMARY KEY)"))
    for table in (
        "pkm_events",
        "pkm_scope_registry",
        "pkm_manifest_paths",
        "pkm_manifests",
        "pkm_blobs",
        "pkm_index",
        "consent_audit",
    ):
        conn.execute(text(f"CREATE TABLE {table} (user_id TEXT NOT NULL)"))
    conn.execute(
        text(
            "CREATE TABLE ria_client_invites (target_investor_user_id TEXT, accepted_by_user_id TEXT)"
        )
    )
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
            "INSERT INTO pkm_domain_revisions SELECT md5(owner || n)::uuid, owner FROM (VALUES ('departing'), ('peer')) owners(owner) CROSS JOIN generate_series(1,300) n"
        )
    )
    conn.execute(
        text(
            "INSERT INTO pkm_domain_revision_segments SELECT revision_id, 'base', repeat('synthetic-ciphertext', 1024) FROM pkm_domain_revisions"
        )
    )
    # More than one batch within the same parent guards cursor safety.
    conn.execute(
        text(
            "INSERT INTO pkm_domain_revision_segments SELECT revision_id, n::TEXT, 'synthetic-ciphertext' FROM pkm_domain_revisions CROSS JOIN generate_series(1,201) n WHERE revision_id=md5(user_id || '1')::uuid"
        )
    )
    # Segmentless parents must not terminate erasure before later populated ones.
    conn.execute(
        text(
            "INSERT INTO pkm_domain_revisions SELECT md5(owner || n)::uuid, owner FROM (VALUES ('departing'), ('peer')) owners(owner) CROSS JOIN generate_series(301,310) n"
        )
    )
    conn.execute(text("INSERT INTO actor_profiles(user_id) VALUES ('departing'), ('peer')"))
    conn.execute(text("INSERT INTO vault_keys VALUES ('departing'), ('peer')"))
    conn.execute(text((ROOT / "db/migrations/201_account_deletion_tombstones.sql").read_text()))


def _slow_erasure_boundaries(conn, rollback):
    from sqlalchemy import text

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
    conn.execute(
        text(
            "CREATE TRIGGER slow_revision_erasure BEFORE DELETE ON pkm_domain_revisions FOR EACH ROW EXECUTE FUNCTION slow_erasure()"
        )
    )
    if rollback:
        conn.execute(
            text(
                "CREATE FUNCTION fail_final_erasure() RETURNS TRIGGER LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'synthetic final erasure failure'; END $$"
            )
        )
        conn.execute(
            text(
                "CREATE TRIGGER fail_final_erasure BEFORE DELETE ON vault_keys FOR EACH ROW EXECUTE FUNCTION fail_final_erasure()"
            )
        )


def _request_full_erasure(engine, trace_id, rollback):
    from fastapi import FastAPI
    from fastapi.testclient import TestClient
    from sqlalchemy import text

    import api.routes.account as route
    from api.middleware import require_vault_owner_token
    from api.middlewares.observability import observability_middleware

    released = AsyncMock(return_value={"status": "released"})
    app = FastAPI()
    app.middleware("http")(observability_middleware)
    app.include_router(route.router)
    # Isolate the external identity port; all erasure services and SQL stay real.
    app.dependency_overrides[require_vault_owner_token] = lambda: {"user_id": "departing"}
    with (
        patch.object(account, "get_db_connection", engine.begin),
        patch.object(lifecycle, "get_db_connection", engine.begin),
        patch.object(
            account,
            "_ACCOUNT_ERASURE_SQL_LIMITS",
            text("SET LOCAL lock_timeout='300ms'; SET LOCAL statement_timeout='700ms'"),
        ),
        patch.object(account, "release_provider_grants_after_erasure", released),
        patch.object(route, "_delete_firebase_auth_user", AsyncMock(return_value="deleted")),
        TestClient(app) as client,
    ):
        started = monotonic()
        response = client.request(
            "DELETE",
            "/api/account/delete",
            json={"target": "both"},
            headers={"X-Request-Id": trace_id},
        )
        assert monotonic() - started < 12
        assert response.headers["x-request-id"] == trace_id
        assert response.headers["x-trace-id"] == trace_id
        assert response.status_code == (500 if rollback else 200), response.text
        if rollback:
            assert response.json()["code"] == "ACCOUNT_DELETION_FAILED"
            released.assert_not_awaited()
        else:
            assert response.json()["account_deleted"] is True
            released.assert_awaited_once()
        assert lifecycle.AccountDeletionLifecycleService.is_tombstoned("departing") is (
            not rollback
        )


def _assert_recovery_counts(engine, rollback):
    from sqlalchemy import text

    with engine.connect() as conn:
        counts = dict(
            conn.execute(
                text(
                    "SELECT r.user_id, count(s.segment_id) FROM pkm_domain_revisions r LEFT JOIN pkm_domain_revision_segments s USING (revision_id) GROUP BY r.user_id"
                )
            ).all()
        )
        assert counts == ({"departing": 501, "peer": 501} if rollback else {"peer": 501})
        assert conn.execute(
            text("SELECT count(*) FROM pkm_domain_revisions WHERE user_id='departing'")
        ).scalar() == (310 if rollback else 0)
        assert (
            conn.execute(
                text("SELECT count(*) FROM pkm_domain_revisions WHERE user_id='peer'")
            ).scalar()
            == 310
        )
        assert conn.execute(
            text("SELECT count(*) FROM vault_keys WHERE user_id='departing'")
        ).scalar() == (1 if rollback else 0)


@pytest.mark.parametrize("rollback", [False, True], ids=["commit", "rollback"])
def test_large_recovery_history_erasure_is_bounded_atomic_and_owner_scoped(database_url, rollback):
    """HTTP -> real account transaction -> both recovery tables -> commit/rollback."""
    from sqlalchemy import event, text
    from sqlalchemy.engine import make_url

    from api.middlewares.observability import get_request_id

    database = "erasure_rollback" if rollback else "erasure_commit"
    admin = create_engine(database_url, isolation_level="AUTOCOMMIT")
    with admin.connect() as conn:
        conn.execute(text(f"CREATE DATABASE {database}"))
    engine = create_engine(make_url(database_url).set(database=database))
    trace_id = f"account-deletion-loop-{database}"
    sql_trace: list[tuple[str, str]] = []

    def trace_query(_conn, _cursor, statement, _parameters, _context, _many):
        if "DELETE FROM pkm_domain_revision_segments" in statement:
            sql_trace.append(("segments", get_request_id()))
        elif "DELETE FROM pkm_domain_revisions" in statement:
            sql_trace.append(("revisions", get_request_id()))

    event.listen(engine, "before_cursor_execute", trace_query)
    try:
        with engine.begin() as conn:
            _seed_erasure_spine(conn)
            _slow_erasure_boundaries(conn, rollback)
        _request_full_erasure(engine, trace_id, rollback)
        assert {name for name, _ in sql_trace} == {"segments", "revisions"}
        assert all(request_id == trace_id for _, request_id in sql_trace)
        _assert_recovery_counts(engine, rollback)
    finally:
        engine.dispose()
        with admin.connect() as conn:
            conn.execute(text(f"DROP DATABASE {database} WITH (FORCE)"))
        admin.dispose()


def test_late_recovery_cursor_bounds_parent_scan_work(database_url):
    """A child cursor must not revisit the already traversed parent prefix."""
    from sqlalchemy import text

    from hushh_mcp.services.account_recovery_erasure import recovery_erasure_queries

    engine = create_engine(database_url)
    try:
        with engine.connect() as conn, conn.begin() as transaction:
            # Disposable temporary tables shadow runtime names only here. ANALYZE
            # executes the production DELETE; the transaction rolls back on exit.
            conn.execute(
                text(
                    "CREATE TEMP TABLE pkm_domain_revisions (revision_id UUID PRIMARY KEY, user_id TEXT NOT NULL) ON COMMIT DROP"
                )
            )
            conn.execute(
                text(
                    "CREATE TEMP TABLE pkm_domain_revision_segments (revision_id UUID REFERENCES pkm_domain_revisions, segment_id TEXT, PRIMARY KEY (revision_id, segment_id)) ON COMMIT DROP"
                )
            )
            conn.execute(
                text(
                    "INSERT INTO pkm_domain_revisions SELECT lpad(to_hex(n),32,'0')::uuid, 'departing' FROM generate_series(1,3000) n"
                )
            )
            conn.execute(
                text(
                    "INSERT INTO pkm_domain_revision_segments SELECT revision_id, 'base' FROM pkm_domain_revisions"
                )
            )
            conn.execute(text("ANALYZE pkm_domain_revisions; ANALYZE pkm_domain_revision_segments"))
            query = recovery_erasure_queries()["pkm_domain_revision_segments"]
            plan = conn.execute(
                text("EXPLAIN (ANALYZE, TIMING OFF, FORMAT JSON) " + str(query)),
                {
                    "user_id": "departing",
                    "after_revision_id": f"{2800:032x}",
                    "after_segment_id": "base",
                },
            ).scalar()[0]["Plan"]
            assert plan["Actual Rows"] == 100
            assert _parent_scan_work(plan) < 500, "late batches rescanned the erased parent prefix"
            assert (
                conn.execute(text("SELECT count(*) FROM pkm_domain_revision_segments")).scalar()
                == 2900
            )
            transaction.rollback()
    finally:
        engine.dispose()


def _parent_scan_work(plan):
    own_work = 0
    if plan.get("Relation Name") == "pkm_domain_revisions":
        own_work = (plan["Actual Rows"] + plan.get("Rows Removed by Filter", 0)) * plan[
            "Actual Loops"
        ]
    return own_work + sum(_parent_scan_work(child) for child in plan.get("Plans", []))
