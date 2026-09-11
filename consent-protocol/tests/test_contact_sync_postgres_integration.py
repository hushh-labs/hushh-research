"""Opt-in real-Postgres proof for the contact-sync authority path.

Unit doubles protect most edge cases, but they cannot execute PostgreSQL's
``UNNEST``/``digest`` matcher or the set-based graph writes. Point
``CONTACT_SYNC_POSTGRES_TEST_URL`` at a disposable PostgreSQL database to run
these tests. Directory/lock fixtures use unique schemas. The full resync
fixture creates and removes a dedicated database to run real deletion guards.
"""

from __future__ import annotations

import asyncio
import hashlib
import os
import time
import uuid
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from threading import Event
from unittest.mock import patch

import asyncpg
import pytest
from sqlalchemy import create_engine, text
from sqlalchemy.engine import make_url
from sqlalchemy.exc import IntegrityError

from hushh_mcp.services.connection_graph_service import (
    activate_contact_sync_connections_bulk,
    lock_connection_graph_users,
    revoke_circle_origins,
)
from hushh_mcp.services.connections_service import ConnectionsService
from hushh_mcp.services.contact_sync_contract import CONTACT_SYNC_MATCH_POLICY_VERSION
from hushh_mcp.services.ria_iam_service import RIAIAMService
from scripts.backfill_contact_disconnect_actors import (
    APPLY_SQL,
    BATCH_SQL,
    verified_disconnect_actor,
)

ROOT = Path(__file__).resolve().parents[1]
POSTGRES_URL = str(os.getenv("CONTACT_SYNC_POSTGRES_TEST_URL") or "").strip()


def _lookup(lookup_id: str, phone: str) -> dict[str, str]:
    digits = "".join(character for character in phone if character.isdigit())
    e164 = f"+{digits}"
    return {
        "lookup_id": lookup_id,
        "hash": hashlib.sha256(e164.encode("utf-8")).hexdigest(),
        "last4": digits[-4:],
    }


class _LiveMatcher(RIAIAMService):
    def __init__(self, connection: asyncpg.Connection) -> None:
        self._test_connection = connection

    async def _conn(self) -> asyncpg.Connection:
        return self._test_connection

    async def _ensure_iam_schema_ready(self, _connection: asyncpg.Connection) -> None:
        return None


