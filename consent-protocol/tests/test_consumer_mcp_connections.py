"""Standing authority against disposable PostgreSQL, including competing writers."""

from concurrent.futures import ThreadPoolExecutor, TimeoutError
from dataclasses import replace
from pathlib import Path
from threading import Event

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from psycopg2.extensions import parse_dsn
from sqlalchemy import create_engine, text
from sqlalchemy.engine import URL
from sqlalchemy.exc import DBAPIError

from db.db_client import DatabaseClient
from hushh_mcp.constants import ConsentScope
from hushh_mcp.runtime_settings import get_app_runtime_settings
from hushh_mcp.services.account_service import AccountService
from hushh_mcp.services.consumer_mcp_connections import (
    ConsumerConnectionDenied,
    ConsumerMcpConnections,
)
from hushh_mcp.services.developer_oauth_service import DeveloperOAuthService
from hushh_mcp.services.developer_registry_service import DeveloperRegistryService
from tests.test_data_model_audit_postgres import isolated_postgres  # noqa: F401
from tests.test_mcp_oauth_owner_binding import issue


@pytest.fixture
def consumer(isolated_postgres, monkeypatch):  # noqa: F811 - imported shared pytest fixture
    monkeypatch.setenv("DB_OFFLINE", "0")
    monkeypatch.setenv("ENVIRONMENT", "development")
    get_app_runtime_settings.cache_clear()
    monkeypatch.setenv("CONSENT_API_PUBLIC_ORIGIN", "https://mcp.example.test")
    monkeypatch.setattr(DeveloperOAuthService, "_tables_ensured", False)
    dsn = parse_dsn(isolated_postgres)
    engine = create_engine(
        URL.create(
            "postgresql+psycopg2",
            username=dsn["user"],
            database=dsn["dbname"],
            query={"host": dsn["host"], "port": dsn["port"]},
        )
    )
    db = DatabaseClient(engine)
    db.execute_raw("""CREATE TABLE developer_apps (
        app_id TEXT PRIMARY KEY, agent_id TEXT, display_name TEXT, allowed_tool_groups TEXT,
        allowed_capabilities TEXT, support_url TEXT, policy_url TEXT, website_url TEXT,
        brand_image_url TEXT, contact_email TEXT, kind TEXT, crm_id TEXT, schema_profile TEXT,
        oauth_client_credentials_enabled BOOLEAN, status TEXT)""")
    db.execute_raw("""INSERT INTO developer_apps
        (app_id, agent_id, display_name, allowed_tool_groups, kind, status)
        VALUES ('app_test','developer:app_test','Test assistant','["core_consent"]',
                'self_serve','active')""")
    oauth = DeveloperOAuthService.__new__(DeveloperOAuthService)
    oauth._db = db
    oauth._registry = DeveloperRegistryService.__new__(DeveloperRegistryService)
    oauth.ensure_tables()
    db.execute_raw("""INSERT INTO developer_oauth_clients
        (app_id,client_id,client_secret_hash,client_secret_prefix,redirect_uris,created_at,secret_rotated_at)
        VALUES ('app_test','client_test','unused','unused',
                '["https://assistant.example.test/callback"]',1,1)""")
    db.execute_raw("""CREATE TABLE personal_agent_registry
        (user_id TEXT PRIMARY KEY,hushh_id TEXT,status TEXT,backend_metadata JSONB)""")
    db.execute_raw("""INSERT INTO personal_agent_registry VALUES
        ('owner_a','pod_a','provisioned','{}'),('owner_b','pod_b','provisioned','{}')""")
    db.execute_raw("CREATE TABLE account_deletion_tombstones (user_id_hash TEXT PRIMARY KEY)")
    db.execute_raw("""CREATE TABLE consent_audit (id BIGSERIAL PRIMARY KEY,
        token_id TEXT NOT NULL,user_id TEXT,agent_id TEXT,scope TEXT,action TEXT,
        issued_at BIGINT NOT NULL,expires_at BIGINT,metadata JSONB,
        request_id TEXT,scope_description TEXT)""")
    migration = Path(__file__).parents[1] / "db/migrations/parked/938_consumer_mcp_connections.sql"
    raw = engine.raw_connection()
    try:
        with raw.cursor() as cursor:
            cursor.execute(migration.read_text())
        raw.commit()
    finally:
        raw.close()
    service = ConsumerMcpConnections(db)
    yield service, oauth, db
    engine.dispose()
    get_app_runtime_settings.cache_clear()


