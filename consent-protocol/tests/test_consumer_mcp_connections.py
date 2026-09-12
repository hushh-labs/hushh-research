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
from hushh_mcp.consent.token import validate_token
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
    raw = engine.raw_connection()
    try:
        with raw.cursor() as cursor:
            for migration_name in (
                "938_consumer_mcp_connections.sql",
                "939_consumer_mcp_runtime_tokens.sql",
            ):
                cursor.execute(
                    (
                        Path(__file__).parents[1] / "db/migrations/parked" / migration_name
                    ).read_text()
                )
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
    assert second_review.grant_token
    valid, reason, claims = validate_token(
        second_review.grant_token, expected_scope=ConsentScope.CAP_CONSUMER_MEMORY
    )
    assert valid, reason
    assert claims is not None
    assert str(claims.agent_id) == f"consumer_mcp:{review.connection_id}:{review.generation}"
    event = db.execute_raw(
        "SELECT action, request_id, token_id, expires_at FROM consent_audit "
        "WHERE user_id='owner_a' AND agent_id=:agent ORDER BY id DESC LIMIT 1",
        {"agent": f"consumer_mcp:{review.connection_id}:{review.generation}"},
    ).data[0]
    assert event["action"] == "CONSUMER_TOKEN_ISSUED"
    assert event["request_id"] == receipt
    assert event["token_id"] == second_review.grant_token
    assert event["expires_at"] > 0
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


def test_current_requires_active_consumer_connection_grant(consumer):
    service, _, _ = consumer
    principal, review, _ = connect(consumer)
    with pytest.raises(ConsumerConnectionDenied, match="approval required"):
        service.current(principal)
    approve(service, review)
    assert service.current(principal).connection_id == review.connection_id


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
    with service.memory_transaction(principal, operation="delete"):
        pass
    for operation in ("share", "send_email", "vault_key"):
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
        assert {
            "read_hussh_memory",
            "save_hussh_memory",
            "correct_hussh_memory",
            "export_hussh_memory",
        }.issubset({tool.name for tool in await mcp_server.list_tools()})
        assert "list_hussh_connections" in {tool.name for tool in await mcp_server.list_tools()}
        assert "open_hussh_email_workflow" in {tool.name for tool in await mcp_server.list_tools()}
        capabilities = await mcp_server.call_tool("list_hussh_capabilities", {})
        assert not capabilities.isError
        projected = {item["name"]: item for item in capabilities.structuredContent["capabilities"]}
        assert projected["read_hussh_memory"]["execution"] == "owner_pod"
        assert projected["delegate_hussh_task"]["execution"] == "owner_pod"
        assert projected["delegate_hussh_task"]["availability"] == "approval_required"
        assert projected["request-consent"]["execution"] == "consent_service"
        assert projected["get_hussh_connection"]["execution"] == "secure_handoff"
        assert projected["list_hussh_integrations"]["execution"] == "consent_service"
        assert projected["connect_hussh_integration"]["execution"] == "secure_handoff"
        assert projected["disconnect_hussh_integration"]["availability"] == "approval_required"
        assert projected["open_hussh_email_workflow"]["execution"] == "secure_handoff"
        assert projected["open_hussh_email_workflow"]["availability"] == "secure_handoff"
        connections = await mcp_server.call_tool("list_hussh_connections", {})
        assert not connections.isError
        assert connections.structuredContent["state"] == "available"
        assert connections.structuredContent["items"][0]["connection_id"] == review.connection_id
        assert connections.structuredContent["items"][0]["memory_access"] is False
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
async def test_consumer_mcp_disconnect_requires_confirmation_and_revokes_only_current_connection(
    consumer, monkeypatch
):
    import mcp_server
    from mcp_modules.developer_context import (
        reset_current_developer_principal,
        set_current_developer_principal,
    )
    from mcp_modules.tools import consumer_tools

    service, _, _ = consumer
    principal, review, _ = connect(consumer)
    approve(service, review)
    monkeypatch.setattr(consumer_tools, "ConsumerMcpConnections", lambda: service)
    context = set_current_developer_principal(principal)
    try:
        refused = await mcp_server.call_tool(
            "disconnect_hussh_connection",
            {"confirm": False, "generation": review.generation},
        )
        assert refused.isError
        assert service.prepare(principal).memory_access

        disconnected = await mcp_server.call_tool(
            "disconnect_hussh_connection",
            {"confirm": True, "generation": review.generation},
        )
        assert not disconnected.isError
        assert disconnected.structuredContent["state"] == "disconnected"
        assert disconnected.structuredContent["connection_id"] == review.connection_id
        with pytest.raises(ConsumerConnectionDenied):
            service.prepare(principal)
    finally:
        reset_current_developer_principal(context)