async def _prepare_schema(
    schema: str,
    *,
    postgres_url: str = POSTGRES_URL,
    full_deletion_guards: bool = False,
    legacy_disconnect_actor_schema: bool = False,
) -> None:
    connection = await asyncpg.connect(postgres_url)
    try:
        await connection.execute("CREATE EXTENSION IF NOT EXISTS pgcrypto")
        if schema != "public":
            await connection.execute(f'CREATE SCHEMA "{schema}"')
        await connection.execute(f'SET search_path TO "{schema}", public')
        await connection.execute(
            """
            CREATE TABLE actor_profiles (
              user_id TEXT PRIMARY KEY,
              contact_discoverable BOOLEAN NOT NULL DEFAULT FALSE,
              contact_sync_consent_enabled_at TIMESTAMPTZ,
              contact_sync_consent_rule_version BIGINT NOT NULL DEFAULT 0,
              contact_sync_consent_contract_version TEXT,
              updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
            );
            CREATE TABLE marketplace_public_profiles (
              user_id TEXT PRIMARY KEY REFERENCES actor_profiles(user_id) ON DELETE CASCADE,
              display_name TEXT NOT NULL,
              is_discoverable BOOLEAN NOT NULL DEFAULT FALSE
            );
            CREATE TABLE actor_identity_cache (
              user_id TEXT PRIMARY KEY REFERENCES actor_profiles(user_id) ON DELETE CASCADE,
              display_name TEXT,
              email TEXT,
              phone_number TEXT,
              phone_verified BOOLEAN NOT NULL DEFAULT FALSE,
              photo_url TEXT,
              custom_photo_url TEXT
            );
            CREATE TABLE connections (
              id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
              user_a_id TEXT NOT NULL,
              user_b_id TEXT NOT NULL,
              status TEXT NOT NULL DEFAULT 'active'
                CHECK (status IN ('active', 'revoked')),
              source TEXT NOT NULL DEFAULT 'request'
                CHECK (source IN ('request', 'circle_invite', 'import', 'named_circle')),
              created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
              updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
              revoked_at TIMESTAMPTZ,
              CONSTRAINT connections_pair_unique UNIQUE (user_a_id, user_b_id),
              CONSTRAINT connections_canonical_order CHECK (user_a_id < user_b_id)
            );
            CREATE TABLE connection_requests (
              id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
              requester_user_id TEXT NOT NULL,
              addressee_user_id TEXT NOT NULL,
              status TEXT NOT NULL DEFAULT 'pending',
              created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
              updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
              responded_at TIMESTAMPTZ,
              metadata JSONB NOT NULL DEFAULT '{}'::jsonb
            );
            CREATE TABLE connection_scope_proposals (
              id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
              connection_request_id UUID NOT NULL REFERENCES connection_requests(id),
              status TEXT NOT NULL DEFAULT 'pending',
              expires_at TIMESTAMPTZ NOT NULL DEFAULT (NOW() + INTERVAL '90 days'),
              resolved_at TIMESTAMPTZ
            );
            CREATE TABLE connection_scope_proposal_events (
              id BIGSERIAL PRIMARY KEY,
              connection_scope_proposal_id UUID NOT NULL
                REFERENCES connection_scope_proposals(id),
              event_type TEXT NOT NULL,
              actor_user_id TEXT,
              reason TEXT
            );
            CREATE TABLE connection_origins (
              id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
              connection_id UUID NOT NULL REFERENCES connections(id) ON DELETE CASCADE,
              origin_kind TEXT NOT NULL,
              origin_key TEXT NOT NULL,
              source_circle_id UUID,
              source_ref TEXT,
              status TEXT NOT NULL DEFAULT 'active',
              created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
              updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
              revoked_at TIMESTAMPTZ,
              metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
              CONSTRAINT connection_origins_key_unique UNIQUE (connection_id, origin_key)
            );
            CREATE TABLE trusted_connections (
              id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
              owner_user_id TEXT NOT NULL,
              trusted_user_id TEXT NOT NULL,
              status TEXT NOT NULL DEFAULT 'active',
              source TEXT NOT NULL DEFAULT 'agent_one',
              created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
              updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
              revoked_at TIMESTAMPTZ,
              CONSTRAINT trusted_connections_edge_unique
                UNIQUE (owner_user_id, trusted_user_id)
            );
            """
        )
        migration = (ROOT / "db/migrations/200_contact_sync_directory_policy_lock.sql").read_text(
            encoding="utf-8"
        )
        await connection.execute(migration)
        actor_migration = (ROOT / "db/migrations/205_contact_sync_disconnect_actor.sql").read_text()
        if full_deletion_guards:
            # Use the complete, unmodified migration in a fresh database's
            # public schema, including its catalog installer and DDL trigger.
            await connection.execute("CREATE TABLE vault_keys (user_id TEXT PRIMARY KEY)")
            await connection.execute(
                (ROOT / "db/migrations/201_account_deletion_tombstones.sql").read_text()
            )
        else:
            # Directory-policy/lock tests deliberately isolate migration 200
            # from account-deletion locking. The full resync test below applies
            # both complete migrations in public, without this scoped exclusion.
            actor_migration = actor_migration.replace(
                "SELECT install_account_deletion_write_guards();", ""
            )
        if legacy_disconnect_actor_schema:
            # This is the released pre-19c756995 shape. It exists only in the
            # fixture to prove that 206 repairs a previously applied schema;
            # do not edit 205 again to make this fixture pass.
            await connection.execute(
                """
                ALTER TABLE connections
                  ADD COLUMN revoked_by_user_id TEXT,
                  ADD COLUMN revoked_by_at TIMESTAMPTZ;
                ALTER TABLE connections ADD CONSTRAINT connections_revocation_actor_pair
                  CHECK (revoked_by_user_id IS NULL OR revoked_by_user_id IN (user_a_id, user_b_id));
                """
            )
            upgrade = (
                ROOT / "db/migrations/206_contact_sync_disconnect_actor_upgrade.sql"
            ).read_text()
            await connection.execute(upgrade)
            await connection.execute(upgrade)
        else:
            await connection.execute(actor_migration)
        await connection.executemany(
            """
            INSERT INTO actor_profiles (
              user_id, contact_discoverable, contact_sync_consent_rule_version
            ) VALUES ($1, $2, $3)
            """,
            [
                ("owner", False, 0),
                ("manish", False, 0),
                ("parth", False, 2),
                ("kushal", False, 0),
                ("opted_out", False, 3),
                ("hidden", False, 0),
                ("duplicate_a", False, 0),
                ("duplicate_b", False, 0),
            ],
        )
        await connection.executemany(
            """
            INSERT INTO actor_identity_cache (
              user_id, display_name, phone_number, phone_verified
            ) VALUES ($1, $2, $3, TRUE)
            """,
            [
                ("owner", "Owner", "+919000000001"),
                ("manish", "Manish", "+919876500001"),
                ("parth", "Parth", "+16502530000"),
                ("kushal", "", "+919876500003"),
                ("opted_out", "Opted out", "+919876500004"),
                ("hidden", "Hidden", "+919876500005"),
                ("duplicate_a", "Duplicate A", "+919876500006"),
                ("duplicate_b", "Duplicate B", "+919876500006"),
            ],
        )
        await connection.executemany(
            """
            INSERT INTO marketplace_public_profiles (
              user_id, display_name, is_discoverable
            ) VALUES ($1, $2, $3)
            """,
            [
                ("kushal", "Kushal", True),
                ("hidden", "Hidden", False),
                ("parth", "Parth", False),
            ],
        )
        await connection.executemany(
            """
            INSERT INTO connections (user_a_id, user_b_id, status, source)
            VALUES (LEAST($1, $2), GREATEST($1, $2), 'active', 'request')
            """,
            [("owner", "manish"), ("owner", "parth")],
        )
    finally:
        await connection.close()


