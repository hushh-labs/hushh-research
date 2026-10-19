"""Security boundary of the server-only pilot projection; no live information."""

import asyncio
import hashlib
import hmac
import json
import time
from datetime import datetime, timezone
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from api.routes.one import plg
from hushh_mcp.hushh_adk import product_activity as sdk
from hushh_mcp.services import plg_evidence as evidence
from hushh_mcp.services import product_activity as sink
from hushh_mcp.services.plg_catalog import activity_catalog

SECRET = "test-only-plg-export-signature-key-with-32-characters"
NOW = datetime.now(timezone.utc)
ACCOUNT = {"accountId": "pilot-account", "journey": "memory", "since": NOW.isoformat()}
PLAN = "pkm_plan_abcdefghijkl"
COMMIT = evidence.derive_pkm_mutation_commit_id(
    user_id=ACCOUNT["accountId"], domain="home_projects", plan_id=PLAN
)


@pytest.fixture
def client(monkeypatch):
    monkeypatch.setenv("ONE_PLG_EXPORT_ENABLED", "true")
    monkeypatch.setenv("ONE_PLG_EXPORT_SECRET", SECRET)
    monkeypatch.setenv("ONE_PLG_EXPORT_ACCOUNT_IDS", ACCOUNT["accountId"])
    monkeypatch.setenv("ENVIRONMENT", "production")
    app = FastAPI()
    app.include_router(plg.router)
    with TestClient(app) as value:
        yield value


def post(client, payload=None, purpose="snapshot", secret=SECRET, version=None):
    body = json.dumps(payload or {"accounts": [ACCOUNT]})
    timestamp = str(int(time.time() * 1000))
    signature = hmac.new(
        secret.encode(), f"{purpose}\n{timestamp}\n{body}".encode(), hashlib.sha256
    ).hexdigest()
    return client.post(
        "/api/one/plg/snapshot",
        content=body,
        headers={
            "Content-Type": "application/json",
            "X-PLG-Timestamp": timestamp,
            "X-PLG-Signature": signature,
            **({"X-PLG-Version": str(version)} if version is not None else {}),
        },
    )


def test_export_rejects_wrong_signature_purpose_and_nonproduction(client, monkeypatch):
    source = AsyncMock(return_value={"version": 1})
    monkeypatch.setattr(plg, "snapshot", source)
    assert post(client, secret=SECRET + "-tampered").status_code == 401
    assert post(client, purpose="events").status_code == 401
    assert not source.called
    monkeypatch.setenv("ENVIRONMENT", "uat")
    monkeypatch.delenv("APP_RUNTIME_PROFILE", raising=False)
    assert post(client).status_code == 404
    monkeypatch.setenv("ENVIRONMENT", "production")
    assert (
        post(client).status_code == 200
    )  # Negative control: correct authority reaches the source.
    assert source.call_count == 1
    assert source.call_args.args[0].version == 1
    assert post(client, version=2).status_code == 200
    assert source.call_args.args[0].version == 2


def test_validation_and_provider_errors_never_echo_identifiers_or_private_details(
    client, monkeypatch
):
    result = post(client, {"accounts": [{**ACCOUNT, "accountId": "private/invalid-uid"}]})
    assert result.status_code == 400
    assert "private/invalid-uid" not in result.text
    monkeypatch.setattr(plg, "snapshot", AsyncMock(side_effect=RuntimeError("PRIVATE_DB_CONTENT")))
    result = post(client)
    assert result.status_code == 503
    assert "PRIVATE_DB_CONTENT" not in result.text
    assert result.headers["cache-control"] == "private, no-store"