@pytest.mark.asyncio
async def test_consumer_mcp_delegation_dispatches_through_owner_tool_contract(
    consumer, monkeypatch
):
    import mcp_server
    from mcp_modules.developer_context import (
        reset_current_developer_principal,
        set_current_developer_principal,
    )
    from mcp_modules.tools import consumer_tools

    principal, _, _ = connect(consumer)

    class _Task:
        async def execute(self, _principal, *, arguments):
            assert _principal is principal
            assert arguments["message"] == "hello"
            return {
                "state": "completed",
                "execution_target": "owner_pod",
                "deployment_id": "pod_a",
                "conversation_id": "c1",
                "response": "done",
                "runtime_mode": "owner-pod",
                "provider": "pod",
                "model": "resident-model",
                "delegation": None,
            }

    monkeypatch.setattr(consumer_tools, "ConsumerMcpTask", _Task)
    context = set_current_developer_principal(principal)
    try:
        result = await mcp_server.call_tool("delegate_hussh_task", {"message": "hello"})
    finally:
        reset_current_developer_principal(context)

    assert not result.isError
    assert result.structuredContent["execution_target"] == "owner_pod"
    assert result.structuredContent["provider"] == "pod"


@pytest.mark.asyncio
async def test_consumer_mcp_email_workflow_status_redacts_provider_payloads(consumer, monkeypatch):
    import json

    import mcp_server
    from mcp_modules.developer_context import (
        reset_current_developer_principal,
        set_current_developer_principal,
    )
    from mcp_modules.tools import consumer_tools

    principal, _, _ = connect(consumer)

    class _EmailWorkflows:
        async def list_workflows(self, **kwargs):
            assert kwargs == {
                "user_id": "owner_a",
                "limit": 25,
                "cursor": None,
                "status_filter": None,
                "include_archived": False,
            }
            return {
                "workflows": [
                    {
                        "workflow_id": "wf_1",
                        "status": "needs_confirm",
                        "subject": "Bank reply",
                        "counterparty_label": "Acme",
                        "draft_status": "ready",
                        "send_status": "not_started",
                        "pkm_writeback_status": "pending",
                        "created_at": "2026-09-12T00:00:00Z",
                        "updated_at": "2026-09-12T00:01:00Z",
                        "gmail_thread_id": "raw-thread",
                        "gmail_message_id": "raw-message",
                        "sender_email": "secret@example.com",
                        "snippet": "secret mailbox body",
                        "metadata": {"consent_export": "secret-export"},
                    }
                ],
                "limit": 25,
                "has_more": False,
                "next_cursor": None,
            }

        async def get_workflow(self, **kwargs):
            assert kwargs == {"user_id": "owner_a", "workflow_id": "wf_1"}
            return {
                "workflow_id": "wf_1",
                "status": "needs_confirm",
                "subject": "Bank reply",
                "counterparty_label": "Acme",
                "draft_status": "ready",
                "send_status": "not_started",
                "pkm_writeback_status": "pending",
                "created_at": "2026-09-12T00:00:00Z",
                "updated_at": "2026-09-12T00:01:00Z",
                "gmail_thread_id": "raw-thread",
                "gmail_message_id": "raw-message",
                "sender_email": "secret@example.com",
                "snippet": "secret mailbox body",
                "metadata": {"consent_export": "secret-export"},
            }

    monkeypatch.setattr(consumer_tools, "get_one_email_kyc_service", lambda: _EmailWorkflows())
    monkeypatch.setenv("APP_FRONTEND_ORIGIN", "https://one.example.test")
    get_app_runtime_settings.cache_clear()
    context = set_current_developer_principal(principal)
    try:
        listed = await mcp_server.call_tool("list_hussh_email_workflows", {})
        fetched = await mcp_server.call_tool("get_hussh_email_workflow", {"workflow_id": "wf_1"})
        handoff = await mcp_server.call_tool(
            "open_hussh_email_workflow",
            {"workflow_id": "wf_1", "action": "send"},
        )
    finally:
        reset_current_developer_principal(context)

    assert not listed.isError
    assert listed.structuredContent["items"][0] == {
        "workflow_id": "wf_1",
        "status": "needs_confirm",
        "subject": "Bank reply",
        "counterparty_label": "Acme",
        "draft_status": "ready",
        "send_status": "not_started",
        "pkm_writeback_status": "pending",
        "created_at": "2026-09-12T00:00:00Z",
        "updated_at": "2026-09-12T00:01:00Z",
    }
    assert not fetched.isError
    assert fetched.structuredContent["item"]["workflow_id"] == "wf_1"
    assert not handoff.isError
    assert handoff.structuredContent["state"] == "secure_handoff"
    assert handoff.structuredContent["secure_url"] == (
        "https://one.example.test/one/kyc?workflowId=wf_1&action=send"
    )
    serialized = json.dumps(
        {"listed": listed.structuredContent, "fetched": fetched.structuredContent}
    )
    for secret in (
        "raw-thread",
        "raw-message",
        "secret@example.com",
        "secret mailbox body",
        "secret-export",
    ):
        assert secret not in serialized


