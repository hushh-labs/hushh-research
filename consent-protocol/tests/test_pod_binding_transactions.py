"""Real PostgreSQL serialization of binding publication and device revocation."""

from __future__ import annotations

import asyncio
import json
import threading
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import pytest
from sqlalchemy import create_engine, event, text

from db.db_client import DatabaseClient
from hushh_mcp.services.personal_agent_direct_admission import record_binding, record_endpoint
from hushh_mcp.services.trusted_device_service import PostgresTrustedDeviceStore
from tests.pkm_conformance import postgres_harness

pytestmark = pytest.mark.skipif(
    postgres_harness.find_pg_bin() is None, reason="PostgreSQL unavailable"
)


@pytest.fixture(scope="module")
def pg():
    old = postgres_harness.MIGRATIONS
    postgres_harness.MIGRATIONS = []
    server = postgres_harness.TempPostgres()
    try:
        server.start()
        base = Path(__file__).resolve().parents[1] / "db/migrations"
        for name in (
            "parked/900_personal_agent_registry.sql",
            "parked/906_personal_agent_user_cloud.sql",
            "121_trusted_devices.sql",
        ):
            server.apply_file(base / name)
        server.execute("CREATE TABLE agent_chat_conversations (id UUID PRIMARY KEY)")
        server.execute(
            "CREATE TABLE one_adk_sessions (app_name TEXT, user_id TEXT, session_id TEXT, PRIMARY KEY(app_name,user_id,session_id))"
        )
        for name in (
            "114_one_action_directive_ledger.sql",
            "248_adk_chat_action_authority.sql",
            "parked/945_pod_mcp_action_authority.sql",
        ):
            server.apply_file(base / name)
        yield server
    finally:
        postgres_harness.MIGRATIONS = old
        server.stop()


@pytest.fixture
def db(pg):
    engine = create_engine(f"postgresql+psycopg2://hushh@/postgres?host={pg.dir}&port={pg.port}")
    with engine.begin() as conn:
        conn.execute(text("DELETE FROM one_action_directive_ledger"))
        conn.execute(text("DELETE FROM trusted_devices"))
        conn.execute(text("DELETE FROM personal_agent_registry"))
        conn.execute(
            text(
                "INSERT INTO personal_agent_registry (user_id,hushh_id,status,deployment_target,user_cloud_project,pod_key_id,pod_pubkey,backend_metadata) VALUES ('u','ha1_test','provisioned','user_gcp','synthetic-project','podk_test','public',CAST(:meta AS jsonb))"
            ),
            {
                "meta": json.dumps(
                    {
                        "url": "https://pod.example",
                        "serviceUid": "uid-1",
                        "runtime_service_account": "pod@synthetic.iam.gserviceaccount.com",
                        "ingress": "direct",
                        "directReadiness": {
                            "verified": True,
                            "serviceUid": "uid-1",
                            "podKeyId": "podk_test",
                            "url": "https://pod.example",
                        },
                        "bindings": {"other": {"version": 9}},
                        "retained": "keep",
                    }
                )
            },
        )
        conn.execute(
            text(
                "INSERT INTO trusted_devices (device_id,user_id,device_public_key,device_name,platform,created_at) VALUES ('tdv_test','u','device-public','Synthetic','web',1)"
            )
        )
    yield DatabaseClient(engine)
    engine.dispose()


def record(version=1):
    return {
        "version": version,
        "serviceUid": "uid-1",
        "envelope": {
            "binding": {
                "user_id": "u",
                "subject_id": "tdv_test",
                "subject_public_key": "device-public",
                "platform": "web",
                "hushh_id": "ha1_test",
                "deployment_target": "user_gcp",
                "pod_key_id": "podk_test",
                "pod_public_key": "public",
                "url": "https://pod.example",
                "version": version,
            }
        },
    }


def issue(db, version=1):
    return asyncio.run(
        record_binding(db, user_id="u", device_id="tdv_test", record=record(version))
    )


def revoke(db):
    store = PostgresTrustedDeviceStore.__new__(PostgresTrustedDeviceStore)
    store._db = db
    return store.revoke_device(user_id="u", device_id="tdv_test", now_ms=2)


