"""Security boundary of the server-only pilot projection; no live information."""

import asyncio
import hashlib
import hmac
import json
import time
from datetime import datetime, timedelta, timezone
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from api.routes.one import plg
from hushh_mcp.hushh_adk import product_activity as sdk
from hushh_mcp.services import plg_audience as audience
from hushh_mcp.services import plg_evidence as evidence
from hushh_mcp.services import plg_outcomes as outcomes
from hushh_mcp.services import plg_reporting as reporting
from hushh_mcp.services import product_activity as sink
from hushh_mcp.services.pkm_mutation_contracts import derive_pkm_mutation_commit_id
from hushh_mcp.services.plg_catalog import activity_catalog

SECRET = "test-only-plg-export-signature-key-with-32-characters"
NOW = datetime.now(timezone.utc)
ACCOUNT = {"accountId": "pilot-account", "journey": "memory", "since": NOW.isoformat()}
PLAN = "pkm_plan_abcdefghijkl"
COMMIT = derive_pkm_mutation_commit_id(
    user_id=ACCOUNT["accountId"], domain="home_projects", plan_id=PLAN
)


@pytest.fixture
def reporting_roster(monkeypatch):
    monkeypatch.setenv(
        "ONE_PLG_REPORTING_POLICY_JSON",
        json.dumps(
            {
                "version": 1,
                "excludedAccountIds": [],
                "excludedEmails": ["staff@example.test"],
                "excludedDomains": ["company.example"],
            }
        ),
    )
    monkeypatch.setenv("REVIEWER_UID", "reviewer")
    monkeypatch.setenv("REVIEWER_COUNTERPART_UID", "reviewer-counterpart")
    monkeypatch.setenv("ONE_MAGIC_INTELLIGENCE_INNER_TEAM_EMAILS", "inner@example.test")
    monkeypatch.setenv("ONE_MAGIC_INTELLIGENCE_SENIOR_TEAM_EMAILS", "")
    monkeypatch.setenv("ONE_MAGIC_INTELLIGENCE_QA_EMAILS", "qa@example.test")


def test_reporting_policy_requires_production_identity_and_explicit_internal_evidence(
    reporting_roster, monkeypatch
):
    policy = reporting.reporting_policy()
    identity = {"email": "customer@example.test", "display_name": "John Smith"}
    assert policy.eligible("customer", identity)  # A name alone never excludes a customer.
    assert policy.eligible("customer", {"email": "customer@company.example.evil.test"})
    assert policy.eligible("phone", {"phone_verified": True, "phone_number": "+919876543210"})
    assert not policy.eligible("auth-only", None)
    assert not policy.eligible("anonymous", {"phone_number": "+919876543210"})
    assert not policy.eligible("reviewer", identity)
    assert not policy.eligible("reviewer-counterpart", identity)
    for alias in (
        " STAFF@example.test ",
        "inner@example.test",
        "qa@example.test",
        "person@company.example",
        "person@sub.company.example",
    ):
        assert not policy.eligible("customer", identity, [alias])
    assert len(policy.revision) == 64 and "staff" not in json.dumps(policy.proof())
    monkeypatch.delenv("ONE_PLG_REPORTING_POLICY_JSON")
    with pytest.raises(ValueError, match="policy unavailable"):
        reporting.reporting_policy()


@pytest.fixture
def client(monkeypatch):
    monkeypatch.setenv("ONE_PLG_EXPORT_ENABLED", "true")
    monkeypatch.setenv("ONE_PLG_EXPORT_SECRET", SECRET)
    monkeypatch.setenv("ONE_PLG_EXPORT_ACCOUNT_IDS", ACCOUNT["accountId"])
    monkeypatch.setenv("ENVIRONMENT", "production")
    monkeypatch.setenv("GOOGLE_CLOUD_PROJECT", "hushh-pda")
    app = FastAPI()
    app.include_router(plg.router)
    with TestClient(app) as value:
        yield value