def connect(consumer, owner="owner_a"):
    service, oauth, _ = consumer
    _, tokens = issue(oauth, owner=owner)
    principal = oauth.authenticate_access_token(tokens["access_token"])
    return principal, service.prepare(principal), tokens


def approve(service, review, owner="owner_a"):
    return service.approve(
        owner=owner,
        connection_id=review.connection_id,
        generation=review.generation,
        authorization_id=review.authorization_id,
    )


def test_renewal_reuses_consent_but_disconnect_fences_every_session(consumer):
    service, oauth, db = consumer
    principal, review, tokens = connect(consumer)
    # A credential issued before disconnect but never bound is not a new login.
    _, dormant_tokens = issue(oauth)
    dormant = oauth.authenticate_access_token(dormant_tokens["access_token"])
    assert not review.memory_access
    with pytest.raises(ConsumerConnectionDenied, match="approval required"):
        with service.memory_transaction(principal, operation="read"):
            pytest.fail("unapproved read admitted")
    receipt = approve(service, review)
    assert approve(service, review) == receipt
    second, second_review, second_tokens = connect(consumer)
    assert second_review.connection_id == review.connection_id
    assert second_review.memory_access and second_review.grant_receipt == receipt
    client = oauth.get_client("client_test")
    renewed = oauth.refresh(
        client=client, refresh_token=tokens["refresh_token"], resource=principal.oauth_resource
    )
    with service.memory_transaction(
        oauth.authenticate_access_token(renewed["access_token"]), operation="correct"
    ) as (_, admitted):
        assert admitted.grant_receipt == receipt
    service.disconnect(owner="owner_a", connection_id=review.connection_id, generation=1)
    assert oauth.authenticate_access_token(second_tokens["access_token"]) is None
    assert oauth.authenticate_access_token(renewed["access_token"]) is None
    for stale in (principal, second):
        with pytest.raises(ConsumerConnectionDenied):
            service.prepare(stale)
    with pytest.raises(ConsumerConnectionDenied):
        approve(service, review)
    fresh, new_review, _ = connect(consumer)
    assert new_review.generation == 2 and not new_review.memory_access
    new_receipt = approve(service, new_review)
    assert new_receipt != receipt
    with pytest.raises(ConsumerConnectionDenied, match="Sign in again"):
        service.prepare(dormant)
    # A delayed disconnect retry must not revoke newly reviewed permission.
    service.disconnect(owner="owner_a", connection_id=review.connection_id, generation=1)
    with service.memory_transaction(fresh, operation="read"):
        pass
    assert db.execute_raw("SELECT count(*) AS n FROM consumer_mcp_connections").data[0]["n"] == 1


def test_full_identity_binding_and_operation_boundaries(consumer, monkeypatch):
    service, _, db = consumer
    principal, review, _ = connect(consumer)
    approve(service, review)
    for changed in (
        replace(principal, subject_firebase_uid="owner_b"),
        replace(principal, oauth_client_id="foreign_client"),
        replace(principal, app_id="foreign_app"),
        replace(principal, oauth_resource="https://foreign.test/mcp"),
        replace(principal, auth_source="registry"),
        replace(principal, oauth_grant_type="client_credentials"),
        replace(principal, mcp_execution_mode="catalog_only"),
        replace(principal, schema_profile="agentforce"),
    ):
        with pytest.raises(ConsumerConnectionDenied):
            with service.memory_transaction(changed, operation="read"):
                pytest.fail("foreign authority admitted")
    for operation in ("delete", "share", "send_email", "vault_key"):
        with pytest.raises(ConsumerConnectionDenied):
            with service.memory_transaction(principal, operation=operation):
                pytest.fail("separate action admitted")
    with pytest.raises(ConsumerConnectionDenied):
        approve(service, review, owner="owner_b")
    monkeypatch.setenv("ENVIRONMENT", "production")
    get_app_runtime_settings.cache_clear()
    with pytest.raises(ConsumerConnectionDenied):
        service.prepare(principal)
    monkeypatch.setenv("ENVIRONMENT", "development")
    get_app_runtime_settings.cache_clear()
    db.execute_raw(
        "UPDATE personal_agent_registry SET hushh_id='replacement_deployment' WHERE user_id='owner_a'"
    )
    with pytest.raises(ConsumerConnectionDenied):
        service.prepare(principal)
    assert not ConsentScope.is_external_requestable_scope(ConsentScope.CAP_CONSUMER_MEMORY.value)