@pytest.mark.asyncio
async def test_projection_bounds_owner_and_window_and_carries_deletion_without_content(monkeypatch):
    class Connection:
        async def fetch(self, query, *args, **kwargs):
            assert args == (ACCOUNT["accountId"], NOW, NOW)
            return [
                {
                    "action_id": COMMIT,
                    "occurred_at": NOW,
                    "private_content": "PRIVATE_CONTENT",
                    "domain": "home_projects",
                    "plan_id": PLAN,
                    "authorization_mode": "owner_confirmed",
                }
            ]

    class Acquire:
        async def __aenter__(self):
            return Connection()

        async def __aexit__(self, *_):
            pass

    class Pool:
        def acquire(self, **kwargs):
            return Acquire()

    monkeypatch.setattr(evidence, "get_pool", AsyncMock(return_value=Pool()))
    monkeypatch.setattr(evidence.AccountDeletionLifecycleService, "is_tombstoned", lambda _: False)
    request = evidence.PilotRequest.model_validate({"accounts": [ACCOUNT]})
    result = await evidence.snapshot(request, {ACCOUNT["accountId"]}, NOW)
    assert result["retainedOnly"] is True
    assert len(result["accounts"][0]["tasks"]) == 1
    assert "PRIVATE_CONTENT" not in json.dumps(result)
    assert "committed-action" not in json.dumps(result)
    assert COMMIT not in json.dumps(result)
    monkeypatch.setattr(evidence, "enabled_for", lambda _: False)
    expanded = await evidence.snapshot(
        request.model_copy(update={"version": 2}), {ACCOUNT["accountId"]}, NOW
    )
    account = expanded["accounts"][0]
    assert account["tasks"] == []
    assert {row["agentId"] for row in account["verified"]} == {
        "agent_personal_information",
        "agent_email",
    }
    assert account["activity"]["enabled"] is False
    assert "PRIVATE_CONTENT" not in json.dumps(expanded)
    with pytest.raises(ValueError):
        await evidence.snapshot(request, {"another-owner"}, NOW)
    monkeypatch.setattr(evidence.AccountDeletionLifecycleService, "is_tombstoned", lambda _: True)
    result = await evidence.snapshot(request, {ACCOUNT["accountId"]}, NOW)
    assert result["accounts"][0]["deleted"] is True
    assert result["accounts"][0]["tasks"] == []


def test_memory_requires_exact_plan_commit_and_explicit_owner_confirmation():
    row = {
        "action_id": COMMIT,
        "domain": "home_projects",
        "plan_id": PLAN,
        "authorization_mode": "owner_confirmed",
    }
    assert evidence.confirmed_memory(row, ACCOUNT["accountId"])
    assert not evidence.confirmed_memory(
        {**row, "authorization_mode": "owner_auto_save_policy"}, ACCOUNT["accountId"]
    )
    assert not evidence.confirmed_memory(
        {**row, "plan_id": "pkm_another_plan_abcdefghijkl"}, ACCOUNT["accountId"]
    )
    assert not evidence.confirmed_memory(row, "different-owner")


def test_observation_api_derives_owner_and_source_and_rejects_payloads(client, monkeypatch):
    from api.middleware import require_firebase_auth_read_only

    client.app.dependency_overrides[require_firebase_auth_read_only] = lambda: "verified-owner"
    monkeypatch.setattr(sink, "enabled_for", lambda uid: uid == "verified-owner")
    observe = sink.observe
    calls = []
    monkeypatch.setattr(sink, "observe", lambda *args: calls.append(args) or True)
    body = {
        "generation": "12345678-1234-1234-1234-123456789012",
        "operationId": "test-operation-1234",
        "actionId": "observation:one_memory_action:detail_edited",
        "phase": "returned",
    }
    for field in (
        {"userId": "other-owner"},
        {"source": "execution_observed"},
        {"prompt": "PRIVATE"},
    ):
        response = client.post("/api/one/plg/activity", json={**body, **field})
        assert response.status_code == 400
        assert "PRIVATE" not in response.text
    assert not calls
    assert client.post("/api/one/plg/activity", json=body).status_code == 200
    assert calls[0][0] == "verified-owner"
    assert calls[0][4] == "client_reported"
    with pytest.raises(ValueError):
        observe(
            "verified-owner",
            body["generation"],
            "agent:agent_one",
            "returned",
            "client_reported",
            body["operationId"],
        )


def test_catalog_covers_authored_agents_and_actions_without_dynamic_tool_names():
    import json

    from hushh_mcp.services.generated_contracts import generated_contract_path
    from hushh_mcp.services.plg_catalog import runtime_descriptor

    catalog = activity_catalog()
    registry = json.loads(
        generated_contract_path("agents", "product-agent-registry.v2.json").read_text()
    )
    graph = json.loads(generated_contract_path("kai", "one-capability-graph.v1.json").read_text())
    assert {a["id"] for a in catalog["agents"]} == {a["id"] for a in registry["agents"]}
    assert {a["capability_id"] for a in graph["actions"]} <= {a["id"] for a in catalog["actions"]}
    assert {a["agentId"] for a in catalog["actions"]} <= {a["id"] for a in catalog["agents"]}
    gateway = json.loads(
        generated_contract_path("kai", "kai-action-gateway.vnext.json").read_text()
    )
    assert {a["action_id"] for a in gateway["actions"]} <= {a["id"] for a in catalog["actions"]}
    private = runtime_descriptor("agent_one", "PRIVATE_CUSTOMER_MCP_TOOL")
    assert private["id"] == "runtime-tool:agent_one"
    assert "PRIVATE_CUSTOMER" not in json.dumps(private)