@pytest.mark.asyncio
async def test_current_reporting_identifiers_are_bounded_read_only_and_production_only(monkeypatch):
    from firebase_admin import auth

    from api.utils import firebase_admin

    record = SimpleNamespace(
        uid="customer",
        disabled=False,
        custom_claims={},
        email="customer@example.test",
        phone_number=None,
        provider_data=[SimpleNamespace(email="staff@company.example")],
        password_hash="PRIVATE_AUTH_EXPORT",  # noqa: S106 - synthetic export-leak sentinel
    )
    calls = []
    monkeypatch.setattr(
        firebase_admin, "get_firebase_auth_app", lambda: SimpleNamespace(project_id="hushh-pda")
    )
    monkeypatch.setattr(
        auth,
        "get_users",
        lambda identifiers, **kwargs: calls.append(identifiers) or SimpleNamespace(users=[record]),
    )
    result = await reporting.current_reporting_identifiers(["customer", "customer"])
    assert result == {"customer": ("customer@example.test", "staff@company.example")}
    assert len(calls) == 1 and len(calls[0]) == 1
    assert "PRIVATE_AUTH_EXPORT" not in json.dumps(result)
    record.disabled = True
    assert await reporting.current_reporting_identifiers(["customer"]) == {}
    monkeypatch.setattr(
        firebase_admin, "get_firebase_auth_app", lambda: SimpleNamespace(project_id="hushh-uat")
    )
    with pytest.raises(ValueError, match="source unavailable"):
        await reporting.current_reporting_identifiers(["customer"])
    with pytest.raises(ValueError, match="bound exceeded"):
        await reporting.current_reporting_identifiers([f"account-{n}" for n in range(51)])
    assert len(calls) == 2


def post(client, payload=None, purpose="snapshot", secret=SECRET, version=None, route="snapshot"):
    body = json.dumps(payload or {"accounts": [ACCOUNT]})
    timestamp = str(int(time.time() * 1000))
    signature = hmac.new(
        secret.encode(), f"{purpose}\n{timestamp}\n{body}".encode(), hashlib.sha256
    ).hexdigest()
    return client.post(
        f"/api/one/plg/{route}",
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
    monkeypatch.setenv("GOOGLE_CLOUD_PROJECT", "hushh-pda-uat")
    assert post(client).status_code == 404
    monkeypatch.setenv("GOOGLE_CLOUD_PROJECT", "hushh-pda")
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
async def test_projection_bounds_owner_and_window_and_carries_deletion_without_content(
    monkeypatch, reporting_roster
):
    class Connection:
        execute = AsyncMock()

        def transaction(self, **_):
            return Acquire()

        async def fetch(self, query, *args, **kwargs):
            assert args == (ACCOUNT["accountId"], NOW, NOW)
            if (
                "FROM pkm_domain_commits" not in query
                and "FROM gmail_owner_send_actions" not in query
            ):
                return []
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

        async def fetchval(self, *_args, **_kwargs):
            return False

    class Acquire:
        async def __aenter__(self):
            return Connection()

        async def __aexit__(self, *_):
            pass

    class Pool:
        def acquire(self, **kwargs):
            return Acquire()

    monkeypatch.setattr(evidence, "get_pool", AsyncMock(return_value=Pool()))
    monkeypatch.setattr(
        evidence.AccountDeletionLifecycleService,
        "active_projection_user_ids",
        AsyncMock(return_value={ACCOUNT["accountId"]}),
    )
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
        "agent_one",
    }
    assert account["activity"]["enabled"] is False
    assert "PRIVATE_CONTENT" not in json.dumps(expanded)
    identity = {ACCOUNT["accountId"]: {"email": "staff@example.test"}}
    monkeypatch.setattr(evidence.ActorIdentityService, "get_many", AsyncMock(return_value=identity))
    monkeypatch.setattr(
        evidence,
        "current_reporting_identifiers",
        AsyncMock(return_value={ACCOUNT["accountId"]: ("customer@example.test",)}),
    )
    monkeypatch.setattr(
        evidence.ActorIdentityService, "get_many_verified_email_aliases", AsyncMock(return_value={})
    )
    customer_result = await evidence.snapshot(
        request.model_copy(update={"customerReporting": True}), {ACCOUNT["accountId"]}, NOW
    )
    assert customer_result["customerReporting"]["scope"] == "production_registered_contacts"
    assert customer_result["accounts"][0]["reportingEligible"] is False
    assert customer_result["accounts"][0]["deleted"] is False
    assert customer_result["accounts"][0]["tasks"] == []  # Exclusion never asserts deletion.
    identity[ACCOUNT["accountId"]]["email"] = "customer@example.test"
    customer_result = await evidence.snapshot(
        request.model_copy(update={"customerReporting": True}), {ACCOUNT["accountId"]}, NOW
    )
    assert customer_result["accounts"][0]["reportingEligible"] is True
    assert len(customer_result["accounts"][0]["tasks"]) == 1
    for identifiers in (
        {ACCOUNT["accountId"]: ("customer@example.test", "provider@company.example")},
        {},
    ):
        monkeypatch.setattr(
            evidence, "current_reporting_identifiers", AsyncMock(return_value=identifiers)
        )
        customer_result = await evidence.snapshot(
            request.model_copy(update={"customerReporting": True}), {ACCOUNT["accountId"]}, NOW
        )
        assert customer_result["accounts"][0]["reportingEligible"] is False
        assert customer_result["accounts"][0]["tasks"] == []
    with pytest.raises(ValueError):
        await evidence.snapshot(request, {"another-owner"}, NOW)
    monkeypatch.setattr(
        evidence.AccountDeletionLifecycleService,
        "active_projection_user_ids",
        AsyncMock(return_value=set()),
    )
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
    assert {a["id"] for a in catalog["agents"] if a["public"]} == set(outcomes.DEFINITIONS)
    assert all(
        a["outcome"]["status"] == ("supported" if a["public"] else "internal")
        for a in catalog["agents"]
    )
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