@pytest.mark.asyncio
async def test_consumer_mcp_reads_resumable_setup_status_without_starting_a_job(
    consumer, monkeypatch
):
    import mcp_server
    from hushh_mcp.services import byoc_setup_job_service as jobs
    from mcp_modules.developer_context import (
        reset_current_developer_principal,
        set_current_developer_principal,
    )
    from mcp_modules.tools import consumer_tools

    service, _, _ = consumer
    principal, _, _ = connect(consumer)
    monkeypatch.setenv("APP_FRONTEND_ORIGIN", "https://one.example.test")
    get_app_runtime_settings.cache_clear()

    class _Repo:
        async def get(self, user_id):
            assert user_id == "owner_a"
            return {
                "status": "recorded",
                "stage": "awaiting_agent_record",
                "job_id": "setup-job-1",
                "project_id": "owner-project",
                "stages": [
                    {
                        "stage": "applying_iam",
                        "at": "2026-09-11T00:00:00+00:00",
                        "bootstrap_sa": "do-not-return@example.iam.gserviceaccount.com",
                    }
                ],
                "error_code": None,
                "updated_at": "2026-09-11T00:01:00+00:00",
            }

    monkeypatch.setattr(jobs, "ByocSetupJobRepo", _Repo)
    monkeypatch.setattr(jobs, "is_stale", lambda _row: False)
    monkeypatch.setattr(consumer_tools, "ConsumerMcpConnections", lambda: service)
    context = set_current_developer_principal(principal)
    try:
        names = {tool.name for tool in await mcp_server.list_tools()}
        assert "get_hussh_setup_status" in names
        result = await mcp_server.call_tool("get_hussh_setup_status", {})
    finally:
        reset_current_developer_principal(context)

    assert not result.isError
    assert result.structuredContent["state"] == "waiting_for_pod"
    assert result.structuredContent["job_id"] == "setup-job-1"
    assert result.structuredContent["project_id"] == "owner-project"
    assert result.structuredContent["updated_at"] == "2026-09-11T00:01:00+00:00"
    assert result.structuredContent["stages"] == [
        {"stage": "applying_iam", "at": "2026-09-11T00:00:00+00:00"}
    ]
    assert "bootstrap_sa" not in result.structuredContent["stages"][0]


@pytest.mark.asyncio
async def test_consumer_mcp_google_integrations_use_existing_owner_service_boundary(
    consumer, monkeypatch
):
    import mcp_server
    from mcp_modules.developer_context import (
        reset_current_developer_principal,
        set_current_developer_principal,
    )
    from mcp_modules.tools import consumer_tools

    principal, _, _ = connect(consumer)

    class _Google:
        def __init__(self):
            self.disconnected: list[tuple[str, str]] = []

        def status(self, *, user_id, service):
            return {
                "configured": True,
                "connected": service == "calendar",
                "status": "connected" if service == "calendar" else "disconnected",
                "access_level": "manage" if service == "calendar" else None,
            }

        async def start(self, **kwargs):
            assert kwargs["user_id"] == "owner_a"
            assert kwargs["service"] == "gmail"
            assert kwargs["access_level"] == "read"
            assert kwargs["redirect_uri"] is None
            assert kwargs["login_hint"] is None
            return {
                "authorize_url": "https://accounts.google.com/o/oauth2/v2/auth?state=opaque",
                "expires_at": "2026-09-11T00:10:00+00:00",
            }

        def disconnect_service(self, *, user_id, service):
            self.disconnected.append((user_id, service))
            return {"status": "disconnected"}

    google = _Google()
    monkeypatch.setattr(consumer_tools, "GoogleConnectionService", lambda: google)
    context = set_current_developer_principal(principal)
    try:
        names = {tool.name for tool in await mcp_server.list_tools()}
        assert {
            "list_hussh_integrations",
            "connect_hussh_integration",
            "disconnect_hussh_integration",
        }.issubset(names)

        listed = await mcp_server.call_tool("list_hussh_integrations", {})
        assert not listed.isError
        assert listed.structuredContent["state"] == "available"
        assert listed.structuredContent["items"][1] == {
            "service": "calendar",
            "configured": True,
            "connected": True,
            "status": "connected",
            "access_level": "manage",
        }
        assert "google_email" not in listed.structuredContent["items"][0]
        assert "scope_csv" not in listed.structuredContent["items"][0]

        connected = await mcp_server.call_tool("connect_hussh_integration", {"service": "gmail"})
        assert not connected.isError
        assert connected.structuredContent["state"] == "approval_required"
        assert connected.structuredContent["secure_url"].startswith("https://accounts.google.com/")

        refused = await mcp_server.call_tool(
            "disconnect_hussh_integration", {"service": "calendar", "confirm": False}
        )
        assert refused.isError
        assert google.disconnected == []

        disconnected = await mcp_server.call_tool(
            "disconnect_hussh_integration", {"service": "calendar", "confirm": True}
        )
        assert not disconnected.isError
        assert disconnected.structuredContent["state"] == "disconnected"
        assert google.disconnected == [("owner_a", "calendar")]
    finally:
        reset_current_developer_principal(context)