async def _match(schema: str, lookups: list[dict[str, str]]) -> list[dict[str, object]]:
    connection = await asyncpg.connect(
        POSTGRES_URL,
        server_settings={"search_path": f'"{schema}", public'},
    )
    return await _LiveMatcher(connection).match_one_network_contact_lookups_exact(
        "owner", phone_lookups=lookups
    )


async def _drop_schema(schema: str) -> None:
    connection = await asyncpg.connect(POSTGRES_URL)
    try:
        await connection.execute(f'DROP SCHEMA IF EXISTS "{schema}" CASCADE')
    finally:
        await connection.close()


async def _assert_policy_writers_wait_for_graph_lock(schema: str) -> None:
    graph_connection = await asyncpg.connect(POSTGRES_URL)
    writer_connection = await asyncpg.connect(POSTGRES_URL)
    graph_transaction = graph_connection.transaction()
    transaction_started = False
    try:
        await graph_connection.execute(f'SET search_path TO "{schema}", public')
        await writer_connection.execute(f'SET search_path TO "{schema}", public')
        await writer_connection.execute("SET lock_timeout = '150ms'")
        await writer_connection.execute(
            """
            INSERT INTO actor_profiles (user_id)
            VALUES ('opt_out_update'), ('marketplace_hide')
            """
        )
        await graph_transaction.start()
        transaction_started = True

        # A routine default actor-profile insert carries no explicit preference
        # evidence and therefore must not join the graph lock order.
        await graph_connection.execute(
            "SELECT pg_advisory_xact_lock(hashtextextended($1, 171))",
            "default_insert",
        )
        await writer_connection.execute(
            "INSERT INTO actor_profiles (user_id) VALUES ('default_insert')"
        )

        # Explicit preference INSERT, preference UPDATE, and marketplace
        # visibility writes must all serialize with graph creation.
        await graph_connection.execute(
            "SELECT pg_advisory_xact_lock(hashtextextended($1, 171))",
            "explicit_insert",
        )
        with pytest.raises(asyncpg.LockNotAvailableError):
            await writer_connection.execute(
                """
                INSERT INTO actor_profiles (
                  user_id, contact_discoverable, contact_sync_consent_rule_version
                ) VALUES ('explicit_insert', FALSE, 1)
                """
            )

        await graph_connection.execute(
            "SELECT pg_advisory_xact_lock(hashtextextended($1, 171))",
            "opt_out_update",
        )
        with pytest.raises(asyncpg.LockNotAvailableError):
            await writer_connection.execute(
                """
                UPDATE actor_profiles
                SET contact_sync_consent_rule_version = 1
                WHERE user_id = 'opt_out_update'
                """
            )

        await graph_connection.execute(
            "SELECT pg_advisory_xact_lock(hashtextextended($1, 171))",
            "marketplace_hide",
        )
        with pytest.raises(asyncpg.LockNotAvailableError):
            await writer_connection.execute(
                """
                INSERT INTO marketplace_public_profiles (
                  user_id, display_name, is_discoverable
                ) VALUES ('marketplace_hide', 'Hidden while syncing', FALSE)
                """
            )
    finally:
        if transaction_started:
            await graph_transaction.rollback()
        await graph_connection.close()
        await writer_connection.close()