def test_audience_requires_separate_purpose_key_production_and_activation(client, monkeypatch):
    key = SECRET + "-audience"
    source = AsyncMock(return_value={"rows": []})
    monkeypatch.setattr(plg, "audience_page", source)
    monkeypatch.setenv("ONE_PLG_AUDIENCE_ENABLED", "true")
    monkeypatch.setenv("ONE_PLG_AUDIENCE_SECRET", key)
    monkeypatch.setenv("GOOGLE_CLOUD_PROJECT", "hushh-pda")

    def call(**kwargs):
        return post(client, {"agentId": "agent_one"}, route="audience", **kwargs)

    assert call(purpose="audience").status_code == 401
    assert call(purpose="snapshot", secret=key).status_code == 401
    assert not source.called
    assert call(purpose="audience", secret=key).status_code == 200
    assert source.call_count == 1
    monkeypatch.setenv("GOOGLE_CLOUD_PROJECT", "hushh-pda-uat")
    assert call(purpose="audience", secret=key).status_code == 404
    monkeypatch.setenv("GOOGLE_CLOUD_PROJECT", "hushh-pda")
    monkeypatch.setenv("ONE_PLG_AUDIENCE_ENABLED", "false")
    assert call(purpose="audience", secret=key).status_code == 404
    monkeypatch.setenv("ONE_PLG_AUDIENCE_ENABLED", "true")
    source.side_effect = RuntimeError("PRIVATE_EMAIL_AND_PHONE")
    response = call(purpose="audience", secret=key)
    assert response.status_code == 503
    assert "PRIVATE_EMAIL" not in response.text
    assert response.headers["cache-control"] == "private, no-store"


def test_audience_cursor_binds_filters_window_project_and_signature():
    request = audience.AudienceRequest(agentId="agent_one", query="Test", graceMinutes=60)
    cursor = audience._next_cursor("provider-page", request, SECRET, NOW)
    following = request.model_copy(update={"cursor": cursor})
    assert audience._cursor(following, SECRET, NOW) == ("provider-page", NOW)
    for changed in (
        following.model_copy(update={"query": "different"}),
        following.model_copy(update={"segment": "failed"}),
        following.model_copy(update={"graceMinutes": 15}),
        following.model_copy(update={"cursor": cursor + "a"}),
    ):
        with pytest.raises(audience.AudienceCursorError):
            audience._cursor(changed, SECRET, NOW)
    with pytest.raises(audience.AudienceCursorError):
        audience._cursor(following, SECRET, NOW + timedelta(minutes=16))


def test_audience_canonical_clears_win_and_provider_identity_is_bounded_and_whitelisted():
    record = SimpleNamespace(
        uid="phone-only",
        disabled=False,
        custom_claims={},
        provider_data=[],
        email=None,
        email_verified=False,
        phone_number="+919876543210",
        display_name="N" * 300,
        **{"password_hash": "PRIVATE_HASH", "password_salt": "PRIVATE_SALT"},
    )
    assert audience._registered(record)
    fallback = audience._identity(record, None, record.phone_number)
    assert fallback["phoneNumber"] == "+919876543210"
    assert len(fallback["name"]) == 160
    canonical = audience._identity(
        record,
        {"display_name": "Saved", "email": None, "phone_number": None, "phone_verified": False},
        record.phone_number,
    )
    assert canonical["source"] == "canonical"
    assert canonical["phoneNumber"] is None and canonical["email"] is None
    assert "PRIVATE" not in json.dumps([fallback, canonical])
    record.disabled = True
    assert not audience._registered(record)
    record.disabled = False
    record.phone_number = None
    assert not audience._registered(
        record
    )  # Anonymous/unclassified never becomes a registered lead.


