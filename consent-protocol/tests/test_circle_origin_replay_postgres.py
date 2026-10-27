"""Real migration replay across retained erased identities and live Circle edges."""

from dataclasses import replace

import pytest
from psycopg2.errors import CheckViolation

from db.migration_authority import MigrationAuthorityError, _replay_sql, build_manifest_entries
from tests.pkm_conformance.postgres_harness import find_pg_bin
from tests.test_migrations_are_replay_safe import MIGRATIONS_DIR
from tests.test_migrations_are_replay_safe import replay_pg as replay_pg


def _circle(pg, label, owner, first, second, *, kind=None, second_status="active"):
    for uid in (owner, first, second):
        pg.execute("INSERT INTO actor_profiles VALUES(%s) ON CONFLICT DO NOTHING", (uid,))
    circle_id = pg.execute(
        "INSERT INTO one_location_circles(owner_user_id,name) VALUES(%s,%s) RETURNING id",
        (owner, label),
    )[0][0]
    if kind:
        pg.execute("UPDATE one_location_circles SET system_kind=%s WHERE id=%s", (kind, circle_id))
    for uid, status in ((first, "active"), (second, second_status)):
        pg.execute(
            "INSERT INTO one_location_circle_memberships(circle_id,user_id,status) VALUES(%s,%s,%s)",
            (circle_id, uid, status),
        )
    return circle_id


def _install_fresh_graph(pg):
    pg.execute("""
        CREATE EXTENSION IF NOT EXISTS pgcrypto;
        CREATE TABLE actor_profiles(user_id TEXT PRIMARY KEY);
        CREATE TABLE IF NOT EXISTS vault_keys(user_id TEXT PRIMARY KEY);
        CREATE TABLE trusted_connections(owner_user_id TEXT,trusted_user_id TEXT,source TEXT);
        CREATE TABLE one_location_share_grants(id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          status TEXT);
    """)
    for filename in ("086_connections.sql", "134_one_location_named_circles.sql"):
        pg.apply_file(MIGRATIONS_DIR / filename)
    entry = build_manifest_entries(
        MIGRATIONS_DIR, ["135_one_location_circle_connection_origins.sql"]
    )[0]
    # Fresh 135 precedes both tombstones and system_kind. Replay its positive
    # backfill twice through the production dispatcher, without a helper stub.
    _circle(pg, "fresh", "owner-live", "a-fresh", "z-fresh")
    pg.execute(_replay_sql(entry))
    pg.execute(_replay_sql(entry))
    assert pg.execute("SELECT user_a_id,user_b_id,status FROM connections") == [
        ("a-fresh", "z-fresh", "active")
    ]
    for filename in (
        "160_one_location_system_circles.sql",
        "163_one_location_system_circle_kinds.sql",
    ):
        pg.apply_file(MIGRATIONS_DIR / filename)
    return entry


def _seed_retained_graph(pg):
    _circle(pg, "deleted-first", "owner-live", "a-deleted", "z-live")
    _circle(pg, "deleted-second", "owner-live", "a-live", "z-deleted")
    erased_owner = _circle(pg, "deleted-owner", "owner-deleted", "a-orphan", "z-orphan")
    active_orphan = _circle(
        pg, "deleted-owner-active", "owner-deleted", "a-orphan-active", "z-orphan-active"
    )
    direct_circle = _circle(pg, "independent-direct", "owner-deleted", "a-direct", "z-direct")
    _circle(pg, "curated", "owner-live", "a-curated", "z-curated")
    _circle(pg, "trusted", "owner-live", "a-trusted", "z-trusted", kind="trusted")
    _circle(pg, "sms", "owner-live", "a-sms", "z-sms", kind="sms")
    _circle(pg, "left", "owner-live", "a-left", "z-left", second_status="left")
    for first, second, source_circle in (
        ("a-orphan", "z-orphan", erased_owner),
        ("a-orphan-active", "z-orphan-active", active_orphan),
        ("a-direct", "z-direct", direct_circle),
    ):
        connection_id = pg.execute(
            "INSERT INTO connections(user_a_id,user_b_id,status,source,revoked_at) "
            "VALUES(%s,%s,'revoked','named_circle',now()) RETURNING id",
            (first, second),
        )[0][0]
        pg.execute(
            "INSERT INTO connection_origins(connection_id,origin_kind,origin_key,source_circle_id) "
            "VALUES(%s,'named_circle','named_circle:'||%s::text,%s)",
            (connection_id, source_circle, source_circle),
        )
        if first == "a-orphan-active":
            pg.execute(
                "UPDATE connections SET status='active',revoked_at=NULL WHERE id=%s",
                (connection_id,),
            )
        if first == "a-direct":
            pg.execute(
                "INSERT INTO connection_origins(connection_id,origin_kind,origin_key) "
                "VALUES(%s,'direct_request','direct_request')",
                (connection_id,),
            )
    pg.execute("""
        INSERT INTO connections(user_a_id,user_b_id,source)
          VALUES('a-deleted','z-legacy','request');
        INSERT INTO connection_requests(requester_user_id,addressee_user_id) VALUES
          ('a-deleted','z-legacy'),('a-deleted','z-live'),('a-live','z-deleted'),
          ('a-orphan','z-orphan'),('a-orphan-active','z-orphan-active'),
          ('a-direct','z-direct'),('a-curated','z-curated'),
          ('a-trusted','z-trusted'),('a-left','z-left'),('a-sms','z-sms');
    """)