@pytest.mark.asyncio
async def test_consumer_mcp_lists_owner_devices_with_truthful_puppy_readiness(
    consumer, monkeypatch
):
    import mcp_server
    from api.routes.one import puppy_relay
    from mcp_modules.developer_context import (
        reset_current_developer_principal,
        set_current_developer_principal,
    )

    principal, _, _ = connect(consumer)

    class _Devices:
        def list_devices(self, *, user_id):
            assert user_id == "owner_a"
            return [
                {
                    "device_id": "tdv_puppy",
                    "device_name": "Puppy One",
                    "platform": "macos",
                    "status": "active",
                    "last_heartbeat_at": 123,
                    "device_public_key": "must-not-leak",
                },
                {
                    "device_id": "tdv_revoked",
                    "device_name": "Old Puppy",
                    "platform": "macos",
                    "status": "revoked",
                    "last_heartbeat_at": None,
                },
            ]

    class _Broker:
        async def status(self, key):
            assert key == ("owner_a", "tdv_puppy")
            return {
                "connected": True,
                "state": "ready",
                "busy": False,
                "model": "puppy-local",
                "capabilities": {
                    "tool_calling": True,
                    "json_schema": False,
                    "unknown": True,
                },
            }

    monkeypatch.setattr("hushh_mcp.services.trusted_device_service.TrustedDeviceService", _Devices)
    monkeypatch.setattr(puppy_relay, "BROKER", _Broker())
    context = set_current_developer_principal(principal)
    try:
        names = {tool.name for tool in await mcp_server.list_tools()}
        assert "list_hussh_devices" in names
        result = await mcp_server.call_tool("list_hussh_devices", {})
    finally:
        reset_current_developer_principal(context)

    assert not result.isError
    assert result.structuredContent["items"] == [
        {
            "device_id": "tdv_puppy",
            "device_name": "Puppy One",
            "platform": "macos",
            "status": "active",
            "puppy_state": "ready",
            "inference_ready": True,
            "execution_target": "puppy",
            "model": "puppy-local",
            "capabilities": {"tool_calling": True, "json_schema": False},
            "last_heartbeat_at": 123,
        },
        {
            "device_id": "tdv_revoked",
            "device_name": "Old Puppy",
            "platform": "macos",
            "status": "revoked",
            "puppy_state": "revoked",
            "inference_ready": False,
            "execution_target": "unavailable",
            "model": None,
            "capabilities": {},
            "last_heartbeat_at": None,
        },
    ]
    assert "device_public_key" not in str(result.structuredContent)


@pytest.mark.asyncio
async def test_consumer_mcp_exposes_bounded_owner_calendar_reads(consumer, monkeypatch):
    import mcp_server
    from mcp_modules.developer_context import (
        reset_current_developer_principal,
        set_current_developer_principal,
    )

    principal, _, _ = connect(consumer)

    class _Calendar:
        async def list_events(self, **kwargs):
            assert kwargs == {
                "user_id": "owner_a",
                "start_at": "2026-09-12T09:00:00Z",
                "end_at": "2026-09-12T17:00:00Z",
                "max_results": 10,
            }
            return {
                "events": [
                    {
                        "id": "event-1",
                        "etag": "etag-1",
                        "title": "Planning",
                        "description": "private detail",
                        "location": "Remote",
                        "start": {"dateTime": "2026-09-12T10:00:00Z", "timeZone": "UTC"},
                        "end": {"dateTime": "2026-09-12T11:00:00Z", "timeZone": "UTC"},
                        "status": "confirmed",
                        "attendees": [
                            {"email": "owner@example.test", "response_status": "accepted"}
                        ],
                        "html_link": "https://calendar.google.test/event-1",
                        "updated": "2026-09-11T20:00:00Z",
                    }
                ],
                "time_zone": "UTC",
                "has_more": False,
            }

        async def find_openings(self, **kwargs):
            assert kwargs == {
                "user_id": "owner_a",
                "start_at": "2026-09-12T09:00:00Z",
                "end_at": "2026-09-12T17:00:00Z",
                "duration_minutes": 30,
                "limit": 2,
                "calendar_ids": ["primary"],
            }
            return {
                "time_min": "2026-09-12T09:00:00Z",
                "time_max": "2026-09-12T17:00:00Z",
                "time_zone": "UTC",
                "duration_minutes": 30,
                "openings": [
                    {
                        "start_at": "2026-09-12T09:00:00Z",
                        "end_at": "2026-09-12T09:30:00Z",
                        "available_until": "2026-09-12T10:00:00Z",
                    }
                ],
            }

    monkeypatch.setattr(
        "mcp_modules.tools.consumer_tools.get_google_calendar_service", lambda: _Calendar()
    )
    context = set_current_developer_principal(principal)
    try:
        names = {tool.name for tool in await mcp_server.list_tools()}
        assert {"list_hussh_calendar_events", "find_hussh_calendar_openings"}.issubset(names)
        events = await mcp_server.call_tool(
            "list_hussh_calendar_events",
            {
                "start_at": "2026-09-12T09:00:00Z",
                "end_at": "2026-09-12T17:00:00Z",
                "max_results": 10,
            },
        )
        openings = await mcp_server.call_tool(
            "find_hussh_calendar_openings",
            {
                "start_at": "2026-09-12T09:00:00Z",
                "end_at": "2026-09-12T17:00:00Z",
                "duration_minutes": 30,
                "limit": 2,
                "calendar_ids": ["primary"],
            },
        )
    finally:
        reset_current_developer_principal(context)

    assert not events.isError
    assert events.structuredContent["events"][0]["title"] == "Planning"
    assert events.structuredContent["events"][0]["start"]["date_time"] == ("2026-09-12T10:00:00Z")
    assert not openings.isError
    assert openings.structuredContent["openings"][0]["start_at"] == "2026-09-12T09:00:00Z"