def test_attempt_summary_pairs_each_invocation_and_labels_missing_terminals_as_uncertain():
    started = NOW - timedelta(hours=2)

    def row(
        operation, terminal=None, at=NOW, action="agent:agent_one", source="execution_observed"
    ):
        return {
            "action_id": action,
            "source": source,
            "operation_key": operation,
            "started_at": started if operation == "a" else None,
            "last_at": at,
            "terminal": terminal,
            "terminal_at": at if terminal else None,
            "observations": 1,
        }

    rows = [row("a", at=started), row("b", "returned"), row(None, "returned")]
    options = dict(
        agent_id="agent_one",
        now=NOW,
        grace=60,
        epoch={"started_at": started},
        limited=False,
        enabled=True,
    )
    result = audience.summarize_attempts(rows, **options)
    assert result["counts"]["possibleIncomplete"] == 1
    assert result["counts"]["returned"] == 1
    assert result["counts"]["uncorrelated"] == 1
    rows[0] = row("a", "returned")  # A late terminal closes only its own invocation.
    result = audience.summarize_attempts(rows, **options)
    assert result["counts"]["possibleIncomplete"] == 0
    assert result["counts"]["returned"] == 2
    hidden = audience.summarize_attempts(rows, **{**options, "enabled": False, "limited": True})
    assert hidden["coverage"] == "unavailable"
    assert not any(hidden["counts"].values())
    assert hidden["lastObservedAt"] is None and hidden["collectionStartedAt"] is None
    assert not audience._matches(
        {"identity": {}, "activity": hidden}, audience.AudienceRequest(segment="returned")
    )


@pytest.mark.parametrize(
    ("phase", "field"), [("returned", "lastReturnedAt"), ("failed", "lastFailureAt")]
)
def test_terminal_receipt_time_is_not_replaced_by_a_later_start(phase, field):
    terminal_at = NOW - timedelta(minutes=2)
    rows = [
        {
            "action_id": "agent:agent_one",
            "source": "execution_observed",
            "operation_key": "reordered-call",
            "started_at": NOW,
            "last_at": NOW,
            "terminal": phase,
            "terminal_at": terminal_at,
            "observations": 2,
        }
    ]
    result = audience.summarize_attempts(
        rows,
        agent_id="agent_one",
        now=NOW,
        grace=60,
        epoch={"started_at": NOW - timedelta(hours=1)},
        limited=False,
        enabled=True,
    )
    assert result[field] == terminal_at.isoformat()
    assert result["lastObservedAt"] == NOW.isoformat()
    assert result["counts"][phase] == 1
    assert result["counts"]["possibleIncomplete"] == 0


@pytest.mark.asyncio
async def test_phone_fallback_claim_lock_rejects_a_number_bound_to_another_owner():
    conn = SimpleNamespace(
        execute=AsyncMock(),
        fetch=AsyncMock(return_value=[{"user_id": "new-owner", "phone_number": "+919876543210"}]),
    )
    result = await audience.ActorIdentityService.read_provider_phone_fallbacks(
        conn,
        candidates={"old-owner": "+919876543210", "new-owner": "+919876543210", "bad": "98765"},
    )
    assert result == {"new-owner": "+919876543210"}
    assert "hashtextextended($1, 0)" in conn.execute.call_args.args[0]
    assert conn.execute.call_args.args[1] == "actor_identity_phone_claim:+919876543210"