def publish_endpoint(db, url="https://pod.example"):
    return asyncio.run(
        record_endpoint(
            db,
            user_id="u",
            hushh_id="ha1_test",
            pod_key_id="podk_test",
            pod_public_key="public",
            service_uid="uid-1",
            url=url,
        )
    )


def test_simultaneous_endpoint_discovery_reuses_one_committed_version(db):
    with ThreadPoolExecutor(max_workers=2) as pool:
        results = list(pool.map(lambda _: publish_endpoint(db), range(2)))
    assert results == [{"version": 1, "url": "https://pod.example", "podKeyId": "podk_test"}] * 2
    with db.engine.connect() as conn:
        meta = conn.execute(
            text("SELECT backend_metadata FROM personal_agent_registry WHERE user_id='u'")
        ).scalar_one()
    assert meta["retained"] == "keep"
    assert meta["bindings"]["other"] == {"version": 9}


@pytest.mark.parametrize("change", ["replacement", "readiness", "deleted"])
def test_waiting_discovery_cannot_publish_after_authority_changes(db, change):
    assert publish_endpoint(db)["version"] == 1
    reached_lock = threading.Event()

    def observe(_conn, _cursor, statement, _params, _context, _many):
        if statement.startswith("SELECT hushh_id"):
            reached_lock.set()

    event.listen(db.engine, "before_cursor_execute", observe)
    try:
        with db.engine.begin() as conn, ThreadPoolExecutor(max_workers=1) as pool:
            if change == "replacement":
                conn.execute(
                    text(
                        "UPDATE personal_agent_registry SET backend_metadata = jsonb_set(jsonb_set(backend_metadata, '{url}', '\"https://new-pod.example\"'), '{directReadiness,url}', '\"https://new-pod.example\"') WHERE user_id='u'"
                    )
                )
            elif change == "readiness":
                conn.execute(
                    text(
                        "UPDATE personal_agent_registry SET backend_metadata = jsonb_set(backend_metadata, '{directReadiness,verified}', 'false') WHERE user_id='u'"
                    )
                )
            else:
                conn.execute(text("DELETE FROM personal_agent_registry WHERE user_id='u'"))
            result = pool.submit(publish_endpoint, db)
            assert reached_lock.wait(5)
            conn.commit()
            assert result.result(timeout=5) is None
        if change == "replacement":
            assert publish_endpoint(db, "https://new-pod.example")["version"] == 2
            assert publish_endpoint(db) is None
            assert publish_endpoint(db, "https://new-pod.example")["version"] == 2
    finally:
        event.remove(db.engine, "before_cursor_execute", observe)


def test_competing_issuers_publish_one_version_and_preserve_other_metadata(db):
    with ThreadPoolExecutor(max_workers=2) as pool:
        assert sorted(pool.map(lambda _: issue(db), range(2))) == [False, True]
    assert issue(db, 2)
    with db.engine.connect() as conn:
        meta = conn.execute(
            text("SELECT backend_metadata FROM personal_agent_registry WHERE user_id='u'")
        ).scalar_one()
    assert meta["bindings"]["tdv_test"]["version"] == 2
    assert meta["bindings"]["other"] == {"version": 9}
    assert meta["retained"] == "keep"


def test_revocation_commit_while_issuer_waits_prevents_publication(db):
    reached_device = threading.Event()

    def observe(_conn, _cursor, statement, _params, _context, _many):
        if statement.startswith("SELECT device_public_key"):
            reached_device.set()

    event.listen(db.engine, "before_cursor_execute", observe)
    try:
        with db.engine.connect() as conn, ThreadPoolExecutor(max_workers=1) as pool:
            tx = conn.begin()
            conn.execute(
                text("UPDATE trusted_devices SET status='revoked' WHERE device_id='tdv_test'")
            )
            result = pool.submit(issue, db)
            assert reached_device.wait(5)
            tx.commit()
            assert result.result(timeout=5) is False
    finally:
        event.remove(db.engine, "before_cursor_execute", observe)


