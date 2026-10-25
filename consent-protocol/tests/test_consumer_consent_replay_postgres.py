"""Keep installed consent guards and erase only the retiring owner's connection."""

from contextlib import closing
from unittest.mock import patch

import psycopg2
import pytest
from sqlalchemy import create_engine, text

from db.consumer_consent_replay import _qualification, qualified_consumer_guard_replay
from tests.consumer_consent_replay_support import (
    install_consumer_predecessor,
    seed_consumer_connections,
)
from tests.pkm_conformance import postgres_harness
from tests.pkm_conformance.postgres_harness import TempPostgres, find_pg_bin

pytestmark = pytest.mark.skipif(find_pg_bin() is None, reason="local PostgreSQL unavailable")


@pytest.fixture(scope="module")
def consumer_pg():
    server = TempPostgres()
    try:
        with patch.object(postgres_harness, "MIGRATIONS", []):
            server.start()
        server.execute("""CREATE TABLE consent_audit(id bigserial PRIMARY KEY,user_id text,agent_id text,
          scope text,action text,issued_at bigint,expires_at bigint,token_id text,metadata jsonb);
          CREATE TABLE account_deletion_tombstones(user_id_hash text);
          CREATE TABLE developer_apps(app_id text PRIMARY KEY,agent_id text,display_name text,
            contact_email text,created_at bigint,updated_at bigint);
          CREATE TABLE developer_oauth_clients(client_id text PRIMARY KEY,
            app_id text REFERENCES developer_apps ON DELETE CASCADE,client_secret_hash text,
            client_secret_prefix text,created_at bigint,secret_rotated_at bigint);
          CREATE TABLE developer_oauth_authorizations(id bigserial PRIMARY KEY,user_id text,status text);
          CREATE TABLE developer_oauth_tokens(id bigserial PRIMARY KEY,
            authorization_id bigint REFERENCES developer_oauth_authorizations ON DELETE CASCADE,revoked_at bigint);""")
        install_consumer_predecessor(server.execute)
        seed_consumer_connections(server.execute)
        server.execute(_qualification())
        yield server
    finally:
        server.stop()


@pytest.mark.parametrize(
    "drift",
    [
        "DROP TRIGGER zz_consumer_memory_consent ON consent_audit",
        "ALTER TABLE consent_audit DISABLE TRIGGER zz_consumer_memory_consent",
        "ALTER FUNCTION guard_consumer_memory_consent() SECURITY DEFINER",
        "CREATE OR REPLACE FUNCTION guard_consumer_memory_consent() RETURNS trigger LANGUAGE plpgsql SET search_path=public AS $$ BEGIN RETURN NEW; END $$",
        "DROP TRIGGER zz_consumer_memory_consent ON consent_audit; CREATE TRIGGER zz_consumer_memory_consent BEFORE INSERT ON consent_audit FOR EACH ROW EXECUTE FUNCTION preserve_consumer_memory_consent()",
        "DROP TRIGGER zz_consumer_memory_consent ON consent_audit; CREATE TRIGGER zz_consumer_memory_consent AFTER INSERT ON consent_audit FOR EACH ROW EXECUTE FUNCTION guard_consumer_memory_consent()",
        "DROP TRIGGER zz_consumer_memory_consent ON consent_audit; CREATE TRIGGER zz_consumer_memory_consent BEFORE INSERT ON consent_audit FOR EACH ROW EXECUTE FUNCTION guard_consumer_memory_consent('extra')",
        "DROP TRIGGER zz_consumer_memory_consent ON consent_audit; CREATE TRIGGER zz_consumer_memory_consent BEFORE INSERT ON consent_audit FOR EACH ROW WHEN(NEW.scope IS NOT NULL) EXECUTE FUNCTION guard_consumer_memory_consent()",
    ],
)
def test_changed_consumer_authority_refuses(consumer_pg, drift):
    with closing(
        psycopg2.connect(
            host=consumer_pg.dir, port=consumer_pg.port, user="hushh", dbname="postgres"
        )
    ) as conn:
        with conn.cursor() as cur:
            try:
                cur.execute(drift)
                with pytest.raises(
                    psycopg2.errors.RaiseException, match="Consumer consent predecessor changed"
                ):
                    cur.execute(_qualification())
            finally:
                conn.rollback()
    consumer_pg.execute(_qualification())


def test_replay_pin_refuses_changed_source():
    with pytest.raises(ValueError, match="source checksum changed"):
        qualified_consumer_guard_replay("BEGIN; COMMIT;")


def test_permanent_cleanup_preserves_neighbor_and_shared_client(consumer_pg):
    from hushh_mcp.services.account_service import AccountService

    engine = create_engine(
        "postgresql+psycopg2://",
        creator=lambda: psycopg2.connect(
            host=consumer_pg.dir, port=consumer_pg.port, user="hushh", dbname="postgres"
        ),
    )
    try:
        with engine.begin() as conn:
            for key in (171, 198):
                conn.execute(
                    text("SELECT pg_advisory_xact_lock(hashtextextended(:owner,:key))"),
                    {"owner": "synthetic-consumer-owner", "key": key},
                )
            conn.execute(
                text("""INSERT INTO developer_oauth_authorizations(user_id,status,consumer_connection_id,consumer_generation)
              VALUES('synthetic-consumer-owner','approved','cmc_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',1);
              INSERT INTO developer_oauth_tokens(authorization_id)
              SELECT id FROM developer_oauth_authorizations;""")
            )
            results = {}
            AccountService._clear_external_connector_data(
                conn, "synthetic-consumer-owner", results, permanent=True
            )
            assert results["consumer_mcp_connections"] is True
            assert conn.execute(
                text("SELECT user_id FROM consumer_mcp_connections")
            ).scalars().all() == ["synthetic-consumer-neighbor"]
            assert (
                conn.execute(text("SELECT count(*) FROM developer_oauth_authorizations")).scalar()
                == 0
            )
            assert conn.execute(text("SELECT count(*) FROM developer_oauth_tokens")).scalar() == 0
            assert conn.execute(text("SELECT count(*) FROM developer_apps")).scalar() == 1
            assert conn.execute(text("SELECT count(*) FROM developer_oauth_clients")).scalar() == 1
            conn.execute(text(_qualification()))
    finally:
        engine.dispose()