@pytest.mark.db
@pytest.mark.skipif(
    not POSTGRES_URL,
    reason="set CONTACT_SYNC_POSTGRES_TEST_URL to a disposable PostgreSQL database",
)
def test_exact_directory_match_and_graph_projection_execute_on_postgres() -> None:
    schema = f"contact_sync_{uuid.uuid4().hex}"
    lookups = [
        _lookup("manish", "+919876500001"),
        _lookup("parth", "16502530000"),
        _lookup("kushal", "+919876500003"),
        _lookup("opted_out", "+919876500004"),
        _lookup("hidden", "+919876500005"),
        _lookup("duplicate", "+919876500006"),
        _lookup("self", "+919000000001"),
    ]

    try:
        asyncio.run(_prepare_schema(schema))
        asyncio.run(_assert_policy_writers_wait_for_graph_lock(schema))
        matches = asyncio.run(_match(schema, lookups))
        assert [(item["lookup_id"], item["display_name"]) for item in matches] == [
            ("kushal", "Kushal"),
            ("manish", "Manish"),
            ("parth", "Parth"),
        ]

        sync_url = POSTGRES_URL.replace("postgresql://", "postgresql+psycopg2://", 1)
        engine = create_engine(sync_url)
        try:
            with engine.begin() as connection:
                connection.execute(text(f'SET LOCAL search_path TO "{schema}", public'))
                activated = activate_contact_sync_connections_bulk(
                    connection,
                    requester_user_id="owner",
                    activations=[
                        {
                            "target_user_id": target,
                            "origin_metadata": {
                                "authorization": "verified_phone_directory_match",
                                "matchPolicyVersion": CONTACT_SYNC_MATCH_POLICY_VERSION,
                                "targetPreferenceState": "default",
                                "phone": "+919999999999",
                                "hash": "must-be-stripped",
                            },
                        }
                        for target in ("kushal", "manish")
                    ],
                )
                assert activated == ["kushal", "manish"]

                origins = (
                    connection.execute(
                        text(
                            """
                        SELECT source_ref, metadata
                        FROM connection_origins
                        ORDER BY source_ref, connection_id
                        """
                        )
                    )
                    .mappings()
                    .all()
                )
                assert len(origins) == 2
                for origin in origins:
                    metadata = dict(origin["metadata"])
                    assert metadata == {
                        "authorization": "verified_phone_directory_match",
                        "matchPolicyVersion": CONTACT_SYNC_MATCH_POLICY_VERSION,
                        "targetPreferenceState": "default",
                    }
                    assert "phone" not in metadata
                    assert "hash" not in metadata

                assert (
                    connection.execute(
                        text("SELECT COUNT(*) FROM trusted_connections")
                    ).scalar_one()
                    == 4
                )
                assert (
                    connection.execute(
                        text("SELECT COUNT(*) FROM connection_scope_proposals")
                    ).scalar_one()
                    == 0
                )
        finally:
            engine.dispose()
    finally:
        asyncio.run(_drop_schema(schema))


@pytest.mark.db
@pytest.mark.skipif(not POSTGRES_URL, reason="requires disposable PostgreSQL")
def test_disconnect_waiting_on_graph_lock_wins_over_older_sync_cutoff() -> None:
    schema = f"contact_race_{uuid.uuid4().hex}"
    engine = create_engine(POSTGRES_URL.replace("postgresql://", "postgresql+psycopg2://", 1))
    ready = Event()
    worker = {}
    try:
        asyncio.run(_prepare_schema(schema))

        def disconnect():
            with engine.begin() as conn:
                conn.execute(text(f'SET LOCAL search_path TO "{schema}", public'))
                worker.update(
                    conn.execute(text("SELECT pg_backend_pid() AS pid, NOW() AS started_at"))
                    .mappings()
                    .one()
                )
                service = ConnectionsService()
                service._transaction_connection = conn
                connection_id = conn.execute(
                    text(
                        "SELECT id FROM connections WHERE user_a_id=LEAST('owner','manish') AND user_b_id=GREATEST('owner','manish')"
                    )
                ).scalar_one()
                ready.set()
                with (
                    patch.object(service, "_cancel_pending_pair_requests"),
                    patch.object(service, "_revoke_pair_capabilities"),
                    patch.object(service, "_end_one_location_circle_memberships"),
                    patch.object(service, "_record_connection_feed_transition"),
                ):
                    assert service.remove_connection("owner", str(connection_id))["removed"] == 1
                return conn.execute(
                    text("SELECT revoked_at FROM connections WHERE id=:id"), {"id": connection_id}
                ).scalar_one()

        with ThreadPoolExecutor(max_workers=1) as pool:
            with engine.connect() as gate:
                lock_connection_graph_users(gate, user_ids={"owner", "manish"})
                future = pool.submit(disconnect)
                try:
                    assert ready.wait(5)
                    deadline = time.monotonic() + 5
                    while not gate.execute(
                        text(
                            "SELECT EXISTS(SELECT 1 FROM pg_locks WHERE pid=:pid AND locktype='advisory' AND NOT granted)"
                        ),
                        {"pid": worker["pid"]},
                    ).scalar_one():
                        assert time.monotonic() < deadline, (
                            "disconnect did not wait for the graph gate"
                        )
                        time.sleep(0.02)
                    cutoff = gate.execute(text("SELECT clock_timestamp()")).scalar_one()
                finally:
                    gate.commit()
            removed_at = future.result(timeout=10)
        assert worker["started_at"] < cutoff < removed_at
        with engine.begin() as conn:
            conn.execute(text(f'SET LOCAL search_path TO "{schema}", public'))
            service = ConnectionsService()
            service._transaction_connection = conn
            args = {
                "phone_lookups": [_lookup("manish", "+919876500001")],
                "matches": [{"lookup_id": "manish", "user_id": "manish"}],
            }
            with patch.object(service, "_join_trusted_system_circles_bulk"):
                assert (
                    service.sync_contact_matches("owner", **args, sync_started_at=cutoff)[
                        "suppressedCount"
                    ]
                    == 1
                )
                assert (
                    service.sync_contact_matches(
                        "owner", **args, sync_started_at=service.begin_contact_sync()
                    )["autoConnectedCount"]
                    == 1
                )
    finally:
        engine.dispose()
        asyncio.run(_drop_schema(schema))