@pytest.mark.asyncio
async def test_consumer_mcp_calendar_refuses_invalid_arguments_without_provider_call(
    consumer, monkeypatch
):
    import mcp_server
    from mcp_modules.developer_context import (
        reset_current_developer_principal,
        set_current_developer_principal,
    )

    principal, _, _ = connect(consumer)

    class _Calendar:
        async def list_events(self, **_kwargs):
            raise AssertionError("provider must not receive invalid input")

    monkeypatch.setattr(
        "mcp_modules.tools.consumer_tools.get_google_calendar_service", lambda: _Calendar()
    )
    context = set_current_developer_principal(principal)
    try:
        result = await mcp_server.call_tool(
            "list_hussh_calendar_events",
            {
                "start_at": "2026-09-12T09:00:00Z",
                "end_at": "2026-09-12T17:00:00Z",
                "user_id": "owner_b",
            },
        )
    finally:
        reset_current_developer_principal(context)

    assert result.isError
    assert result.content[0].text is not None
    assert "owner_b" not in result.content[0].text


@pytest.mark.asyncio
async def test_consumer_mcp_exposes_masked_owner_people_and_connections(consumer, monkeypatch):
    import mcp_server
    from mcp_modules.developer_context import (
        reset_current_developer_principal,
        set_current_developer_principal,
    )

    principal, _, _ = connect(consumer)

    class _Connections:
        def search_directory(self, owner, **kwargs):
            assert owner == "owner_a"
            assert kwargs == {"query": "sam", "page": 1, "limit": 2, "audience": "people"}
            return {
                "items": [
                    {
                        "userId": "raw-user-id",
                        "publicPersonRef": "person_public_1",
                        "displayName": "Sam Example",
                        "email": "sam@example.test",
                        "maskedEmail": "s***@example.test",
                        "maskedPhone": "•••-•••-1234",
                        "relationship": "none",
                        "isRia": False,
                    }
                ],
                "page": 1,
                "hasMore": False,
            }

        def list_connections_page(self, owner, **kwargs):
            assert owner == "owner_a"
            assert kwargs == {"query": "", "page": 1, "limit": 50, "audience": "all"}
            return {
                "items": [
                    {
                        "connectionId": "raw-connection-id",
                        "userId": "raw-user-id",
                        "publicPersonRef": "person_public_1",
                        "displayName": "Sam Example",
                        "email": "sam@example.test",
                        "isRia": True,
                    }
                ],
                "page": 1,
                "hasMore": False,
            }

    monkeypatch.setattr("hushh_mcp.services.connections_service.ConnectionsService", _Connections)
    context = set_current_developer_principal(principal)
    try:
        names = {tool.name for tool in await mcp_server.list_tools()}
        assert {"search_hussh_people", "list_hussh_people_connections"}.issubset(names)
        search = await mcp_server.call_tool(
            "search_hussh_people",
            {"query": "sam", "page": 1, "limit": 2, "audience": "people"},
        )
        connected = await mcp_server.call_tool("list_hussh_people_connections", {})
    finally:
        reset_current_developer_principal(context)

    assert not search.isError
    assert search.structuredContent["items"] == [
        {
            "public_person_ref": "person_public_1",
            "display_name": "Sam Example",
            "masked_email": "s***@example.test",
            "masked_phone": "•••-•••-1234",
            "relationship": "none",
            "is_ria": False,
        }
    ]
    assert not connected.isError
    assert connected.structuredContent["items"][0]["relationship"] == "connected"
    assert connected.structuredContent["items"][0]["is_ria"] is True
    assert "raw-user-id" not in str(connected.structuredContent)
    assert "raw-connection-id" not in str(connected.structuredContent)
    assert "sam@example.test" not in str(search.structuredContent)


