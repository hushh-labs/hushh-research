"""Initial Contacts races with real Circle triggers and deletion guards.

Uses only ONE_COMMAND_TEST_DATABASE_URL and a new disposable database, as the
existing deletion-guard suites do: migration 201 owns public catalog guards and
cannot safely be applied to a schema inside a shared database.
"""

from __future__ import annotations

import os
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from threading import Barrier
from types import SimpleNamespace
from uuid import uuid4

import pytest
from sqlalchemy import create_engine, text
from sqlalchemy.engine import make_url

from hushh_mcp.services.one_location_circle_service import OneLocationCircleService

MIGRATIONS = Path(__file__).resolve().parents[2] / "db/migrations"
INITIAL_MIGRATION = "337_initial_contacts_onboarding.sql"
INITIAL_COLUMNS = {
    "initial_contacts_source",
    "initial_contacts_welcome_acknowledged",
    "initial_contacts_circle_id",
}


class _Database:
    def __init__(self, engine):
        self.engine = engine

    def execute_raw(self, sql, params=None):
        with self.engine.begin() as conn:
            result = conn.execute(text(sql), params or {})
            return SimpleNamespace(
                data=[dict(row) for row in result.mappings()] if result.returns_rows else []
            )


def _migration(db, name):
    with db.engine.begin() as conn:
        conn.exec_driver_sql(
            (MIGRATIONS / name).read_text(encoding="utf-8"),
            execution_options={"no_parameters": True},
        )


@pytest.fixture
def db():
    supplied = os.getenv("ONE_COMMAND_TEST_DATABASE_URL")
    if not supplied:
        pytest.skip("An isolated PostgreSQL server is required.")
    url = make_url(supplied).set(drivername="postgresql+psycopg2")
    if (
        url.host not in {"127.0.0.1", "localhost"}
        or url.database != "command_test"
        or url.username != "command_test"
    ):
        pytest.fail("Initial Contacts tests refuse a non-isolated PostgreSQL target")
    name = "initial_contacts_circle_test_" + uuid4().hex
    admin = create_engine(url, isolation_level="AUTOCOMMIT", hide_parameters=True)
    engine = None
    created = False
    try:
        with admin.connect() as conn:
            conn.exec_driver_sql(f'CREATE DATABASE "{name}"')
        created = True
        engine = create_engine(
            url.set(database=name),
            hide_parameters=True,
            connect_args={
                "options": "-cdeadlock_timeout=100ms -clock_timeout=10s -cstatement_timeout=15s"
            },
        )
        database = _Database(engine)
        # Adjacent consumed columns follow the existing Circle PostgreSQL fixture.
        # The Circle graph, chat tables/FKs/triggers and deletion guards below use
        # complete production migrations, without schema rewriting or stubs.
        database.execute_raw("""
            CREATE EXTENSION IF NOT EXISTS pgcrypto;
            CREATE TABLE actor_profiles(user_id TEXT PRIMARY KEY);
            CREATE TABLE actor_identity_cache(user_id TEXT PRIMARY KEY,display_name TEXT,
              email TEXT,custom_photo_url TEXT,photo_url TEXT);
            CREATE TABLE vault_keys(user_id TEXT PRIMARY KEY,setup_completed BOOLEAN,
              vault_status TEXT);
            CREATE TABLE feed_events(id BIGINT PRIMARY KEY,read_at TIMESTAMPTZ);
            CREATE TABLE one_location_share_grants(id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
              owner_user_id TEXT,recipient_user_id TEXT,status TEXT,
              updated_at TIMESTAMPTZ,revoked_at TIMESTAMPTZ);
            CREATE TABLE one_location_events(id UUID DEFAULT gen_random_uuid(),owner_user_id TEXT,
              actor_user_id TEXT,recipient_user_id TEXT,event_type TEXT,metadata JSONB);
            CREATE TABLE connection_scope_proposals(id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
              connection_request_id UUID,status TEXT,expires_at TIMESTAMPTZ,
              resolved_at TIMESTAMPTZ);
            CREATE TABLE connection_scope_proposal_events(id BIGSERIAL PRIMARY KEY,
              connection_scope_proposal_id UUID,event_type TEXT,actor_user_id TEXT,reason TEXT);
            CREATE TABLE trusted_connections(owner_user_id TEXT,trusted_user_id TEXT,
              status TEXT,source TEXT,created_at TIMESTAMPTZ,updated_at TIMESTAMPTZ,
              revoked_at TIMESTAMPTZ,UNIQUE(owner_user_id,trusted_user_id));
        """)
        for migration in (
            "086_connections.sql",
            "116_one_location_sms_contacts.sql",
            "134_one_location_named_circles.sql",
            "135_one_location_circle_connection_origins.sql",
            "136_one_location_circle_member_invites.sql",
            "138_circle_member_connection_origin.sql",
            "158_one_location_circle_member_limit_100.sql",
            "159_one_location_circle_invite_max_uses_100.sql",
            "160_one_location_system_circles.sql",
            "163_one_location_system_circle_kinds.sql",
            "201_account_deletion_tombstones.sql",
            "265_circle_chat.sql",
            "296_circle_chat_reactions_events.sql",
            INITIAL_MIGRATION,
        ):
            _migration(database, migration)
        # A missing trigger/FK would make a passing race misleading.
        assert database.execute_raw("""
            SELECT 1 FROM pg_trigger
            WHERE tgrelid='one_location_circle_memberships'::regclass
              AND tgname='circle_chat_membership_event' AND NOT tgisinternal
        """).data
        assert database.execute_raw("""
            SELECT 1 FROM pg_constraint constraint_row
            JOIN pg_attribute column_row ON column_row.attrelid=constraint_row.conrelid
              AND column_row.attnum=ANY(constraint_row.conkey)
            WHERE constraint_row.contype='f'
              AND constraint_row.conrelid='circle_chat_membership_events'::regclass
              AND constraint_row.confrelid='actor_profiles'::regclass
              AND column_row.attname='actor_user_id'
        """).data
        guarded = database.execute_raw("""
            SELECT DISTINCT table_row.relname FROM pg_trigger trigger_row
            JOIN pg_class table_row ON table_row.oid=trigger_row.tgrelid
            JOIN pg_proc function_row ON function_row.oid=trigger_row.tgfoid
            WHERE function_row.proname='reject_deleted_account_identity_write'
        """).data
        assert {"one_location_circle_memberships", "circle_chat_membership_events"} <= {
            row["relname"] for row in guarded
        }
        yield database
    finally:
        if engine is not None:
            engine.dispose()
        if created:
            with admin.connect() as conn:
                conn.exec_driver_sql(f'DROP DATABASE "{name}" WITH (FORCE)')
        admin.dispose()