@pytest.mark.asyncio
async def test_audience_projection_excludes_tombstoned_owner_after_canonical_barriers():
    from hushh_mcp.services.account_deletion_lifecycle_service import account_deletion_user_hash

    conn = SimpleNamespace(execute=AsyncMock(), fetch=AsyncMock())

    async def tombstones(query, hashes, **_):
        # Any deletion that was already in flight must commit before this read.
        assert [call.args[1:] for call in conn.execute.call_args_list] == [
            ("active", 171),
            ("retired", 171),
            ("active", 198),
            ("retired", 198),
        ]
        assert "account_deletion_tombstones" in query
        assert account_deletion_user_hash("retired") in hashes
        return [{"user_id_hash": account_deletion_user_hash("retired")}]

    conn.fetch.side_effect = tombstones
    active = await audience.AccountDeletionLifecycleService.active_projection_user_ids(
        conn, user_ids=["retired", "active", "active"]
    )
    assert active == {"active"}
    with pytest.raises(ValueError, match="bound"):
        await audience.AccountDeletionLifecycleService.active_projection_user_ids(
            conn, user_ids=[str(n) for n in range(51)]
        )
    assert conn.fetch.call_count == 1


@pytest.mark.asyncio
async def test_audience_live_page_excludes_deleted_accounts_and_never_serializes_provider_records(
    monkeypatch,
    reporting_roster,
):
    records = [
        SimpleNamespace(
            uid=uid,
            disabled=False,
            custom_claims={},
            provider_data=[],
            email=None,
            email_verified=False,
            phone_number="+919876543210",
            display_name="Phone only",
            **{"password_hash": "PRIVATE_HASH"},
        )
        for uid in ("active", "deleted", "staff", "alias", "auth-only", "reviewer")
    ]
    monkeypatch.setattr(
        audience,
        "_firebase_page",
        lambda _: SimpleNamespace(users=records, **{"next_page_token": "next"}),
    )

    class Context:
        def __init__(self, value):
            self.value = value

        async def __aenter__(self):
            return self.value

        async def __aexit__(self, *_):
            pass

    conn = SimpleNamespace(
        execute=AsyncMock(),
        fetch=AsyncMock(return_value=[]),
        fetchval=AsyncMock(return_value=False),
    )

    async def source_page(query, *args, **_):
        if "owners.user_id AS _plg_user_id" in query:
            assert args[0] == ["active"]  # Tombstoned identities never reach the outcome query.
            if "AS capped" in query:
                return [{"_plg_user_id": "active", "capped": False}]
        return []

    conn.fetch.side_effect = source_page
    conn.transaction = lambda **_: Context(None)
    monkeypatch.setattr(
        audience,
        "get_pool",
        AsyncMock(return_value=SimpleNamespace(acquire=lambda **_: Context(conn))),
    )
    monkeypatch.setattr(
        audience.AccountDeletionLifecycleService,
        "active_projection_user_ids",
        AsyncMock(return_value={"active", "staff", "alias", "auth-only", "reviewer"}),
    )
    monkeypatch.setattr(
        audience.ActorIdentityService,
        "get_many",
        AsyncMock(
            return_value={
                "active": {
                    "display_name": "John Smith",
                    "phone_verified": True,
                    "phone_number": "+919876543210",
                },
                "staff": {"email": "person@company.example"},
                "alias": {"email": "customer@example.test"},
                "reviewer": {"email": "customer@example.test"},
            }
        ),
    )
    monkeypatch.setattr(
        audience.ActorIdentityService,
        "get_many_verified_email_aliases",
        AsyncMock(return_value={"alias": ["staff@example.test"]}),
    )
    monkeypatch.setattr(
        audience.ActorIdentityService,
        "read_provider_phone_fallbacks",
        AsyncMock(return_value={"active": "+919876543210"}),
    )
    monkeypatch.setattr(audience, "enabled_for", lambda _: False)
    result = await audience.audience_page(audience.AudienceRequest(), SECRET, NOW)
    assert result["scanned"] == 6 and result["excluded"] == 5
    assert result["customerReporting"]["scope"] == "production_registered_contacts"
    assert [r["accountId"] for r in result["rows"]] == ["active"]
    assert result["rows"][0]["identity"]["phoneNumber"] == "+919876543210"
    assert result["rows"][0]["verified"]["supported"] is True
    assert result["rows"][0]["verified"]["count"] == 0
    assert "PRIVATE_HASH" not in json.dumps(result)
    assert result["campaignEnrollmentChanged"] is False and result["nextCursor"]