@pytest.mark.asyncio
async def test_consumer_mcp_people_rejects_unbounded_or_injected_arguments(consumer, monkeypatch):
    import mcp_server
    from mcp_modules.developer_context import (
        reset_current_developer_principal,
        set_current_developer_principal,
    )

    principal, _, _ = connect(consumer)

    class _Connections:
        def search_directory(self, *_args, **_kwargs):
            raise AssertionError("directory must not receive invalid input")

    monkeypatch.setattr("hushh_mcp.services.connections_service.ConnectionsService", _Connections)
    context = set_current_developer_principal(principal)
    try:
        result = await mcp_server.call_tool(
            "search_hussh_people",
            {"query": "x", "user_id": "owner_b"},
        )
    finally:
        reset_current_developer_principal(context)

    assert result.isError
    assert "owner_b" not in result.content[0].text


@pytest.mark.asyncio
async def test_consumer_mcp_person_profile_is_viewer_relative_and_bounded(consumer, monkeypatch):
    import mcp_server
    from mcp_modules.developer_context import (
        reset_current_developer_principal,
        set_current_developer_principal,
    )

    principal, _, _ = connect(consumer)
    person_ref = "22222222-2222-4222-8222-222222222222"

    class _Profile:
        async def get_viewer_profile(self, **kwargs):
            assert kwargs == {"viewer_user_id": "owner_a", "public_person_ref": person_ref}
            return {
                "personRef": person_ref,
                "displayName": "Sam Example",
                "photoUrl": "https://cdn.example.test/sam.png",
                "verifiedRole": "Registered investment adviser",
                "relationship": {
                    "status": "connected",
                    "connectionId": "raw-connection-id",
                    "requestId": "raw-request-id",
                },
                "requestableScopes": [
                    {
                        "scopeRef": "scope-ref-1",
                        "label": "Public profile",
                        "description": "A public profile projection.",
                        "domain": "profile",
                        "sensitivity": "low",
                        "wildcard": False,
                    }
                ],
                "grants": [
                    {
                        "scopeRef": "scope-ref-1",
                        "label": "Public profile",
                        "domain": "profile",
                        "status": "granted",
                        "requestId": "raw-grant-request-id",
                        "expiresAt": 1_800_000_000_000,
                    }
                ],
            }

    monkeypatch.setattr("hushh_mcp.services.person_profile_service.PersonProfileService", _Profile)
    context = set_current_developer_principal(principal)
    try:
        names = {tool.name for tool in await mcp_server.list_tools()}
        assert "get_hussh_person_profile" in names
        result = await mcp_server.call_tool(
            "get_hussh_person_profile", {"public_person_ref": person_ref}
        )
        invalid = await mcp_server.call_tool(
            "get_hussh_person_profile", {"public_person_ref": "not-a-uuid"}
        )
    finally:
        reset_current_developer_principal(context)

    assert not result.isError
    assert result.structuredContent["relationship"] == "connected"
    assert result.structuredContent["requestable_scopes"][0]["scope_ref"] == "scope-ref-1"
    assert result.structuredContent["grants"][0]["expires_at"] == 1_800_000_000_000
    assert "raw-connection-id" not in str(result.structuredContent)
    assert "raw-request-id" not in str(result.structuredContent)
    assert "raw-grant-request-id" not in str(result.structuredContent)
    assert invalid.isError


@pytest.mark.asyncio
async def test_consumer_mcp_exposes_sanitized_gmail_receipts_and_status(consumer, monkeypatch):
    import mcp_server
    from mcp_modules.developer_context import (
        reset_current_developer_principal,
        set_current_developer_principal,
    )

    principal, _, _ = connect(consumer)

    class _Gmail:
        async def list_receipts(self, **kwargs):
            assert kwargs == {"user_id": "owner_a", "page": 2, "per_page": 2}
            return {
                "items": [
                    {
                        "merchant_name": "Example Store",
                        "amount": "42.50",
                        "currency": "USD",
                        "receipt_date": "2026-09-12",
                        "order_id": "order-123",
                        "subject": "Your receipt",
                        "gmail_message_id": "must-not-leak",
                        "from_email": "store@example.test",
                        "snippet": "private mailbox body",
                    }
                ],
                "page": 2,
                "per_page": 2,
                "total": 3,
                "has_more": True,
            }

        async def get_status(self, **kwargs):
            assert kwargs == {"user_id": "owner_a"}
            return {
                "connected": True,
                "status": "connected",
                "connection_state": "connected",
                "sync_state": "healthy",
                "last_sync_status": "completed",
                "last_sync_at": "2026-09-12T10:00:00Z",
                "receipt_counts": {"total": 3},
                "google_email": "owner@example.test",
                "scope_csv": "mail.google.com",
            }

    monkeypatch.setattr(
        "hushh_mcp.services.gmail_receipts_service.get_gmail_receipts_service",
        lambda: _Gmail(),
    )
    context = set_current_developer_principal(principal)
    try:
        names = {tool.name for tool in await mcp_server.list_tools()}
        assert {"list_hussh_gmail_receipts", "get_hussh_gmail_status"}.issubset(names)
        receipts = await mcp_server.call_tool(
            "list_hussh_gmail_receipts", {"page": 2, "per_page": 2}
        )
        status = await mcp_server.call_tool("get_hussh_gmail_status", {})
    finally:
        reset_current_developer_principal(context)

    assert not receipts.isError
    assert receipts.structuredContent["items"][0] == {
        "merchant": "Example Store",
        "amount": "42.50",
        "currency": "USD",
        "receipt_date": "2026-09-12",
        "order_id": "order-123",
        "subject": "Your receipt",
    }
    assert "gmail_message_id" not in str(receipts.structuredContent)
    assert "private mailbox body" not in str(receipts.structuredContent)
    assert not status.isError
    assert status.structuredContent["receipt_count"] == 3
    assert "owner@example.test" not in str(status.structuredContent)
    assert "scope_csv" not in str(status.structuredContent)