@pytest.mark.db
@pytest.mark.skipif(
    not POSTGRES_URL,
    reason="set CONTACT_SYNC_POSTGRES_TEST_URL to a disposable PostgreSQL database",
)
def test_legacy_disconnect_actor_schema_replays_into_owner_resync_on_postgres() -> None:
    """206 converts only a verified old 205 episode into current authority."""
    database = f"codex_contact_upgrade_{uuid.uuid4().hex}"
    admin_engine = create_engine(
        make_url(POSTGRES_URL).set(drivername="postgresql+psycopg2"),
        isolation_level="AUTOCOMMIT",
    )
    url = make_url(POSTGRES_URL).set(database=database)
    engine = create_engine(url.set(drivername="postgresql+psycopg2"))
    try:
        with admin_engine.connect() as admin:
            admin.exec_driver_sql(f'CREATE DATABASE "{database}"')
        asyncio.run(
            _prepare_schema(
                "public",
                postgres_url=url.render_as_string(hide_password=False),
                full_deletion_guards=True,
                legacy_disconnect_actor_schema=True,
            )
        )
        with engine.begin() as connection:
            connection.execute(
                text("""CREATE TABLE feed_events (
                    id BIGSERIAL PRIMARY KEY, user_id TEXT, source_domain TEXT,
                    event_type TEXT, metadata JSONB, source_row_id TEXT,
                    created_at TIMESTAMPTZ DEFAULT NOW(),
                    UNIQUE(user_id, source_domain, event_type, source_row_id)
                )""")
            )
            connection.execute(
                text(
                    """
                    WITH episode AS MATERIALIZED (SELECT clock_timestamp() AS revoked_at)
                    UPDATE connections
                    SET status='revoked', revoked_at=episode.revoked_at,
                        revoked_by_at=episode.revoked_at, revoked_by_user_id='owner'
                    FROM episode
                    WHERE user_a_id=LEAST('owner', 'manish')
                      AND user_b_id=GREATEST('owner', 'manish')
                    """
                )
            )
            # Run 206 again after the old episode exists: release migrations
            # replay, and historical conversion must be idempotent.
            upgrade = (
                ROOT / "db/migrations/206_contact_sync_disconnect_actor_upgrade.sql"
            ).read_text()
            connection.exec_driver_sql(upgrade.replace("BEGIN;", "").replace("COMMIT;", ""))
            connection.exec_driver_sql(upgrade.replace("BEGIN;", "").replace("COMMIT;", ""))

            row = connection.execute(
                text(
                    """
                    SELECT revoked_by_side, revoked_by_at = revoked_at AS episode_matches
                    FROM connections
                    WHERE user_a_id=LEAST('owner', 'manish')
                      AND user_b_id=GREATEST('owner', 'manish')
                    """
                )
            ).mappings().one()
            assert row["revoked_by_side"] == "b"
            assert row["episode_matches"] is True
            constraint = connection.execute(
                text(
                    """
                    SELECT pg_get_constraintdef(oid)
                    FROM pg_constraint
                    WHERE conrelid='connections'::regclass
                      AND conname='connections_revocation_actor_pair'
                    """
                )
            ).scalar_one()
            assert "revoked_by_side" in constraint
            assert "revoked_by_user_id" not in constraint

            service = ConnectionsService()
            service._transaction_connection = connection
            with (
                patch.object(service, "_join_trusted_system_circles_bulk"),
                patch.object(service, "_cancel_pending_pair_requests"),
                patch.object(service, "_revoke_pair_capabilities"),
                patch.object(service, "_end_one_location_circle_memberships"),
            ):
                result = service.sync_contact_matches(
                    "owner",
                    phone_lookups=[_lookup("manish", "+919876500001")],
                    matches=[{"lookup_id": "manish", "user_id": "manish"}],
                    sync_started_at=service.begin_contact_sync(),
                )
            assert result["autoConnectedCount"] == 1
    finally:
        engine.dispose()
        assert database.startswith("codex_contact_upgrade_")
        with admin_engine.connect() as admin:
            admin.exec_driver_sql(f'DROP DATABASE IF EXISTS "{database}" WITH (FORCE)')
        admin_engine.dispose()