def _pair(db, label):
    a, b = f"a_{label}", f"b_{label}"
    db.execute_raw("INSERT INTO actor_profiles VALUES(:a),(:b)", {"a": a, "b": b})
    db.execute_raw(
        "INSERT INTO actor_identity_cache(user_id,display_name) VALUES(:a,:a),(:b,:b)",
        {"a": a, "b": b},
    )
    db.execute_raw(
        """
        INSERT INTO vault_keys(user_id,setup_completed,vault_status,initial_contacts_source,
          initial_contacts_welcome_acknowledged)
        VALUES(:a,true,'active','google',false),(:b,true,'active','google',false)
    """,
        {"a": a, "b": b},
    )
    service = OneLocationCircleService(db=db, hmac_key="synthetic-initial-contacts-proof")
    with db.engine.begin() as conn:
        circles = {
            owner: service.create_circle_in_transaction(
                conn, owner_user_id=owner, name="Contacts", kind="other"
            )
            for owner in (a, b)
        }
        for owner, circle in circles.items():
            conn.execute(
                text("""
                UPDATE vault_keys SET initial_contacts_circle_id=CAST(:circle AS UUID)
                WHERE user_id=:owner
            """),
                {"circle": circle, "owner": owner},
            )
        connection = conn.execute(
            text("""
            INSERT INTO connections(user_a_id,user_b_id,status,source)
            VALUES(:a,:b,'active','request') RETURNING id
        """),
            {"a": a, "b": b},
        ).scalar_one()
        conn.execute(
            text("""
            INSERT INTO connection_origins(connection_id,origin_kind,origin_key)
            VALUES(:id,'direct_request','direct_request')
        """),
            {"id": connection},
        )
    return a, b, circles