def test_all_registered_collection_remains_explicit_and_production_only(monkeypatch):
    monkeypatch.setenv("ENVIRONMENT", "production")
    monkeypatch.delenv("APP_RUNTIME_PROFILE", raising=False)
    monkeypatch.setenv("GOOGLE_CLOUD_PROJECT", "hushh-pda")
    monkeypatch.setenv("ONE_PLG_ACTIVITY_ENABLED", "true")
    monkeypatch.setenv("ONE_PLG_EXPORT_ACCOUNT_IDS", "pilot-account")
    monkeypatch.delenv("ONE_PLG_ACTIVITY_ALL_REGISTERED", raising=False)
    assert sink.enabled_for("pilot-account") and not sink.enabled_for("new-account")
    monkeypatch.setenv("ONE_PLG_ACTIVITY_ALL_REGISTERED", "true")
    assert sink.enabled_for("new-account")
    monkeypatch.setenv("GOOGLE_CLOUD_PROJECT", "hushh-pda-uat")
    assert not sink.enabled_for("new-account")
    monkeypatch.setenv("GOOGLE_CLOUD_PROJECT", "hushh-pda")
    monkeypatch.setenv("ONE_PLG_ACTIVITY_ENABLED", "false")
    assert not sink.enabled_for("new-account")


@pytest.mark.asyncio
async def test_domain_outcomes_classify_saved_artifacts_and_deduplicate_shared_one_effects():
    uid = ACCOUNT["accountId"]
    commits = []
    for domain, writer in [
        ("financial", "kai_analysis_completion"),
        ("professional", "career_resume_owner_review"),
        ("wallet", "wallet_card_owner_review"),
        ("home_projects", "memory_owner_review"),
    ]:
        commits.append(
            {
                "action_id": derive_pkm_mutation_commit_id(
                    user_id=uid, domain=domain, plan_id=PLAN
                ),
                "occurred_at": NOW,
                "domain": domain,
                "plan_id": PLAN,
                "authorization_mode": "owner_confirmed",
                "writer_id": writer,
            }
        )
    # Incorrect provenance and a plan/commit mismatch must not count even with a positive SDK return.
    invalid = [
        {**commits[0], "authorization_mode": "owner_auto_save_policy"},
        {**commits[0], "action_id": "unbound-commit"},
    ]
    fixtures = {
        outcomes.MEMORY_SQL.replace("LIMIT 101", "LIMIT 1001"): commits + invalid,
        outcomes.WALLET_SQL: [{"action_id": commits[2]["action_id"]}],
        outcomes.MAIL_SQL.replace("LIMIT 101", "LIMIT 1001"): [
            {"action_id": "mail-effect", "occurred_at": NOW}
        ],
        outcomes.KYC_SQL: [{"action_id": "mail-effect", "occurred_at": NOW}],
        **{
            sql: [{"action_id": name, "occurred_at": NOW}]
            for name, sql in [
                ("calendar", outcomes.CALENDAR_SQL),
                ("nav", outcomes.NAV_SQL),
                ("location-command", outcomes.LOCATION_SQL),
                ("location-direct", outcomes.LOCATION_DIRECT_SQL),
                ("document", outcomes.DOCUMENTS_SQL),
                ("crm", outcomes.CRM_SQL),
            ]
        },
    }
    calls = []

    async def fetch(query, *args, **_):
        assert args == (uid, NOW, NOW)
        calls.append(query)
        return fixtures[query]

    conn = SimpleNamespace(fetch=fetch, fetchval=AsyncMock(return_value=False))
    cache = {}
    expected = {
        "agent_personal_information": 4,
        "agent_email": 1,
        "agent_kai": 1,
        "agent_career": 1,
        "agent_wallet": 1,
        "agent_kyc": 1,
        "agent_calendar": 1,
        "agent_nav": 1,
        "agent_location": 2,
        "agent_documents": 1,
        "agent_connected_systems": 1,
        "agent_one": 11,
    }
    for agent, count in expected.items():
        effects, limited = await outcomes.value_effects(conn, uid, agent, NOW, NOW, cache)
        assert len(effects) == count, agent
        assert not limited
    assert len(calls) == len(fixtures)  # No repeated source scans for a multi-agent snapshot.
    unknown = await outcomes.value_summary(conn, uid, "agent_memory_merge", NOW, NOW)
    assert unknown == {
        "supported": False,
        "proof": None,
        "count": 0,
        "lastAt": None,
        "limited": False,
    }
    conn.fetchval.return_value = True
    capped = await outcomes.value_summary(conn, uid, "agent_calendar", NOW, NOW)
    assert capped["supported"] and capped["limited"] and capped["count"] == 1

    # A full default audience page must not multiply eleven sources by 25 owners.
    owners = [uid, "owner' OR 1=1 --", *[f"page-owner-{n}" for n in range(23)]]
    batch_calls = []

    async def batch_fetch(query, ids, since, now, **_):
        assert ids == owners and since == now == NOW
        assert owners[1] not in query  # Identity values are bound, never SQL source.
        batch_calls.append(query)
        if "AS capped" in query:
            return [{"_plg_user_id": owner, "capped": owner == uid} for owner in owners]
        source = next(q for q in fixtures if q.replace("$1", "owners.user_id") in query)
        rows = [{"_plg_user_id": uid, **row} for row in fixtures[source]]
        if source == outcomes.MAIL_SQL.replace("LIMIT 101", "LIMIT 1001"):
            rows.append({"_plg_user_id": owners[1], "action_id": "mail-effect", "occurred_at": NOW})
        return rows

    batch_conn = SimpleNamespace(fetch=batch_fetch)
    summaries = await outcomes.value_summaries(batch_conn, owners, "agent_one", NOW, NOW)
    assert len(batch_calls) == 11
    assert summaries[uid]["count"] == 11 and summaries[uid]["limited"]
    assert summaries[owners[1]]["count"] == 1 and not summaries[owners[1]]["limited"]
    assert all(summaries[owner]["count"] == 0 for owner in owners[2:])
    assert all(row["proof"] == "one.distinct_domain_effects.v1" for row in summaries.values())
    internal = await outcomes.value_summaries(batch_conn, owners, "agent_memory_merge", NOW, NOW)
    assert not any(row["supported"] for row in internal.values()) and len(batch_calls) == 11
    with pytest.raises(ValueError, match="bound"):
        await outcomes.value_summaries(batch_conn, [*owners, "overflow"], "agent_one", NOW, NOW)
    with pytest.raises(ValueError, match="incomplete"):
        await outcomes.value_summaries(
            SimpleNamespace(fetch=AsyncMock(return_value=[])), owners, "agent_one", NOW, NOW
        )