@pytest.mark.asyncio
async def test_consumer_mcp_gmail_rejects_invalid_page_before_service_call(consumer, monkeypatch):
    import mcp_server
    from mcp_modules.developer_context import (
        reset_current_developer_principal,
        set_current_developer_principal,
    )

    principal, _, _ = connect(consumer)

    class _Gmail:
        async def list_receipts(self, **_kwargs):
            raise AssertionError("Gmail service must not receive invalid input")

    monkeypatch.setattr(
        "hushh_mcp.services.gmail_receipts_service.get_gmail_receipts_service",
        lambda: _Gmail(),
    )
    context = set_current_developer_principal(principal)
    try:
        result = await mcp_server.call_tool(
            "list_hussh_gmail_receipts", {"page": 0, "per_page": 101}
        )
    finally:
        reset_current_developer_principal(context)

    assert result.isError


@pytest.mark.asyncio
async def test_consumer_mcp_lists_connection_requests_without_scope_or_identity_leaks(
    consumer, monkeypatch
):
    import mcp_server
    from mcp_modules.developer_context import (
        reset_current_developer_principal,
        set_current_developer_principal,
    )

    principal, _, _ = connect(consumer)

    class _Connections:
        def list_requests(self, owner, **kwargs):
            assert owner == "owner_a"
            assert kwargs == {"direction": "incoming", "include_resolved": False}
            return [
                {
                    "id": "request-opaque",
                    "requesterUserId": "raw-requester",
                    "addresseeUserId": "owner_a",
                    "counterpartDisplayName": "Sam Example",
                    "status": "pending",
                    "message": "Let's connect",
                    "createdAt": "2026-09-12T10:00:00Z",
                    "scopes": [{"scope": "attr.secret.private"}],
                }
            ]

    monkeypatch.setattr("hushh_mcp.services.connections_service.ConnectionsService", _Connections)
    context = set_current_developer_principal(principal)
    try:
        names = {tool.name for tool in await mcp_server.list_tools()}
        assert "list_hussh_connection_requests" in names
        result = await mcp_server.call_tool(
            "list_hussh_connection_requests", {"direction": "incoming"}
        )
    finally:
        reset_current_developer_principal(context)

    assert not result.isError
    assert result.structuredContent["items"] == [
        {
            "request_id": "request-opaque",
            "direction": "incoming",
            "status": "pending",
            "counterpart_display_name": "Sam Example",
            "message": "Let's connect",
            "created_at": "2026-09-12T10:00:00Z",
            "scope_count": 1,
        }
    ]
    assert "raw-requester" not in str(result.structuredContent)
    assert "attr.secret.private" not in str(result.structuredContent)