def test_issuer_commit_precedes_waiting_revoke_and_ceiling_is_retained(db):
    publishing = threading.Event()
    release = threading.Event()
    revoking = threading.Event()

    def hold(_conn, _cursor, statement, _params, _context, _many):
        if statement.startswith("UPDATE personal_agent_registry"):
            publishing.set()
            assert release.wait(5)
        elif statement.startswith("UPDATE trusted_devices"):
            revoking.set()

    event.listen(db.engine, "before_cursor_execute", hold)
    try:
        with ThreadPoolExecutor(max_workers=2) as pool:
            issued = pool.submit(issue, db)
            assert publishing.wait(5)
            revoked = pool.submit(revoke, db)
            assert revoking.wait(5)
            release.set()
            assert issued.result(timeout=5) is True
            assert revoked.result(timeout=5) is True
        assert issue(db, 2) is False
        with db.engine.connect() as conn:
            assert (
                conn.execute(
                    text(
                        "SELECT backend_metadata->'bindings'->'tdv_test'->>'version' FROM personal_agent_registry WHERE user_id='u'"
                    )
                ).scalar_one()
                == "1"
            )
    finally:
        release.set()
        event.remove(db.engine, "before_cursor_execute", hold)


@pytest.mark.parametrize("changed", ["key", "pod", "erasure"])
def test_changed_authority_refuses_signed_candidate(db, changed):
    with db.engine.begin() as conn:
        if changed == "key":
            conn.execute(text("UPDATE trusted_devices SET device_public_key='replaced'"))
        elif changed == "pod":
            conn.execute(text("UPDATE personal_agent_registry SET pod_key_id='replaced'"))
        else:
            conn.execute(
                text(
                    "UPDATE personal_agent_registry SET backend_metadata=backend_metadata || '{\"erasure\":{}}'::jsonb"
                )
            )
    assert issue(db) is False


def test_canonical_trailing_slash_url_is_accepted(db):
    with db.engine.begin() as conn:
        conn.execute(
            text(
                "UPDATE personal_agent_registry SET backend_metadata=jsonb_set(backend_metadata,'{url}','\" https://pod.example/ \"'::jsonb)"
            )
        )
    assert issue(db)


def test_database_failure_is_sanitized():
    from contextlib import contextmanager
    from types import SimpleNamespace

    from sqlalchemy.exc import OperationalError

    from db.db_client import DatabaseExecutionError

    @contextmanager
    def unavailable():
        raise OperationalError(
            "synthetic SQL", {"sensitive": "must-not-leak"}, Exception("driver details")
        )
        yield

    broken = SimpleNamespace(engine=SimpleNamespace(begin=unavailable))
    with pytest.raises(DatabaseExecutionError) as caught:
        issue(broken)
    assert caught.value.code == "POD_BINDING_STORAGE_UNAVAILABLE"
    assert "must-not-leak" not in str(caught.value)
    assert caught.value.__suppress_context__ is True


def test_courier_acknowledgment_preserves_concurrent_append_and_unknown_entries(db):
    from hushh_mcp.services.personal_agent_registry_repo import PersonalAgentRegistryRepo

    repo = PersonalAgentRegistryRepo()
    repo._db = lambda: db
    a = {"intent": {"intentId": "a"}}
    b = {"intent": {"intentId": "b"}}
    asyncio.run(repo.append_pending_tombstone(user_id="u", entry=a))
    clearing = threading.Event()

    def observe(conn, cursor, statement, parameters, context, executemany):
        if "jsonb_agg(item ORDER BY ordinal)" in statement:
            clearing.set()

    event.listen(db.engine, "before_cursor_execute", observe)
    try:
        with ThreadPoolExecutor(max_workers=1) as pool:
            with db.engine.begin() as conn:
                # Hold the row with an append that has not committed when clear
                # starts. Its UPDATE must filter the row after our commit.
                conn.execute(
                    text(
                        "UPDATE personal_agent_registry SET backend_metadata = "
                        "jsonb_set(backend_metadata, '{pendingTombstones}', "
                        "backend_metadata->'pendingTombstones' || CAST(:entries AS jsonb)) "
                        "WHERE user_id='u'"
                    ),
                    {"entries": json.dumps([b, {"unknown": True}])},
                )
                future = pool.submit(
                    lambda: asyncio.run(
                        repo.clear_pending_tombstones(hushh_id="ha1_test", intent_ids=["a"])
                    )
                )
                assert clearing.wait(5)
            future.result(timeout=5)
        row = asyncio.run(repo.get("u"))
        assert row["backend_metadata"]["pendingTombstones"] == [b, {"unknown": True}]
        assert row["backend_metadata"]["retained"] == "keep"
        asyncio.run(repo.clear_pending_tombstones(hushh_id="ha1_test", intent_ids=["a"]))
        assert asyncio.run(repo.get("u"))["backend_metadata"] == row["backend_metadata"]
    finally:
        event.remove(db.engine, "before_cursor_execute", observe)