class _RacingService(OneLocationCircleService):
    def __init__(self, db, *, old_lock=False):
        super().__init__(db=db, hmac_key="synthetic-initial-contacts-proof")
        self._profile_barrier = Barrier(2)
        self._old_lock = old_lock

    def _lock_invitees(self, conn, *, user_ids):
        if self._old_lock:
            # Local negative control only; production helpers remain untouched.
            conn.execute(
                text("""
                SELECT user_id FROM actor_profiles
                WHERE user_id=ANY(CAST(:users AS TEXT[])) ORDER BY user_id FOR UPDATE
            """),
                {"users": sorted(user_ids)},
            ).all()
        else:
            super()._lock_invitees(conn, user_ids=user_ids)
        # Both distinct target locks precede either transaction's connection AB
        # lock. Its winner must acquire the other owner's FK KEY SHARE via 296.
        self._profile_barrier.wait(timeout=10)


def _sqlstate(error):
    visited = set()
    while error is not None and id(error) not in visited:
        visited.add(id(error))
        state = getattr(getattr(error, "orig", error), "pgcode", None)
        if state:
            return state
        error = error.__cause__ or error.__context__
    return None


def _race(db, label, *, signup_flags=(True, True), old_lock=False):
    a, b, circles = _pair(db, label)
    service = _RacingService(db, old_lock=old_lock)

    def add(owner, target, signup):
        try:
            result = service.create_member_invites(
                actor_user_id=owner,
                circle_id=circles[owner],
                invitee_user_ids=[target],
                signup_insert_only=signup,
                _emit_notifications=False,
            )
            return {"added": result["addedUserIds"]}
        except Exception as error:
            return {"sqlstate": _sqlstate(error), "type": type(error).__name__}

    with ThreadPoolExecutor(max_workers=2) as pool:
        futures = [
            pool.submit(add, a, b, signup_flags[0]),
            pool.submit(add, b, a, signup_flags[1]),
        ]
        results = [future.result(timeout=20) for future in futures]
    return a, b, circles, results


def test_old_profile_lock_reproduces_the_chat_actor_foreign_key_deadlock(db):
    a, b, _circles, results = _race(db, "negative", old_lock=True)
    assert sum("added" in result for result in results) == 1, results
    assert any(result.get("sqlstate") == "40P01" for result in results), results
    assert any(result.get("added") in ([a], [b]) for result in results), results


@pytest.mark.parametrize("signup_flags", [(True, True), (True, False), (False, True)])
def test_reciprocal_signup_and_explicit_fills_complete_with_real_chat_actor_fk(db, signup_flags):
    for repetition in range(3):
        a, b, circles, results = _race(db, f"race_{repetition}", signup_flags=signup_flags)
        assert {tuple(result.get("added", [])) for result in results} == {(a,), (b,)}, results
        for circle in circles.values():
            members = db.execute_raw(
                """
                SELECT user_id FROM one_location_circle_memberships
                WHERE circle_id=CAST(:circle AS UUID) AND status='active'
            """,
                {"circle": circle},
            ).data
            assert {row["user_id"] for row in members} == {a, b}
        events = db.execute_raw(
            """
            SELECT subject_user_id,actor_user_id FROM circle_chat_membership_events
            WHERE circle_id=ANY(CAST(:circles AS UUID[])) AND subject_user_id<>actor_user_id
        """,
            {"circles": list(circles.values())},
        ).data
        assert {(row["subject_user_id"], row["actor_user_id"]) for row in events} == {
            (a, b),
            (b, a),
        }


def test_initial_contacts_migration_replays_and_rollback_preserves_shared_circles(db):
    _a, _b, circles = _pair(db, "migration")
    _migration(db, INITIAL_MIGRATION)
    before = db.execute_raw(
        "SELECT circle_id,user_id,status FROM one_location_circle_memberships"
    ).data
    _migration(db, "rollback/337_initial_contacts_onboarding.rollback.sql")

    def columns():
        rows = db.execute_raw("""
            SELECT column_name FROM information_schema.columns
            WHERE table_schema='public' AND table_name='vault_keys'
        """).data
        return {row["column_name"] for row in rows}

    assert INITIAL_COLUMNS.isdisjoint(columns())
    assert (
        db.execute_raw("SELECT circle_id,user_id,status FROM one_location_circle_memberships").data
        == before
    )
    assert {
        str(row["id"]) for row in db.execute_raw("SELECT id FROM one_location_circles").data
    } == set(circles.values())
    _migration(db, INITIAL_MIGRATION)
    _migration(db, INITIAL_MIGRATION)
    assert INITIAL_COLUMNS <= columns()
    assert all(
        all(row[column] is None for column in INITIAL_COLUMNS)
        for row in db.execute_raw("SELECT * FROM vault_keys").data
    )