@pytest.mark.asyncio
async def test_consumer_mcp_connection_request_review_and_mutations_are_confirmed_and_bounded(
    consumer, monkeypatch
):
    import mcp_server
    from mcp_modules.developer_context import (
        reset_current_developer_principal,
        set_current_developer_principal,
    )

    principal, _, _ = connect(consumer)
    request_id = "11111111-1111-4111-8111-111111111111"

    class _Connections:
        def list_requests(self, owner, **kwargs):
            assert owner == "owner_a"
            assert kwargs == {"direction": "incoming", "include_resolved": True}
            return [
                {
                    "id": request_id,
                    "counterpartDisplayName": "Sam Example",
                    "status": "pending",
                    "message": "Let's connect",
                    "createdAt": "2026-09-12T10:00:00Z",
                }
            ]

        def get_scope_proposal_history(self, owner, supplied_request_id):
            assert owner == "owner_a"
            assert supplied_request_id == request_id
            return {
                "items": [
                    {
                        "scopeHandle": "scope.public.profile",
                        "direction": "requested",
                        "label": "Public profile",
                        "description": "A public profile projection.",
                        "status": "pending",
                        "createdAt": "2026-09-12T10:00:00Z",
                        "expiresAt": "2026-09-13T10:00:00Z",
                    }
                ]
            }

        def create_request(self, owner, **kwargs):
            assert owner == "owner_a"
            assert kwargs == {
                "query": "sam",
                "message": "Let's connect",
                "requested_scope_handles": ["scope.public.profile"],
                "offered_scope_handles": [],
            }
            return {"id": request_id, "status": "pending"}

        def accept_request(self, owner, supplied_request_id, **kwargs):
            assert owner == "owner_a"
            assert supplied_request_id == request_id
            assert kwargs == {
                "selected_requested_scope_handles": ["scope.public.profile"],
                "selected_offered_scope_handles": [],
            }
            return {
                "requestId": request_id,
                "connectionId": "connection-opaque",
                "scopeResults": [
                    {
                        "scopeHandle": "scope.public.profile",
                        "direction": "requested",
                        "status": "active",
                        "activated": True,
                    }
                ],
            }

        def reject_request(self, owner, supplied_request_id):
            assert owner == "owner_a" and supplied_request_id == request_id
            return {"status": "rejected", "requestId": request_id}

        def cancel_request(self, owner, supplied_request_id):
            assert owner == "owner_a" and supplied_request_id == request_id
            return {"status": "cancelled", "requestId": request_id}

    monkeypatch.setattr("hushh_mcp.services.connections_service.ConnectionsService", _Connections)
    context = set_current_developer_principal(principal)
    try:
        names = {tool.name for tool in await mcp_server.list_tools()}
        assert {
            "get_hussh_connection_request",
            "send_hussh_connection_request",
            "accept_hussh_connection_request",
            "reject_hussh_connection_request",
            "cancel_hussh_connection_request",
        }.issubset(names)
        detail = await mcp_server.call_tool(
            "get_hussh_connection_request", {"request_id": request_id}
        )
        sent = await mcp_server.call_tool(
            "send_hussh_connection_request",
            {
                "query": "sam",
                "message": "Let's connect",
                "requested_scope_handles": ["scope.public.profile"],
                "offered_scope_handles": [],
                "confirm": True,
            },
        )
        accepted = await mcp_server.call_tool(
            "accept_hussh_connection_request",
            {
                "request_id": request_id,
                "selected_requested_scope_handles": ["scope.public.profile"],
                "selected_offered_scope_handles": [],
                "confirm": True,
            },
        )
        rejected = await mcp_server.call_tool(
            "reject_hussh_connection_request", {"request_id": request_id, "confirm": True}
        )
        cancelled = await mcp_server.call_tool(
            "cancel_hussh_connection_request", {"request_id": request_id, "confirm": True}
        )
        refused = await mcp_server.call_tool(
            "reject_hussh_connection_request", {"request_id": request_id, "confirm": False}
        )
    finally:
        reset_current_developer_principal(context)

    assert not detail.isError
    assert detail.structuredContent["scopes"][0]["label"] == "Public profile"
    assert not sent.isError and sent.structuredContent["status"] == "pending"
    assert not accepted.isError and accepted.structuredContent["status"] == "accepted"
    assert accepted.structuredContent["scope_results"][0]["activated"] is True
    assert not rejected.isError and rejected.structuredContent["status"] == "rejected"
    assert not cancelled.isError and cancelled.structuredContent["status"] == "cancelled"
    assert refused.isError
    assert "raw" not in str(detail.structuredContent).lower()


def test_receipts_are_bounded_non_bearer_owner_audit_records(consumer):
    service, _, _ = consumer
    principal, review, _ = connect(consumer)
    receipt = approve(service, review)
    rows = service.list_receipts(principal)
    assert len(rows["items"]) == 2
    assert rows["items"][0]["action"] == "CONSUMER_TOKEN_ISSUED"
    assert rows["items"][1]["action"] == "CONSENT_GRANTED"
    assert rows["items"][1]["receipt_id"] == receipt
    assert all("token_id" not in item for item in rows["items"])


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


def test_connection_discovery_does_not_report_an_expired_runtime_token_as_ready(
    consumer, monkeypatch
):
    service, _, _ = consumer
    _, own, _ = connect(consumer)
    approve(service, own)
    # The ledger is append-only, so advance the authority clock and keep the
    # signed-token verifier positive to isolate the canonical ledger-expiry
    # check in `_grant_state`.
    import hushh_mcp.services.consumer_mcp_connections as connections_module

    now = connections_module.time.time()
    monkeypatch.setattr(connections_module.time, "time", lambda: now + 3600)
    monkeypatch.setattr(
        connections_module,
        "validate_token",
        lambda *_args, **_kwargs: (True, None, object()),
    )
    listing = service.list_connections(owner="owner_a")
    assert listing["items"][0]["memory_access"] is False


def test_connection_discovery_rejects_a_valid_token_bound_to_another_subject(consumer, monkeypatch):
    service, _, _ = consumer
    _, own, _ = connect(consumer)
    approve(service, own)
    from types import SimpleNamespace

    monkeypatch.setattr(
        "hushh_mcp.services.consumer_mcp_connections.validate_token",
        lambda *_args, **_kwargs: (
            True,
            None,
            SimpleNamespace(
                user_id="owner_b",
                agent_id=f"consumer_mcp:{own.connection_id}:{own.generation}",
                scope_str=ConsentScope.CAP_CONSUMER_MEMORY.value,
            ),
        ),
    )
    listing = service.list_connections(owner="owner_a")
    assert listing["items"][0]["memory_access"] is False