@pytest.mark.db
@pytest.mark.skipif(
    not POSTGRES_URL,
    reason="set CONTACT_SYNC_POSTGRES_TEST_URL to a disposable PostgreSQL database",
)
def test_explicit_resync_disconnect_episodes_and_backfill_on_postgres() -> None:
    schema = "public"
    database = f"codex_contact_resync_{uuid.uuid4().hex}"
    admin_engine = create_engine(
        make_url(POSTGRES_URL).set(drivername="postgresql+psycopg2"),
        isolation_level="AUTOCOMMIT",
    )
    url = make_url(POSTGRES_URL).set(database=database)
    engine = create_engine(url.set(drivername="postgresql+psycopg2"))
    try:
        with admin_engine.connect() as admin:
            admin.exec_driver_sql(f'CREATE DATABASE "{database}"')
        asyncio.run(
            _prepare_schema(
                schema,
                postgres_url=url.render_as_string(hide_password=False),
                full_deletion_guards=True,
            )
        )
        with engine.begin() as connection:
            connection.execute(text(f'SET LOCAL search_path TO "{schema}", public'))
            connection.execute(
                text(
                    "UPDATE actor_profiles SET contact_sync_consent_rule_version=0 WHERE user_id='parth'"
                )
            )
            connection.execute(
                text(
                    "UPDATE marketplace_public_profiles SET is_discoverable=TRUE WHERE user_id='parth'"
                )
            )
            connection.execute(
                text("""CREATE TABLE feed_events (
                id BIGSERIAL PRIMARY KEY, user_id TEXT, source_domain TEXT, event_type TEXT,
                metadata JSONB, source_row_id TEXT, created_at TIMESTAMPTZ DEFAULT NOW(),
                UNIQUE(user_id, source_domain, event_type, source_row_id))""")
            )
            service = ConnectionsService()
            service._transaction_connection = connection
            lookups = [
                _lookup(name, phone)
                for name, phone in (
                    ("manish", "+919876500001"),
                    ("parth", "+16502530000"),
                    ("kushal", "+919876500003"),
                )
            ]

            def sync(cutoff=None):
                return service.sync_contact_matches(
                    "owner",
                    phone_lookups=lookups,
                    matches=[
                        {"lookup_id": item["lookup_id"], "user_id": item["lookup_id"]}
                        for item in lookups
                    ],
                    sync_started_at=cutoff or service.begin_contact_sync(),
                )

            def edge(target):
                return dict(
                    connection.execute(
                        text(
                            "SELECT * FROM connections WHERE user_a_id=LEAST('owner',:target) AND user_b_id=GREATEST('owner',:target)"
                        ),
                        {"target": target},
                    )
                    .mappings()
                    .one()
                )

            # These independent subsystems have their own regression fixtures;
            # the canonical disconnect, SQL locks, proofs, provenance and mirror
            # writes below execute the real production service on PostgreSQL.
            with (
                patch.object(service, "_join_trusted_system_circles_bulk"),
                patch.object(service, "_cancel_pending_pair_requests"),
                patch.object(service, "_revoke_pair_capabilities"),
                patch.object(service, "_end_one_location_circle_memberships") as teardown,
            ):
                assert sync()["matchedCount"] == 3
                guard_args = (
                    connection.execute(
                        text("""
                    SELECT encode(tgargs, 'escape') FROM pg_trigger
                    WHERE tgrelid='connections'::regclass AND NOT tgisinternal
                      AND tgname LIKE 'trg_reject_deleted_account_%'
                """)
                    )
                    .scalars()
                    .all()
                )
                assert guard_args and all(
                    "user_a_id" in args and "user_b_id" in args and "revoked_by" not in args
                    for args in guard_args
                )
                with pytest.raises(IntegrityError, match="account identity reference is immutable"):
                    with connection.begin_nested():
                        connection.execute(
                            text("UPDATE connections SET user_a_id='a_reparented' WHERE id=:id"),
                            {"id": edge("manish")["id"]},
                        )
                removed_id = str(edge("manish")["id"])
                circle_ids = [str(uuid.uuid4()), str(uuid.uuid4())]
                connection.execute(
                    text("CREATE TABLE one_location_circles (id UUID PRIMARY KEY, name TEXT)")
                )
                for circle_id in circle_ids:
                    connection.execute(
                        text("INSERT INTO one_location_circles VALUES (:id, 'Test Circle')"),
                        {"id": circle_id},
                    )
                    connection.execute(
                        text("""INSERT INTO connection_origins
                        (connection_id, origin_kind, origin_key, source_circle_id)
                        VALUES (:connection, 'named_circle', :key, :circle)"""),
                        {
                            "connection": removed_id,
                            "key": f"named_circle:{circle_id}",
                            "circle": circle_id,
                        },
                    )

                def clean_named_origins(**_):
                    revoke_circle_origins(connection, circle_id=circle_ids[0])
                    assert edge("manish")["status"] == "active"
                    revoke_circle_origins(connection, circle_id=circle_ids[1])
                    assert edge("manish")["revoked_by_at"] != edge("manish")["revoked_at"]

                teardown.side_effect = clean_named_origins
                assert service.remove_connection("owner", removed_id)["removed"] == 1
                teardown.side_effect = None
                assert (
                    connection.execute(
                        text("SELECT COUNT(*) FROM connections WHERE status='active'")
                    ).scalar_one()
                    == 2
                )
                assert edge("manish")["revoked_by_side"] == "b"
                assert edge("manish")["revoked_by_at"] == edge("manish")["revoked_at"]
                restored = sync()
                assert (
                    restored["matchedCount"],
                    restored["autoConnectedCount"],
                    restored["alreadyConnectedCount"],
                ) == (3, 1, 2)
                for _ in range(3):
                    assert sync()["alreadyConnectedCount"] == 3
                assert (
                    connection.execute(text("SELECT COUNT(*) FROM connections")).scalar_one() == 3
                )
                assert (
                    connection.execute(
                        text("SELECT COUNT(*) FROM connection_origins WHERE status='active'")
                    ).scalar_one()
                    == 3
                )
                assert (
                    connection.execute(
                        text("SELECT COUNT(*) FROM trusted_connections WHERE status='active'")
                    ).scalar_one()
                    == 6
                )
                assert edge("manish")["revoked_by_side"] is None
                assert (
                    connection.execute(
                        text(
                            "SELECT COUNT(*) FROM connection_origins WHERE origin_kind='named_circle' AND status='active'"
                        )
                    ).scalar_one()
                    == 0
                )

                # Peer intent and idempotent removal preserve the original actor.
                assert service.remove_connection("parth", str(edge("parth")["id"]))["removed"] == 1
                assert service.remove_connection("owner", str(edge("parth")["id"]))["removed"] == 0
                assert edge("parth")["revoked_by_side"] == "b"
                assert sync()["suppressedCount"] == 1

                # Each side may reverse its own removal. Alternating actors
                # changes relationship metadata while participant IDs stay fixed.
                owner_lookup = _lookup("owner", "+919000000001")
                assert (
                    service.sync_contact_matches(
                        "parth",
                        phone_lookups=[owner_lookup],
                        matches=[{"lookup_id": "owner", "user_id": "owner"}],
                        sync_started_at=service.begin_contact_sync(),
                    )["autoConnectedCount"]
                    == 1
                )
                assert edge("parth")["revoked_by_side"] is None
                service.remove_connection("owner", str(edge("parth")["id"]))
                assert edge("parth")["revoked_by_side"] == "a"
                assert sync()["autoConnectedCount"] == 1
                service.remove_connection("parth", str(edge("parth")["id"]))
                assert edge("parth")["revoked_by_side"] == "b"
                assert sync()["suppressedCount"] == 1

                # The transaction began before this cutoff; clock_timestamp,
                # unlike NOW, still proves that the disconnect happened later.
                cutoff = service.begin_contact_sync()
                service.remove_connection("owner", str(edge("kushal")["id"]))
                episode = edge("kushal")["revoked_at"]
                assert episode > cutoff
                assert sync(cutoff)["suppressedCount"] == 2
                assert sync()["autoConnectedCount"] == 1

                # A stale caller cannot reuse a previous revocation episode.
                service.remove_connection("owner", str(edge("kushal")["id"]))
                assert (
                    activate_contact_sync_connections_bulk(
                        connection,
                        requester_user_id="owner",
                        sync_started_at=service.begin_contact_sync(),
                        activations=[
                            {
                                "target_user_id": "kushal",
                                "reconnect_revoked_at": episode,
                                "origin_metadata": {
                                    "authorization": "verified_phone_directory_match",
                                    "matchPolicyVersion": CONTACT_SYNC_MATCH_POLICY_VERSION,
                                    "targetPreferenceState": "default",
                                },
                            }
                        ],
                    )
                    == []
                )

                # Mixed-version writers invalidate stale actor evidence.
                connection.execute(
                    text("UPDATE connections SET revoked_at=clock_timestamp() WHERE id=:id"),
                    {"id": edge("kushal")["id"]},
                )
                assert sync()["suppressedCount"] == 2

                # Historical actor backfill requires both exact-episode events.
                connection.execute(
                    text(
                        "UPDATE connections SET revoked_by_side=NULL, revoked_by_at=NULL, revoked_at=NOW() WHERE id=:id"
                    ),
                    {"id": edge("manish")["id"]},
                )
                connection.execute(
                    text("UPDATE connections SET status='revoked' WHERE id=:id"),
                    {"id": edge("manish")["id"]},
                )
                historic = edge("manish")
                source_id = f"{historic['id']}:{historic['revoked_at']}"
                for owner in ("owner", "manish"):
                    service._record_connection_feed_transition(
                        owner_user_id=owner,
                        counterpart_user_id="manish" if owner == "owner" else "owner",
                        actor_user_id="owner",
                        event_type="connection_revoked",
                        source_row_id=source_id,
                    )
                candidates = (
                    connection.execute(text(BATCH_SQL), {"after_id": None, "batch_size": 10})
                    .mappings()
                    .all()
                )
                candidate = next(dict(row) for row in candidates if row["id"] == historic["id"])
                # This fixture runs several episodes in one transaction, so
                # NOW timestamps collide: conflicting history must fail closed.
                assert verified_disconnect_actor(candidate) is None
                connection.execute(
                    text(
                        "DELETE FROM feed_events WHERE LEFT(source_row_id,37)=:prefix AND source_row_id<>:source"
                    ),
                    {"prefix": f"{historic['id']}:", "source": source_id},
                )
                candidates = (
                    connection.execute(text(BATCH_SQL), {"after_id": None, "batch_size": 10})
                    .mappings()
                    .all()
                )
                candidate = next(dict(row) for row in candidates if row["id"] == historic["id"])
                assert verified_disconnect_actor(candidate) == "owner"
                assert verified_disconnect_actor({**candidate, "peer_count": 0}) is None
                assert (
                    verified_disconnect_actor(
                        {**candidate, "source_row_id": f"{historic['id']}:bad"}
                    )
                    is None
                )
                assert (
                    connection.execute(
                        text(APPLY_SQL),
                        {
                            "id": str(historic["id"]),
                            "actor": "owner",
                            "observed_revoked_at": historic["revoked_at"],
                        },
                    ).rowcount
                    == 1
                )
                assert sync()["autoConnectedCount"] == 1

            # Rollback removes only the annotation; graph rows survive, and
            # re-expansion safely returns old actor evidence to unknown.
            count = connection.execute(text("SELECT COUNT(*) FROM connections")).scalar_one()
            down = (
                ROOT / "db/migrations/rollback/205_contact_sync_disconnect_actor.rollback.sql"
            ).read_text()
            connection.exec_driver_sql(down.replace("BEGIN;", "").replace("COMMIT;", ""))
            assert (
                connection.execute(text("SELECT COUNT(*) FROM connections")).scalar_one() == count
            )
            up = (ROOT / "db/migrations/205_contact_sync_disconnect_actor.sql").read_text()
            connection.exec_driver_sql(up.replace("BEGIN;", "").replace("COMMIT;", ""))
            connection.exec_driver_sql(up.replace("BEGIN;", "").replace("COMMIT;", ""))
            assert (
                connection.execute(
                    text("SELECT COUNT(*) FROM connections WHERE revoked_by_side IS NOT NULL")
                ).scalar_one()
                == 0
            )
            # Real root deletion still forbids recreating a canonical pair.
            connection.execute(text("DELETE FROM actor_profiles WHERE user_id='manish'"))
            with pytest.raises(IntegrityError, match="account identity is deleted"):
                with connection.begin_nested():
                    connection.execute(
                        text(
                            "INSERT INTO connections(user_a_id,user_b_id) VALUES ('manish','zz_person')"
                        )
                    )
    finally:
        engine.dispose()
        assert (
            database.startswith("codex_contact_resync_")
            and len(database) == len("codex_contact_resync_") + 32
        )
        with admin_engine.connect() as admin:
            admin.exec_driver_sql(f'DROP DATABASE IF EXISTS "{database}" WITH (FORCE)')
        admin_engine.dispose()