def test_generic_revocation_invalidates_bound_credentials_and_preserves_other_owner(consumer):
    service, oauth, db = consumer
    principal, review, tokens = connect(consumer)
    approve(service, review)
    other, other_review, _ = connect(consumer, owner="owner_b")
    approve(service, other_review, owner="owner_b")
    # The generic ledger writer has no knowledge of the new connection service.
    db.execute_raw(
        """INSERT INTO consent_audit
        (token_id,user_id,agent_id,scope,action,issued_at)
        VALUES ('generic-revoke','owner_a',:agent,'cap.consumer.memory','REVOKED',1)""",
        {"agent": f"consumer_mcp:{review.connection_id}:1"},
    )
    assert oauth.authenticate_access_token(tokens["access_token"]) is None
    with pytest.raises(ConsumerConnectionDenied):
        with service.memory_transaction(principal, operation="save"):
            pytest.fail("revoked save admitted")
    with service.memory_transaction(other, operation="read"):
        pass
    events = db.execute_raw(
        "SELECT action,issued_at FROM consent_audit WHERE user_id='owner_a' ORDER BY id"
    ).data
    assert events[1]["issued_at"] > events[0]["issued_at"]
    with pytest.raises(DBAPIError):
        with db.engine.begin() as tx:
            tx.execute(text("DELETE FROM consent_audit WHERE user_id='owner_a'"))


def test_disconnect_rolls_back_if_receipt_cannot_commit(consumer):
    service, _, db = consumer
    principal, review, _ = connect(consumer)
    approve(service, review)
    db.execute_raw("""ALTER TABLE consent_audit ADD CONSTRAINT synthetic_receipt_failure
                      CHECK (action <> 'REVOKED')""")
    with pytest.raises(DBAPIError):
        service.disconnect(owner="owner_a", connection_id=review.connection_id, generation=1)
    with service.memory_transaction(principal, operation="read"):
        pass
    assert service.prepare(principal).generation == 1


def test_revocation_serializes_with_canonical_commit(consumer):
    service, _, db = consumer
    principal, review, _ = connect(consumer)
    approve(service, review)
    db.execute_raw("CREATE TABLE synthetic_commits (id INTEGER PRIMARY KEY)")
    started = Event()

    def revoke():
        started.set()
        service.disconnect(owner="owner_a", connection_id=review.connection_id, generation=1)

    with ThreadPoolExecutor(max_workers=1) as pool:
        with service.memory_transaction(principal, operation="save") as (tx, _):
            tx.execute(text("INSERT INTO synthetic_commits VALUES (1)"))
            future = pool.submit(revoke)
            assert started.wait(3)
            with pytest.raises(TimeoutError):
                future.result(timeout=0.1)
        future.result(timeout=5)
    with pytest.raises(ConsumerConnectionDenied):
        with service.memory_transaction(principal, operation="save") as (tx, _):
            tx.execute(text("INSERT INTO synthetic_commits VALUES (2)"))
    assert db.execute_raw("SELECT count(*) AS n FROM synthetic_commits").data[0]["n"] == 1


def test_missing_fence_expired_token_and_inactive_pod_refuse(consumer):
    service, _, db = consumer
    principal, review, _ = connect(consumer)
    approve(service, review)
    db.execute_raw("ALTER TABLE consent_audit DISABLE TRIGGER zz_consumer_memory_consent")
    with pytest.raises(ConsumerConnectionDenied, match="authority unavailable"):
        service.prepare(principal)
    db.execute_raw("ALTER TABLE consent_audit ENABLE TRIGGER zz_consumer_memory_consent")
    db.execute_raw("UPDATE personal_agent_registry SET status='suspended' WHERE user_id='owner_a'")
    with pytest.raises(ConsumerConnectionDenied, match="setup"):
        service.prepare(principal)
    db.execute_raw(
        "UPDATE personal_agent_registry SET status='provisioned' WHERE user_id='owner_a'"
    )
    db.execute_raw(
        "UPDATE developer_oauth_tokens SET expires_at=1 WHERE id=:id", {"id": principal.token_id}
    )
    with pytest.raises(ConsumerConnectionDenied):
        service.prepare(principal)