@pytest.mark.asyncio
async def test_value_epoch_is_pinned_before_effect_and_measurement_failure_is_optional(monkeypatch):
    from hushh_mcp.services import product_value_receipts as values

    generation = ["old-generation"]
    monkeypatch.setattr(
        values.product_activity, "admission", lambda _: {"generation": generation[0]}
    )
    pinned = await values.capture_value_epoch("owner")
    generation[0] = "reset-generation"
    calls = []
    monkeypatch.setattr(values, "_calendar_receipt", lambda *args: calls.append(args) or True)
    await values.record_calendar_effect(
        user_id="owner", kind="proposal", source_id="proposal", generation=pinned
    )
    assert calls == [("owner", "proposal", "proposal", "old-generation")]
    await values.record_calendar_effect(
        user_id="owner", kind="proposal", source_id="proposal", generation=None
    )
    assert len(calls) == 1
    monkeypatch.setattr(
        values,
        "_calendar_receipt",
        lambda *_: (_ for _ in ()).throw(RuntimeError("private db failure")),
    )
    assert (
        await values.record_calendar_effect(
            user_id="owner", kind="proposal", source_id="proposal", generation=pinned
        )
        is None
    )


def test_slow_measurement_checkout_cannot_stall_product_or_build_an_unbounded_queue(monkeypatch):
    import threading

    from hushh_mcp.services import product_value_receipts as values

    release = threading.Event()
    started = []
    pending = []
    submit = values._submit

    def track(callback):
        future = submit(callback)
        if future:
            pending.append(future)
        return future

    def slow_admission(uid):
        started.append(uid)
        release.wait(5)
        return {"generation": "late-generation"}

    monkeypatch.setattr(values.product_activity, "admission", slow_admission)
    monkeypatch.setattr(values, "_submit", track)
    try:
        for _ in range(4):
            before = time.monotonic()
            assert values.capture_value_epoch_sync("owner") is None
            assert time.monotonic() - before < 1
        before = time.monotonic()
        assert values.capture_value_epoch_sync("capacity-exceeded") is None
        assert time.monotonic() - before < 0.5
        assert started == ["owner"] * 4
    finally:
        release.set()
        for future in pending:
            future.result(timeout=2)