def test_sdk_session_uid_alone_never_establishes_admission(monkeypatch):
    monkeypatch.setattr(sink, "enabled_for", lambda _: True)
    monkeypatch.setattr(sdk.HushhContext, "current", lambda: None)
    context = SimpleNamespace(user_id="owner", state={})
    assert sdk._owner(context) is None
    context.state = {"temp:hussh:workspace_chat_admission": True, "hussh:user_id": "another-owner"}
    assert sdk._owner(context) is None
    context.state["hussh:user_id"] = "owner"
    assert sdk._owner(context) == "owner"


@pytest.mark.asyncio
async def test_sdk_pins_epoch_across_sibling_tasks_and_drops_unadmitted_or_finished_runs(
    monkeypatch,
):
    epoch = ["old-epoch"]
    monkeypatch.setattr(sdk, "_owner", lambda _: "owner")
    monkeypatch.setattr(sink, "enabled_for", lambda _: True)
    admitted = []
    monkeypatch.setattr(
        sink, "admission", lambda uid: admitted.append(uid) or {"generation": epoch[0]}
    )
    observations = []
    monkeypatch.setattr(sink, "observe", lambda *args: observations.append(args))
    plugin = sdk.ProductActivityPlugin("agent_one")
    run = SimpleNamespace(
        user_id="owner", invocation_id="invocation", session=SimpleNamespace(state={})
    )
    context = SimpleNamespace(
        user_id="owner",
        agent_name="agent_one",
        invocation_id="invocation",
        function_call_id="call",
        state={},
    )
    tool = SimpleNamespace(name="PRIVATE_DYNAMIC_TOOL")
    assert (
        await plugin.after_tool_callback(
            tool=tool, tool_args={"private": "PRIVATE"}, tool_context=context, result="PRIVATE"
        )
        is None
    )
    assert observations == []
    assert await plugin.before_run_callback(invocation_context=run) is None
    epoch[0] = "new-epoch"
    assert (
        await asyncio.create_task(
            plugin.after_tool_callback(
                tool=tool, tool_args={"private": "PRIVATE"}, tool_context=context, result="PRIVATE"
            )
        )
        is None
    )
    assert observations[0][1] == "old-epoch"
    assert observations[0][2] == "runtime-tool:agent_one"
    assert "PRIVATE" not in repr(observations)
    assert admitted == ["owner"]
    await plugin.after_run_callback(invocation_context=run)
    await plugin.after_agent_callback(
        agent=SimpleNamespace(parent_agent=None), callback_context=context
    )
    assert len(observations) == 1


@pytest.mark.asyncio
async def test_v2_catalog_bootstrap_never_opens_database_and_activity_never_becomes_tasks(
    monkeypatch,
):
    monkeypatch.setattr(
        evidence, "get_pool", AsyncMock(side_effect=AssertionError("no DB on bootstrap"))
    )
    result = await evidence.snapshot(
        evidence.PilotRequest(version=2, accounts=[]), {ACCOUNT["accountId"]}, NOW
    )
    assert result["accounts"] == []
    assert result["catalog"]["agents"]
    with pytest.raises(ValueError):
        await evidence.snapshot(evidence.PilotRequest(accounts=[]), {ACCOUNT["accountId"]}, NOW)
    monkeypatch.setattr(evidence, "enabled_for", lambda _: True)
    connection = SimpleNamespace(
        fetchrow=AsyncMock(return_value={"generation": "private-epoch", "started_at": NOW}),
        fetch=AsyncMock(
            return_value=[
                {
                    "agent_id": "agent_calendar",
                    "action_id": "retired.action",
                    "source": "client_reported",
                }
            ]
        ),
        fetchval=AsyncMock(return_value=False),
    )
    observed = await evidence.activity_snapshot(connection, evidence.PilotAccount(**ACCOUNT), NOW)
    assert observed["limited"] is True
    assert observed["rollups"] == []
    assert "private-epoch" not in json.dumps(observed)