def test_private_mcp_ledger_binds_exact_terms_and_consumes_once_without_hub_history(
    db, monkeypatch
):
    from hushh_mcp.services import pod_binding_service, pod_mcp_approval
    from hushh_mcp.services.action_directive_ledger import (
        ActionDirectiveAuthorityError,
        ActionDirectiveStore,
    )

    monkeypatch.setattr(pod_binding_service, "hub_environment", lambda: "dev")
    monkeypatch.setattr(
        ActionDirectiveStore, "hmac_key", property(lambda _: b"synthetic-ledger-key")
    )
    principal = pod_mcp_approval.VerifiedOwnerPod(
        "ha1_test", "pod@synthetic.iam.gserviceaccount.com"
    )
    review = pod_mcp_approval.PodMcpTerms(
        ownerId="u",
        hushhId="ha1_test",
        podKeyId="podk_test",
        environment="dev",
        epoch=1,
        conversationId="private-thread",
        connectorId="custom_test",
        toolName="mcp_" + "a" * 40,
        callId="call",
        catalogRevision="rev1",
        commitment="b" * 64,
    )

    def invoke(operation, terms, **kwargs):
        return asyncio.run(
            pod_mcp_approval.mutate_review(
                operation,
                pod_mcp_approval.PodMcpMutation(review=terms, **kwargs),
                principal=principal,
                db=db,
            )
        )

    issued = invoke("issue", review)
    bound = pod_mcp_approval.PodMcpTerms.model_validate(issued["podReview"])
    assert bound.serviceUid == "uid-1"
    for field, changed in (
        ("ownerId", "other"),
        ("hushhId", "other"),
        ("podKeyId", "other"),
        ("serviceUid", "other"),
        ("environment", "prod"),
        ("epoch", 2),
        ("conversationId", "other"),
        ("connectorId", "other"),
        ("callId", "other"),
        ("catalogRevision", "rev2"),
        ("commitment", "c" * 64),
    ):
        with pytest.raises(ActionDirectiveAuthorityError):
            invoke(
                "confirm",
                bound.model_copy(update={field: changed}),
                directiveId=issued["directiveId"],
            )
    confirmed = invoke("confirm", bound, directiveId=issued["directiveId"])

    def consume():
        try:
            return invoke(
                "consume", bound, directiveId=issued["directiveId"], receipt=confirmed["receipt"]
            )
        except ActionDirectiveAuthorityError:
            return "refused"

    with ThreadPoolExecutor(max_workers=2) as pool:
        outcomes = list(pool.map(lambda _: consume(), range(2)))
    assert outcomes.count({"status": "consumed"}) == 1
    assert outcomes.count("refused") == 1
    with db.engine.begin() as conn:
        assert conn.execute(text("SELECT count(*) FROM one_adk_sessions")).scalar() == 0
        row = conn.execute(text("SELECT * FROM one_action_directive_ledger")).mappings().one()
        assert row["channel"] == "pod_chat" and row["adk_app_name"] is None
        assert row["slots_hmac"] != bound.commitment
    # Rotate only the runtime account after authentication: no issue or consume may commit.
    pending = invoke("issue", review)
    pending_terms = pod_mcp_approval.PodMcpTerms.model_validate(pending["podReview"])
    approved = invoke("confirm", pending_terms, directiveId=pending["directiveId"])
    with db.engine.begin() as conn:
        conn.execute(
            text(
                "UPDATE personal_agent_registry SET backend_metadata=jsonb_set(backend_metadata,'{runtime_service_account}','\"rotated@synthetic.iam.gserviceaccount.com\"')"
            )
        )
    with pytest.raises(ActionDirectiveAuthorityError, match="runtime identity"):
        invoke("issue", review)
    with pytest.raises(ActionDirectiveAuthorityError, match="runtime identity"):
        invoke(
            "consume",
            pending_terms,
            directiveId=pending["directiveId"],
            receipt=approved["receipt"],
        )
    with db.engine.begin() as conn:
        assert conn.execute(text("SELECT count(*) FROM one_action_directive_ledger")).scalar() == 2
        assert (
            conn.execute(
                text("SELECT consumed_at FROM one_action_directive_ledger WHERE directive_id=:id"),
                {"id": pending["directiveId"]},
            ).scalar()
            is None
        )
        conn.execute(
            text(
                "UPDATE personal_agent_registry SET backend_metadata=jsonb_set(backend_metadata,'{runtime_service_account}','\"pod@synthetic.iam.gserviceaccount.com\"')"
            )
        )
    # Replacement of the owner service disarms an otherwise exact pending approval.
    second = invoke("issue", review)
    with db.engine.begin() as conn:
        conn.execute(
            text(
                "UPDATE personal_agent_registry SET backend_metadata=jsonb_set(backend_metadata,'{serviceUid}','\"replacement\"')"
            )
        )
    with pytest.raises(ActionDirectiveAuthorityError):
        invoke(
            "confirm",
            pod_mcp_approval.PodMcpTerms.model_validate(second["podReview"]),
            directiveId=second["directiveId"],
        )


