"""Disposable PostgreSQL and Location schema fixture shared by authority tests."""

import os
from pathlib import Path
from types import SimpleNamespace
from uuid import uuid4

import pytest
from sqlalchemy import create_engine, text
from sqlalchemy.engine import make_url


@pytest.fixture(autouse=True)
def active_location_provider_accounts(monkeypatch):
    # SQL fixtures own synthetic active identities, not a live Firebase project.
    # Replace only the provider port: local tombstones, real lifecycle locks,
    # relationship authorization, mutations and rollback remain production SQL.
    from hushh_mcp.services import one_location_agent_service, one_location_circle_service

    def active_accounts(user_ids, **_):
        return set(user_ids)

    monkeypatch.setattr(one_location_agent_service, "active_directory_user_ids", active_accounts)
    monkeypatch.setattr(one_location_circle_service, "active_directory_user_ids", active_accounts)


@pytest.fixture
def db():
    supplied = os.getenv("ONE_COMMAND_TEST_DATABASE_URL")
    if not supplied:
        pytest.skip("An isolated PostgreSQL database is required.")
    url = make_url(supplied).set(drivername="postgresql+psycopg2")
    if (
        url.host not in {"127.0.0.1", "localhost"}
        or url.database != "command_test"
        or url.username != "command_test"
        or url.query
    ):
        pytest.fail("Location command tests refuse a non-isolated PostgreSQL target")

    # The deletion migration owns public-schema guards and a database-wide DDL
    # trigger. Install it in a disposable database while keeping the command
    # fixtures in their original isolated schema.
    suffix = uuid4().hex
    name = f"location_command_test_{suffix}"
    schema = f"command_test_{suffix}"
    migrations = Path(__file__).resolve().parents[2] / "db/migrations"
    admin = create_engine(url, isolation_level="AUTOCOMMIT", hide_parameters=True)
    scoped = None
    created = False

    class Database:
        def __init__(self, engine):
            self.engine = engine

        def execute_raw(self, sql, params=None):
            with self.engine.begin() as conn:
                result = conn.execute(text(sql), params or {})
                return SimpleNamespace(
                    data=[dict(row) for row in result.mappings()] if result.returns_rows else []
                )

    try:
        with admin.connect() as conn:
            conn.exec_driver_sql(f'CREATE DATABASE "{name}"')
        created = True
        scoped = create_engine(
            url.set(database=name),
            hide_parameters=True,
            connect_args={"options": f"-csearch_path={schema},public"},
        )
        with scoped.begin() as conn:
            conn.exec_driver_sql(f'CREATE SCHEMA "{schema}"')
            conn.exec_driver_sql("SET LOCAL search_path TO public")
            conn.exec_driver_sql("""
                CREATE TABLE actor_profiles(user_id TEXT PRIMARY KEY);
                CREATE TABLE vault_keys(user_id TEXT PRIMARY KEY);
            """)
            conn.exec_driver_sql(
                (migrations / "201_account_deletion_tombstones.sql").read_text(encoding="utf-8"),
                execution_options={"no_parameters": True},
            )
        database = Database(scoped)
        database.execute_raw("""
            CREATE TABLE actor_profiles(user_id TEXT PRIMARY KEY);
            INSERT INTO actor_profiles VALUES('owner'),('other');
            CREATE TABLE agent_chat_conversations(id UUID PRIMARY KEY);
        """)
        for migration in (
            "114_one_action_directive_ledger.sql",
            "184_encrypted_one_adk_sessions.sql",
            "212_location_command_runtime.sql",
            "212_location_command_runtime.sql",
            "213_location_command_workflow_binding.sql",
            "213_location_command_workflow_binding.sql",
            "215_location_command_resource_receipt.sql",
            "215_location_command_resource_receipt.sql",
            "216_location_command_membership_receipts.sql",
            "217_location_command_effect_receipts.sql",
            "218_location_command_audience_receipts.sql",
            "216_location_command_membership_receipts.sql",
            "217_location_command_effect_receipts.sql",
            "218_location_command_audience_receipts.sql",
            # The ledger store writes adk_app_name; keep the fixture at the real schema.
            "248_adk_chat_action_authority.sql",
        ):
            with scoped.begin() as conn:
                conn.exec_driver_sql(
                    (migrations / migration).read_text(encoding="utf-8"),
                    execution_options={"no_parameters": True},
                )
        yield database
    finally:
        if scoped is not None:
            scoped.dispose()
        if created:
            with admin.connect() as conn:
                conn.exec_driver_sql(f'DROP DATABASE "{name}" WITH (FORCE)')
        admin.dispose()


def audience_writer_schema(db, monkeypatch):
    """Execute domain writers against real Location migrations and SQL tables."""
    from contextlib import contextmanager

    from hushh_mcp.services import one_location_agent_service as agents

    db.execute_raw("""CREATE TABLE actor_identity_cache(user_id TEXT PRIMARY KEY,display_name TEXT,
        phone_number TEXT,phone_verified BOOLEAN,email TEXT,custom_photo_url TEXT,photo_url TEXT);
        INSERT INTO actor_identity_cache(user_id,display_name,phone_verified) VALUES('owner','Owner',TRUE),('other','Contact',TRUE),('third','Third',TRUE);
        CREATE TABLE connections(id UUID PRIMARY KEY DEFAULT gen_random_uuid(),user_a_id TEXT,user_b_id TEXT,status TEXT,source TEXT,
            created_at TIMESTAMPTZ DEFAULT NOW(),updated_at TIMESTAMPTZ DEFAULT NOW(),revoked_at TIMESTAMPTZ,UNIQUE(user_a_id,user_b_id));
        INSERT INTO connections(user_a_id,user_b_id,status,source) VALUES('owner','other','active','request'),('owner','third','active','request');
        CREATE TABLE connection_requests(requester_user_id TEXT,addressee_user_id TEXT,status TEXT,responded_at TIMESTAMPTZ,updated_at TIMESTAMPTZ,metadata JSONB);
        CREATE TABLE one_location_public_invite_submissions(request_id UUID);
        CREATE TABLE feed_events(user_id TEXT,source_domain TEXT,event_type TEXT,metadata JSONB,source_row_id TEXT);
    """)
    migrations = Path(__file__).resolve().parents[2] / "db/migrations"
    for prefix in (61, 115, 116, 134, 135, 150, 154, 160, 163, 191):
        with db.engine.begin() as connection:
            connection.exec_driver_sql(
                next(migrations.glob(f"{prefix:03d}_*.sql")).read_text(),
                execution_options={"no_parameters": True},
            )
    db.execute_raw("""INSERT INTO one_location_recipient_keys(user_id,key_id,public_key_jwk)
        VALUES('other','key','{"kty":"EC"}'),('third','key-3','{"kty":"EC"}');""")

    @contextmanager
    def connection():
        with db.engine.begin() as conn:
            yield conn

    monkeypatch.setattr(agents, "get_db", lambda: db)
    monkeypatch.setattr(agents, "get_db_connection", connection)
    # Cryptographic token issuance and push transport are outside the SQL writer.
    monkeypatch.setattr(
        agents.OneLocationAgentService,
        "_mint_grant_capability_token",
        lambda *_args, **_kwargs: {"token": "fixture-capability"},
    )
    monkeypatch.setattr(
        agents.OneLocationAgentService,
        "_send_location_share_created_notification",
        lambda *_args, **_kwargs: None,
    )
    return agents.OneLocationAgentService