def _assert_retained_graph(pg):
    assert pg.execute(
        "SELECT user_a_id,user_b_id,status,source FROM connections ORDER BY user_a_id"
    ) == [
        ("a-curated", "z-curated", "active", "named_circle"),
        ("a-deleted", "z-legacy", "active", "request"),
        ("a-direct", "z-direct", "active", "request"),
        ("a-fresh", "z-fresh", "active", "named_circle"),
        ("a-orphan", "z-orphan", "revoked", "named_circle"),
        ("a-orphan-active", "z-orphan-active", "active", "named_circle"),
        ("a-sms", "z-sms", "active", "named_circle"),
    ]
    assert pg.execute("""
        SELECT requester_user_id,status FROM connection_requests ORDER BY requester_user_id,addressee_user_id
    """) == [
        ("a-curated", "cancelled"),
        ("a-deleted", "pending"),
        ("a-deleted", "pending"),
        ("a-direct", "cancelled"),
        ("a-left", "pending"),
        ("a-live", "pending"),
        ("a-orphan", "pending"),
        ("a-orphan-active", "pending"),
        ("a-sms", "cancelled"),
        ("a-trusted", "pending"),
    ]
    assert pg.execute("""
        SELECT count(*) FROM connection_origins origin JOIN connections connection
          ON connection.id=origin.connection_id WHERE connection.user_a_id='a-deleted'
    """) == [(0,)]
    assert pg.execute("SELECT count(*) FROM account_deletion_tombstones") == [(3,)]
    assert pg.execute("SELECT count(*) FROM trusted_connections") == [(0,)]
    assert pg.execute("SELECT count(*) FROM one_location_share_grants") == [(0,)]


@pytest.mark.skipif(find_pg_bin() is None, reason="local PostgreSQL unavailable")
def test_circle_origin_replay_preserves_deleted_identities_and_live_provenance(replay_pg):
    """The original body fails, while two adapted replays preserve valid edges."""
    pg = replay_pg
    entry = _install_fresh_graph(pg)
    _seed_retained_graph(pg)
    pg.apply_file(MIGRATIONS_DIR / "201_account_deletion_tombstones.sql")
    for uid in ("a-deleted", "z-deleted", "owner-deleted"):
        pg.execute(
            "INSERT INTO account_deletion_tombstones(user_id_hash) "
            "VALUES('sha256:'||encode(digest(%s,'sha256'),'hex'))",
            (uid,),
        )
    with pytest.raises(CheckViolation, match="account identity is deleted"):
        pg.execute(entry.sql)
    pg.execute("ROLLBACK")
    for _ in range(2):
        pg.execute(_replay_sql(entry))
    _assert_retained_graph(pg)
    with pytest.raises(CheckViolation, match="account identity is deleted"):
        pg.execute("INSERT INTO connections(user_a_id,user_b_id) VALUES('a-new','z-deleted')")
    pg.execute("ROLLBACK")
    with pytest.raises(MigrationAuthorityError, match="checksum changed"):
        _replay_sql(replace(entry, sql=entry.sql + "\n-- unqualified source"))