async def test_private_native_mcp_suspend_preview_confirm_resume(
    db, monkeypatch, tmp_path, request
):
    """Real ADK pause/preview/browser approval/resume; fake only model/provider transport."""
    from copy import deepcopy
    from types import SimpleNamespace
    from unittest.mock import AsyncMock

    from ag_ui.core import EventType, ResumeEntry, RunAgentInput, UserMessage
    from fastapi import FastAPI
    from fastapi.testclient import TestClient
    from google.adk.agents import LlmAgent
    from google.adk.models.llm_response import LlmResponse
    from google.adk.tools.mcp_tool.mcp_tool import McpTool
    from google.genai import types

    from api.middleware import require_vault_owner_token
    from api.routes import external_connectors
    from api.routes.one import pod_agent_chat
    from api.routes.one import pod_mcp_approval as broker_route
    from db import db_client
    from hushh_mcp import runtime_settings
    from hushh_mcp.one_adk import governed_mcp_toolset as governed
    from hushh_mcp.one_adk import pod_agui_lifetime as lifetime
    from hushh_mcp.one_adk.agui_factory import build_authenticated_agui
    from hushh_mcp.one_adk.encrypted_session_service import EncryptedAdkSessionService
    from hushh_mcp.one_adk.mcp_call_approval import review_private_call
    from hushh_mcp.one_adk.pod_adk_session_repository import (
        PodAdkSessionProjection,
        PodAdkSessionRepository,
    )
    from hushh_mcp.one_adk.pod_agui_context import PodChatContext
    from hushh_mcp.one_adk.pod_mcp_review import prepare_private_review
    from hushh_mcp.one_adk.registered_mcp_toolset import RegisteredMcpToolset
    from hushh_mcp.services import pod_binding_service
    from hushh_mcp.services.action_directive_ledger import ActionDirectiveStore
    from hushh_mcp.services.pod_commit_log import LocalObjectStore, PodCommitLog
    from hushh_mcp.services.pod_hub_client import VerifiedOwnerPod
    from hushh_mcp.services.pod_mcp_approval import PodMcpApprovalPort
    from hushh_mcp.services.pod_upgrade_admission import PodUpgradeAdmission
    from tests.helpers.chat_keys import bound_request_chat_key
    from tests.test_adk_specialist_chat_services import _ScriptedModel

    owner_id, hushh_id, thread = "u", "ha1_test", "private-mcp-native"
    connector = "custom_" + "a" * 32
    tool_name = governed.mcp_tool_name(connector, "search")
    private_argument = "SYNTHETIC_PRIVATE_MCP_ARGUMENT"
    configuration = {
        "version": 1,
        "connectorId": connector,
        "revision": "00000000-0000-0000-0000-000000000001",
        "displayName": "Synthetic connector",
        "endpoint": "https://example.com/mcp",
        "enabled": True,
        "authentication": {
            "kind": "api_key",
            "header": "Authorization",
            "value": "synthetic-connector-secret",
        },
        # Changed formerly blocked tools require review under the existing policy.
        "blockedTools": [{"id": tool_name, "fingerprint": "0" * 64}],
    }
    monkeypatch.setenv("APP_SIGNING_KEY", "synthetic-pod-signing-key-32-bytes")
    runtime_settings.clear_runtime_settings_caches()
    request.addfinalizer(runtime_settings.clear_runtime_settings_caches)
    monkeypatch.setattr(
        ActionDirectiveStore, "hmac_key", property(lambda _: b"separate-synthetic-hub-ledger-key")
    )
    monkeypatch.setattr(db_client, "get_db", lambda: db)
    monkeypatch.setattr(pod_binding_service, "hub_environment", lambda: "dev")
    monkeypatch.setattr(broker_route, "personal_agent_enabled", lambda: True)
    monkeypatch.setattr(
        broker_route,
        "verify_pod_identity",
        AsyncMock(return_value=VerifiedOwnerPod(hushh_id, "pod@synthetic.iam.gserviceaccount.com")),
    )
    native = AsyncMock(return_value={"content": [], "structuredContent": {"count": 1}})
    monkeypatch.setattr(McpTool, "_run_async_impl", native)
    provider_session = SimpleNamespace(
        list_tools=AsyncMock(
            return_value=SimpleNamespace(
                tools=[
                    SimpleNamespace(
                        name="search",
                        inputSchema={
                            "type": "object",
                            "properties": {"q": {"type": "string"}},
                            "required": ["q"],
                        },
                    )
                ],
                nextCursor=None,
            )
        )
    )
    monkeypatch.setattr(
        governed._GovernedMcpSessionManager,
        "create_session",
        AsyncMock(return_value=provider_session),
    )

    log = PodCommitLog(LocalObjectStore(str(tmp_path)), b"k" * 32, owner_id=hushh_id)
    admission = PodUpgradeAdmission(log_resolver=lambda: log)
    monkeypatch.setattr(lifetime, "ADMISSION", admission)
    monkeypatch.setattr(lifetime, "pod_incarnation", lambda: "synthetic-incarnation")
    owner = PodChatContext.__new__(PodChatContext)
    owner.owner, owner.hushh_id, owner.log = owner_id, hushh_id, log
    owner.claims = {"user_id": owner_id, "hushh_id": hushh_id}
    owner.require_access = AsyncMock()
    owner.runtime = SimpleNamespace(owner_user_id=owner_id)
    owner.authority = SimpleNamespace(
        pod_key_id="podk_test",
        environment="dev",
        epoch=1,
        lease=SimpleNamespace(state=AsyncMock(return_value="held")),
        local_token=lambda _: "synthetic-local-session-authority",
    )
    owner.sessions = EncryptedAdkSessionService(
        repository=PodAdkSessionRepository(
            projection=PodAdkSessionProjection(owner_id=owner_id, hushh_id=hushh_id, log=log),
            require_access=owner.require_access,
        )
    )
    model = _ScriptedModel(
        [
            LlmResponse(
                content=types.Content(
                    role="model",
                    parts=[
                        types.Part(
                            function_call=types.FunctionCall(
                                name=tool_name, args={"q": private_argument}
                            )
                        )
                    ],
                )
            ),
            LlmResponse(
                content=types.Content(role="model", parts=[types.Part.from_text(text="Completed.")])
            ),
        ]
    )

    def make_agent():
        agent = build_authenticated_agui(
            LlmAgent(
                name="one",
                model=model,
                instruction="Use the requested connector tool.",
                tools=[RegisteredMcpToolset(authorize_call=review_private_call)],
            ),
            owner.sessions,
            app_name="hussh_one",
            user_id_extractor=lambda _: owner_id,
            agent_class=lifetime.PodTimedADKAgent,
            max_concurrent_executions=1,
        )
        agent.configure_pod_turn(
            require_access=owner.require_access,
            runtime_scope=owner.runtime_scope,
            mcp_owner_admission=owner._mcp_owner_admission,
        )
        return agent

    def make_input(run_id, messages, *, approval=None, resume=None):
        forwarded = {"mcpConfigurations": [deepcopy(configuration)]}
        if approval is not None:
            forwarded["mcpApproval"] = approval
        value = RunAgentInput(
            thread_id=thread,
            run_id=run_id,
            state={},
            messages=messages,
            tools=[],
            context=[],
            forwarded_props=forwarded,
            resume=resume,
        )
        state, _ = pod_agent_chat.trusted_state(value, owner)
        return value.model_copy(update={"state": state, "forwarded_props": {}})

    app = FastAPI()
    app.include_router(broker_route.router)
    app.include_router(external_connectors.router)
    app.dependency_overrides[require_vault_owner_token] = lambda: {
        "user_id": owner_id,
        "token": "synthetic-browser-authority",
    }
    machine_requests = []
    with bound_request_chat_key(owner_id), TestClient(app) as hub:

        def pod_post(path, *, json):
            machine_requests.append((path, deepcopy(json)))
            return hub.post(path, json=json)

        owner.mcp_approval = PodMcpApprovalPort(owner, client=SimpleNamespace(post=pod_post))
        first = [
            event
            async for event in make_agent().run(
                make_input(
                    "first",
                    [UserMessage(id="user-1", role="user", content="Search synthetic records.")],
                )
            )
        ]
        assert not any(event.type == EventType.RUN_ERROR for event in first)
        finished = next(event for event in reversed(first) if event.type == EventType.RUN_FINISHED)
        assert finished.outcome.type == "interrupt"
        native.assert_not_awaited()
        assert (await admission.status(incarnation="synthetic-incarnation"))["activeWork"] == 0
        interrupt = finished.outcome.interrupts[0]
        encoded = "".join(
            event.delta
            for event in first
            if event.type == EventType.TOOL_CALL_ARGS
            and event.tool_call_id == interrupt.tool_call_id
        )
        reference = json.loads(encoded)["toolConfirmation"]["payload"]
        assert private_argument not in encoded
        preview = await prepare_private_review(
            owner,
            connector,
            external_connectors.McpReviewRequest(
                conversationId=thread,
                toolName=tool_name,
                arguments={},
                pendingHandle=reference["pendingHandle"],
                connectorConfiguration=configuration,
            ),
        )
        assert preview["arguments"] == {"q": private_argument}
        native.assert_not_awaited()
        confirmed = hub.post(
            f"/api/connectors/{connector}/mcp/confirm",
            json={
                "podReview": preview["podReview"],
                "directiveId": reference["directiveId"],
                "confirmed": True,
            },
        )
        assert confirmed.status_code == 200
        receipt = confirmed.json()["receipt"]
        with db.engine.connect() as conn:
            assert (
                conn.execute(text("SELECT state FROM one_action_directive_ledger")).scalar_one()
                == "confirmed"
            )
        native.assert_not_awaited()
        messages = next(
            event.messages for event in reversed(first) if event.type == EventType.MESSAGES_SNAPSHOT
        )
        approval = {
            key: reference[key]
            for key in ("directiveId", "connectorId", "toolName", "pendingHandle")
        }
        second = [
            event
            async for event in make_agent().run(
                make_input(
                    "resume",
                    messages,
                    approval={**approval, "receipt": receipt},
                    resume=[
                        ResumeEntry(
                            interrupt_id=interrupt.id,
                            status="resolved",
                            payload={"confirmed": True},
                        )
                    ],
                )
            )
        ]
        assert not any(event.type == EventType.RUN_ERROR for event in second)
        assert any(event.type == EventType.RUN_FINISHED for event in second)
        native.assert_awaited_once()
        assert native.await_args.kwargs["args"] == {"q": private_argument}
        recovered = await owner.sessions.get_session(
            app_name="hussh_one", user_id=owner_id, session_id=thread
        )
        assert recovered is not None and private_argument not in recovered.model_dump_json()
        assert private_argument not in json.dumps(machine_requests)
        assert "synthetic-connector-secret" not in json.dumps(machine_requests)
        assert [path.rsplit("/", 1)[-1] for path, _ in machine_requests] == ["issue", "consume"]
        with db.engine.connect() as conn:
            assert (
                conn.execute(text("SELECT state FROM one_action_directive_ledger")).scalar_one()
                == "consumed"
            )
            assert conn.execute(text("SELECT count(*) FROM one_adk_sessions")).scalar_one() == 0
        assert (await admission.status(incarnation="synthetic-incarnation"))["activeWork"] == 0