def test_owner_api_requires_explicit_policy_and_current_verified_owner(consumer, monkeypatch):
    from api.middleware import require_firebase_auth
    from api.routes import consumer_mcp

    service, _, _ = consumer
    _, review, _ = connect(consumer)
    app = FastAPI()
    app.include_router(consumer_mcp.router)
    app.dependency_overrides[require_firebase_auth] = lambda: "owner_a"
    monkeypatch.setattr(consumer_mcp, "ConsumerMcpConnections", lambda: service)
    client = TestClient(app)
    listing = client.get("/oauth/consumer-connections")
    assert listing.status_code == 200
    assert listing.headers["cache-control"] == "no-store"
    assert listing.json()["items"][0]["connection_id"] == review.connection_id
    assert client.get("/oauth/consumer-connections?limit=101").status_code == 422
    path = f"/oauth/consumer-connections/{review.connection_id}"
    reviewed = client.get(path, params={"authorization_id": review.authorization_id})
    assert reviewed.status_code == 200 and reviewed.json()["memory_access"] is False
    assert reviewed.headers["cache-control"] == "no-store"
    payload = {
        "generation": review.generation,
        "authorization_id": review.authorization_id,
        "policy_version": 1,
        "personal_memory_until_disconnected": True,
    }
    for invalid in (
        {**payload, "user_id": "owner_b"},
        {**payload, "personal_memory_until_disconnected": False},
        {**payload, "policy_version": 2},
    ):
        assert client.post(path + "/approve", json=invalid).status_code == 422
    app.dependency_overrides[require_firebase_auth] = lambda: "owner_b"
    assert client.post(path + "/approve", json=payload).status_code == 403
    app.dependency_overrides[require_firebase_auth] = lambda: "owner_a"
    assert client.post(path + "/approve", json=payload).json()["memory_access"] is True
    revoked = client.delete(path, params={"generation": 1})
    assert revoked.status_code == 204 and not revoked.content
    assert client.post(path + "/approve", json=payload).status_code == 403


@pytest.mark.asyncio
async def test_mcp_dispatch_returns_owner_handoff_without_granting_access(consumer, monkeypatch):
    import mcp_server
    from mcp_modules.developer_context import (
        reset_current_developer_principal,
        set_current_developer_principal,
    )
    from mcp_modules.tools import consumer_tools

    service, _, _ = consumer
    principal, review, _ = connect(consumer)
    monkeypatch.setenv("APP_FRONTEND_ORIGIN", "https://one.example.test")
    get_app_runtime_settings.cache_clear()
    monkeypatch.setattr(consumer_tools, "ConsumerMcpConnections", lambda: service)
    context = set_current_developer_principal(principal)
    try:
        assert "get_hussh_connection" in {tool.name for tool in await mcp_server.list_tools()}
        result = await mcp_server.call_tool("get_hussh_connection", {})
        assert not result.isError
        assert result.structuredContent["state"] == "memory_approval_required"
        assert result.structuredContent["secure_url"].startswith(
            "https://one.example.test/oauth/authorize?"
        )
        assert not service.prepare(principal).memory_access
        rejected = await mcp_server.call_tool(
            "get_hussh_connection", {"owner": "owner_b", "approved": True}
        )
        assert rejected.isError
    finally:
        reset_current_developer_principal(context)
    context = set_current_developer_principal(replace(principal, auth_source="registry"))
    try:
        assert "get_hussh_connection" not in {tool.name for tool in await mcp_server.list_tools()}
        assert (await mcp_server.call_tool("get_hussh_connection", {})).isError
    finally:
        reset_current_developer_principal(context)


