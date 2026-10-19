"""Real observation SQL, deletion guards, epoch fencing, RLS and migration replay.

CI supplies a disposable PostgreSQL administrator URL. This test creates and
drops its own database because migration201 deliberately governs public DDL.
"""

import os
from concurrent.futures import ThreadPoolExecutor
from contextlib import contextmanager
from pathlib import Path
from uuid import uuid4

import pytest
from sqlalchemy import create_engine, text
from sqlalchemy.engine import make_url
from sqlalchemy.exc import DBAPIError

from hushh_mcp.services import product_activity as activity

pytestmark = pytest.mark.db
ROOT = Path(__file__).resolve().parents[2]


def test_observation_lifecycle_on_disposable_postgres(monkeypatch):
    configured = os.getenv("ONE_COMMAND_TEST_DATABASE_URL")
    if not configured:
        pytest.skip("Canonical disposable PostgreSQL administrator URL is required")
    url = make_url(configured).set(drivername="postgresql+psycopg2")
    database = "plg_observation_test_" + uuid4().hex
    admin = create_engine(url, isolation_level="AUTOCOMMIT")
    with admin.connect() as conn:
        conn.exec_driver_sql(f'CREATE DATABASE "{database}"')
    engine = create_engine(url.set(database=database), pool_size=4)
    migration = (ROOT / "db/migrations/365_one_product_activity_observations.sql").read_text()
    rollback = (
        ROOT / "db/migrations/rollback/365_one_product_activity_observations.rollback.sql"
    ).read_text()
    try:
        with engine.connect().execution_options(isolation_level="AUTOCOMMIT") as conn:
            conn.exec_driver_sql(
                "CREATE TABLE actor_profiles(user_id TEXT PRIMARY KEY); CREATE TABLE vault_keys(user_id TEXT PRIMARY KEY)"
            )
            conn.connection.cursor().execute(
                (ROOT / "db/migrations/201_account_deletion_tombstones.sql").read_text()
            )
            conn.connection.cursor().execute(migration)
            conn.connection.cursor().execute(migration)
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
        with engine.begin() as conn:
            conn.execute(text("DELETE FROM actor_profiles WHERE user_id='owner'"))
        with pytest.raises(DBAPIError):
            activity.admission("owner")
        with engine.connect().execution_options(isolation_level="AUTOCOMMIT") as conn:
            assert (
                conn.exec_driver_sql(
                    "SELECT COUNT(*) FROM one_product_activity_epochs WHERE user_id='owner'"
                ).scalar()
                == 0
            )
            conn.connection.cursor().execute(rollback)
            conn.connection.cursor().execute(migration)
    finally:
        engine.dispose()
        with admin.connect() as conn:
            conn.execute(
                text("SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname=:db"),
                {"db": database},
            )
            conn.exec_driver_sql(f'DROP DATABASE "{database}"')
        admin.dispose()
