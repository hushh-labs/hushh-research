"""Opt-in real-Postgres proof for the contact-sync authority path.

Unit doubles protect most edge cases, but they cannot execute PostgreSQL's
``UNNEST``/``digest`` matcher or the set-based graph writes. Point
``CONTACT_SYNC_POSTGRES_TEST_URL`` at a disposable PostgreSQL database to run
this test. Every fixture lives in a unique schema that is removed afterward.
"""

from __future__ import annotations

import asyncio
import hashlib
import os
import uuid
from pathlib import Path

import asyncpg
import pytest
from sqlalchemy import create_engine, text

from hushh_mcp.services.connection_graph_service import (
    activate_contact_sync_connections_bulk,
)
from hushh_mcp.services.contact_sync_contract import CONTACT_SYNC_MATCH_POLICY_VERSION
from hushh_mcp.services.ria_iam_service import RIAIAMService

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


async def _prepare_schema(schema: str) -> None:
    connection = await asyncpg.connect(POSTGRES_URL)
    try:
        await connection.execute("CREATE EXTENSION IF NOT EXISTS pgcrypto")
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
