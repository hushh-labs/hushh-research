"""Real observation SQL, deletion guards, epoch fencing, RLS and migration replay.

CI supplies a disposable PostgreSQL administrator URL. This test creates and
drops its own database because migration201 deliberately governs public DDL.
"""

import os
from concurrent.futures import ThreadPoolExecutor
from contextlib import contextmanager
from datetime import datetime, timedelta, timezone
from pathlib import Path
from uuid import uuid4

import pytest
from sqlalchemy import create_engine, text
from sqlalchemy.engine import make_url
from sqlalchemy.exc import DBAPIError

from hushh_mcp.services import product_activity as activity
from hushh_mcp.services.plg_audience import ATTEMPTS_SQL, summarize_attempts

pytestmark = pytest.mark.db
ROOT = Path(__file__).resolve().parents[2]


def test_observation_lifecycle_on_disposable_postgres(monkeypatch):
    configured = os.getenv("ONE_COMMAND_TEST_DATABASE_URL")
    if not configured:
        pytest.skip("Canonical disposable PostgreSQL administrator URL is required")
    url = make_url(configured).set(drivername="postgresql+psycopg2")
    database = "plg_observation_test_" + uuid4().hex
    browser_role = "plg_observation_role_" + uuid4().hex
    admin = create_engine(url, isolation_level="AUTOCOMMIT")
    with admin.connect() as conn:
        conn.exec_driver_sql(f'CREATE DATABASE "{database}"')
    engine = create_engine(url.set(database=database), pool_size=4)
    migration = (ROOT / "db/migrations/365_one_product_activity_observations.sql").read_text()
    correlation = (ROOT / "db/migrations/366_one_product_activity_correlation.sql").read_text()
    correlation_rollback = (
        ROOT / "db/migrations/rollback/366_one_product_activity_correlation.rollback.sql"
    ).read_text()
    rollback = (
        ROOT / "db/migrations/rollback/365_one_product_activity_observations.rollback.sql"
    ).read_text()
    try:
        with engine.connect().execution_options(isolation_level="AUTOCOMMIT") as conn:
            conn.exec_driver_sql(f'CREATE ROLE "{browser_role}" NOLOGIN NOBYPASSRLS')
            conn.exec_driver_sql(
                "CREATE TABLE actor_profiles(user_id TEXT PRIMARY KEY); CREATE TABLE vault_keys(user_id TEXT PRIMARY KEY)"
            )
            conn.connection.cursor().execute(
                (ROOT / "db/migrations/201_account_deletion_tombstones.sql").read_text()
            )
            conn.connection.cursor().execute(migration)
            conn.connection.cursor().execute(migration)
            conn.connection.cursor().execute(correlation)
            conn.connection.cursor().execute(correlation)
            conn.exec_driver_sql("INSERT INTO actor_profiles VALUES ('owner'),('other')")

        @contextmanager
        def connection():
            with engine.begin() as conn:
                yield conn

        monkeypatch.setattr(activity, "get_db_connection", connection)
        monkeypatch.setattr(activity, "enabled_for", lambda uid: uid in {"owner", "other"})
        generation = activity.admission("owner")["generation"]
        action = "observation:one_memory_action:detail_edited"
        assert activity.observe(
            "owner", generation, action, "returned", "client_reported", "operation"
        )
        assert not activity.observe(
            "owner", generation, action, "returned", "client_reported", "operation"
        )
        assert not activity.observe(
            "other", generation, action, "returned", "client_reported", "operation"
        )
        monkeypatch.setattr(activity, "DAILY_LIMIT", 2)
        with ThreadPoolExecutor(max_workers=2) as workers:
            admitted = list(
                workers.map(
                    lambda i: activity.observe(
                        "owner", generation, action, "returned", "client_reported", str(i)
                    ),
                    range(2),
                )
            )
        assert admitted.count(True) == 1
        with engine.begin() as conn:
            assert (
                conn.execute(
                    text("SELECT COUNT(*) FROM one_product_activity_observations")
                ).scalar()
                == 2
            )
            # AccountService rotates this epoch under its existing reset barrier.
            conn.execute(
                text(
                    "UPDATE one_product_activity_epochs SET generation=gen_random_uuid(),started_at=NOW() WHERE user_id='owner'"
                )
            )
            conn.execute(
                text("DELETE FROM one_product_activity_observations WHERE user_id='owner'")
            )
        assert not activity.observe(
            "owner", generation, action, "returned", "client_reported", "late-old-run"
        )
        current = activity.admission("owner")["generation"]
        assert current != generation
        assert activity.observe("owner", current, action, "returned", "client_reported", "new-run")
        with engine.begin() as conn:
            assert not conn.execute(
                text(
                    "SELECT has_table_privilege(:role,'one_product_activity_observations','SELECT')"
                ),
                {"role": browser_role},
            ).scalar()
            conn.exec_driver_sql(
                f'GRANT SELECT ON one_product_activity_observations TO "{browser_role}"'
            )
            assert (
                conn.exec_driver_sql(
                    "SELECT COUNT(*) FROM one_product_activity_observations"
                ).scalar()
                == 1
            )
            conn.exec_driver_sql(f'SET LOCAL ROLE "{browser_role}"')
            # Even an accidental table grant cannot bypass service-only RLS.
            assert (
                conn.exec_driver_sql(
                    "SELECT COUNT(*) FROM one_product_activity_observations"
                ).scalar()
                == 0
            )
        with engine.begin() as conn:
            conn.execute(
                text(
                    "UPDATE one_product_activity_observations SET expires_at=NOW()-INTERVAL '1 second'"
                )
            )
            roles = (
                conn.execute(
                    text("SELECT rolname FROM pg_roles WHERE rolname IN ('anon','authenticated')")
                )
                .scalars()
                .all()
            )
            for role in roles:
                assert not conn.execute(
                    text(
                        "SELECT has_table_privilege(:role,'one_product_activity_observations','SELECT')"
                    ),
                    {"role": role},
                ).scalar()
            assert conn.execute(
                text(
                    "SELECT relrowsecurity FROM pg_class WHERE oid='one_product_activity_observations'::regclass"
                )
            ).scalar()
        assert activity.purge_expired() == 1
        # Different invocations cannot cancel each other's missing terminal.
        monkeypatch.setattr(activity, "DAILY_LIMIT", 500)
        other_generation = activity.admission("other")["generation"]
        for phase, operation in (("started", "call-a"), ("returned", "call-b")):
            assert activity.observe(
                "other", other_generation, "agent:agent_one", phase, "execution_observed", operation
            )
        with engine.begin() as conn:
            keys = (
                conn.execute(
                    text(
                        "SELECT operation_key FROM one_product_activity_observations WHERE user_id='other'"
                    )
                )
                .scalars()
                .all()
            )
            assert len(set(keys)) == 2

        def projected():
            at = datetime.now(timezone.utc)
            # Execute the actual production query with SQLAlchemy's binding
            # spelling; this suite owns a real disposable PostgreSQL database.
            sql = ATTEMPTS_SQL
            for position, name in ((1, "ids"), (2, "agent"), (3, "since"), (4, "at")):
                sql = sql.replace(f"${position}", f":{name}")
            sql = sql.replace(":ids::text[]", "CAST(:ids AS text[])")
            with engine.begin() as conn:
                rows = (
                    conn.execute(
                        text(sql),
                        {
                            "ids": ["other"],
                            "agent": "agent_one",
                            "since": at - timedelta(days=7),
                            "at": at,
                        },
                    )
                    .mappings()
                    .all()
                )
            return summarize_attempts(
                rows,
                agent_id="agent_one",
                now=at + timedelta(hours=2),
                grace=60,
                epoch={"started_at": at - timedelta(hours=3)},
                limited=False,
                enabled=True,
            )

        before = projected()
        assert before["counts"]["possibleIncomplete"] == 1
        assert before["counts"]["returned"] == 1
        assert activity.observe(
            "other", other_generation, "agent:agent_one", "returned", "execution_observed", "call-a"
        )
        with engine.begin() as conn:
            keys = conn.execute(
                text(
                    "SELECT operation_key,COUNT(*) FROM one_product_activity_observations WHERE user_id='other' GROUP BY operation_key"
                )
            ).all()
            assert sorted(row[1] for row in keys) == [1, 2]
        after = projected()
        assert after["counts"]["possibleIncomplete"] == 0
        assert after["counts"]["returned"] == 2
        # A start receipt arriving last must not replace a terminal's timestamp.
        late_start = datetime.now(timezone.utc) - timedelta(minutes=1)
        terminal_at = late_start - timedelta(minutes=2)
        with engine.begin() as conn:
            conn.execute(
                text(
                    "UPDATE one_product_activity_observations SET observed_at="
                    "CASE WHEN phase='started' THEN :late_start ELSE :terminal_at END "
                    "WHERE user_id='other'"
                ),
                {"late_start": late_start, "terminal_at": terminal_at},
            )
        reordered = projected()
        assert reordered["lastObservedAt"] == late_start.isoformat()
        assert reordered["lastReturnedAt"] == terminal_at.isoformat()
        assert reordered["counts"]["returned"] == 2
        assert reordered["counts"]["possibleIncomplete"] == 0
        # Rolling back/replaying correlation never fabricates pairs for retained events.
        with engine.connect().execution_options(isolation_level="AUTOCOMMIT") as conn:
            conn.connection.cursor().execute(correlation_rollback)
            conn.connection.cursor().execute(correlation)
            assert (
                conn.exec_driver_sql(
                    "SELECT COUNT(*) FROM one_product_activity_observations WHERE operation_key IS NOT NULL"
                ).scalar()
                == 0
            )
        legacy = projected()
        assert legacy["counts"]["uncorrelated"] == 3
        assert legacy["counts"]["possibleIncomplete"] == 0
        # Anonymous auth spines cannot enter expanded registered collection.
        with engine.begin() as conn:
            conn.exec_driver_sql(
                "CREATE TABLE actor_identity_cache(user_id TEXT PRIMARY KEY,email TEXT,phone_number TEXT,phone_verified BOOLEAN)"
            )
            conn.exec_driver_sql(
                "INSERT INTO actor_identity_cache VALUES ('other',NULL,NULL,FALSE)"
            )
        monkeypatch.setenv("ONE_PLG_ACTIVITY_ALL_REGISTERED", "true")
        assert activity.admission("other") is None
        assert not activity.observe(
            "other",
            other_generation,
            "agent:agent_one",
            "started",
            "execution_observed",
            "anonymous",
        )
        with engine.begin() as conn:
            conn.exec_driver_sql(
                "UPDATE actor_identity_cache SET phone_number='+919876543210',phone_verified=TRUE WHERE user_id='other'"
            )
        assert activity.admission("other") is not None
        monkeypatch.delenv("ONE_PLG_ACTIVITY_ALL_REGISTERED")
        with engine.begin() as conn:
            conn.execute(text("DELETE FROM actor_profiles WHERE user_id='owner'"))
        with pytest.raises(DBAPIError) as rejected:
            activity.admission("owner")
        assert rejected.value.orig.pgcode == "23514"
        assert rejected.value.orig.diag.constraint_name == "account_deletion_tombstone_guard"
        with engine.connect().execution_options(isolation_level="AUTOCOMMIT") as conn:
            assert (
                conn.exec_driver_sql(
                    "SELECT COUNT(*) FROM one_product_activity_epochs WHERE user_id='owner'"
                ).scalar()
                == 0
            )
            conn.connection.cursor().execute(rollback)
            conn.connection.cursor().execute(migration)
            conn.connection.cursor().execute(correlation)
    finally:
        engine.dispose()
        with admin.connect() as conn:
            conn.execute(
                text("SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname=:db"),
                {"db": database},
            )
            conn.exec_driver_sql(f'DROP DATABASE "{database}"')
            conn.exec_driver_sql(f'DROP ROLE IF EXISTS "{browser_role}"')
        admin.dispose()