@pytest.mark.asyncio
@pytest.mark.parametrize("fail_late", [False, True])
async def test_full_account_erasure_preserves_other_owner_and_rolls_back_atomically(
    consumer, monkeypatch, fail_late
):
    service, oauth, db = consumer
    principal, review, tokens = connect(consumer)
    approve(service, review)
    other, other_review, _ = connect(consumer, owner="owner_b")
    approve(service, other_review, owner="owner_b")
    # Minimal empty legacy tables used unconditionally by the real erasure
    # workflow. No authority, cleanup method or transaction is mocked.
    for table in (
        "actor_profiles",
        "vault_keys",
        "kai_plaid_refresh_runs",
        "kai_plaid_link_sessions",
        "kai_plaid_items",
        "pkm_events",
        "pkm_scope_registry",
        "pkm_manifest_paths",
        "pkm_manifests",
        "pkm_blobs",
        "pkm_index",
    ):
        db.execute_raw(f"CREATE TABLE {table} (user_id TEXT PRIMARY KEY)")
    db.execute_raw(
        "CREATE TABLE ria_client_invites (target_investor_user_id TEXT,accepted_by_user_id TEXT)"
    )
    db.execute_raw("ALTER TABLE developer_apps ADD COLUMN owner_firebase_uid TEXT")
    db.execute_raw("DROP TABLE account_deletion_tombstones")
    migration = Path(__file__).parents[1] / "db/migrations/201_account_deletion_tombstones.sql"
    raw = db.engine.raw_connection()
    try:
        with raw.cursor() as cursor:
            cursor.execute(migration.read_text())
        raw.commit()
    finally:
        raw.close()
    db.execute_raw("INSERT INTO actor_profiles VALUES ('owner_a'),('owner_b')")
    db.execute_raw("INSERT INTO vault_keys VALUES ('owner_a'),('owner_b')")
    # Represents completed external teardown, required by the existing guard.
    db.execute_raw("DELETE FROM personal_agent_registry WHERE user_id='owner_a'")
    if fail_late:
        db.execute_raw("CREATE TABLE synthetic_hold (owner TEXT REFERENCES vault_keys(user_id))")
        db.execute_raw("INSERT INTO synthetic_hold VALUES ('owner_a')")
    monkeypatch.setattr("hushh_mcp.services.account_service.get_db_connection", db.engine.begin)
    outcome = await AccountService()._delete_full_account_transaction(
        "owner_a", requested_target="both"
    )
    assert outcome["success"] is (not fail_late), outcome.get("error")
    for table, column in (
        ("consumer_mcp_connections", "user_id"),
        ("consent_audit", "user_id"),
        ("developer_oauth_authorizations", "subject_firebase_uid"),
        ("developer_oauth_tokens", "subject_firebase_uid"),
    ):
        count = db.execute_raw(f"SELECT count(*) AS n FROM {table} WHERE {column}='owner_a'").data[
            0
        ]["n"]
        assert (count > 0) is fail_late
    assert db.execute_raw("SELECT count(*) AS n FROM account_deletion_tombstones").data[0]["n"] == (
        0 if fail_late else 1
    )
    assert (oauth.authenticate_access_token(tokens["access_token"]) is not None) is fail_late
    with service.memory_transaction(other, operation="read"):
        pass
    if not fail_late:
        with pytest.raises(ConsumerConnectionDenied, match="Owner account unavailable"):
            service.prepare(principal)


def test_connection_discovery_is_owner_scoped_and_preserves_revoked_entry(consumer):
    service, _, _ = consumer
    _, own, _ = connect(consumer)
    _, foreign, _ = connect(consumer, owner="owner_b")
    approve(service, own)
    listing = service.list_connections(owner="owner_a", limit=1)
    assert listing["next_cursor"] is None
    assert listing["items"] == [
        {
            "connection_id": own.connection_id,
            "generation": 1,
            "client_name": "Test assistant",
            "memory_access": True,
        }
    ]
    assert foreign.connection_id not in str(listing)
    assert service.list_connections(owner="owner_a", after=own.connection_id)["items"] == []
    service.disconnect(owner="owner_a", connection_id=own.connection_id, generation=1)
    revoked = service.list_connections(owner="owner_a")["items"][0]
    assert revoked["generation"] == 2 and revoked["memory_access"] is False
    assert set(revoked) == {"connection_id", "generation", "client_name", "memory_access"}
