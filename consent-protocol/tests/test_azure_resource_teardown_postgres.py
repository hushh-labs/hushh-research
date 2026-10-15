"""Owner cleanup approval and provider settlement through real PostgreSQL."""

from __future__ import annotations

import asyncio
import copy
import json
import uuid
from pathlib import Path

import pytest


def _seed_qualified_history(pg, owner, hushh_id, subscription, tenant, group):
    pg.execute(
        "INSERT INTO personal_agent_registry(user_id,hushh_id,status) VALUES (%s,%s,'unprovisioned')",
        (owner, hushh_id),
    )
    target = f"/subscriptions/{subscription}/resourceGroups/{group}"
    pg.execute(
        "INSERT INTO byoc_setup_jobs(user_id,job_id,project_id,status) VALUES (%s,'setup-1',%s,'running')",
        (owner, target),
    )
    intent = {
        "version": 1,
        "jobId": "setup-1",
        "hushhId": hushh_id,
        "tenantId": tenant,
        "subscriptionId": subscription,
        "resourceGroup": group,
        "location": "eastus2",
        "setupNonce": "0123456789abcdef",
    }
    assert (
        pg.execute(
            "SELECT retain_byoc_azure_setup_intent(%s,'setup-1',%s::jsonb)",
            (owner, json.dumps(intent)),
        )[0][0]
        is True
    )
    execution, request_id = str(uuid.uuid4()), str(uuid.uuid4())
    assert (
        pg.execute("SELECT begin_byoc_azure_worker(%s,'setup-1',%s)", (owner, execution))[0][0]
        is True
    )
    events = [
        {
            "stage": "azure_provider_request",
            "requestId": request_id,
            "method": "PUT",
            "path": target,
            "apiVersion": "2021-04-01",
            "purpose": "creating_resource_group",
        },
        {
            "stage": "azure_provider_ack",
            "requestId": request_id,
            "status": 201,
            "operationUrl": None,
            "operationUrlSha256": None,
        },
        {"stage": "azure_provider_terminal", "requestId": request_id, "outcome": "succeeded"},
        {"stage": "azure_worker_exited"},
    ]
    for event in events:
        value = {"jobId": "setup-1", "executionId": execution, **event}
        assert (
            pg.execute(
                "SELECT retain_byoc_azure_worker_event(%s,'setup-1',%s::jsonb)",
                (owner, json.dumps(value)),
            )[0][0]
            is True
        )
    pg.execute("SELECT pg_advisory_unlock(hashtextextended(%s,206))", (owner,))
    pg.execute("UPDATE byoc_setup_jobs SET status='recorded' WHERE user_id=%s", (owner,))


@pytest.fixture
def cleanup_pg(monkeypatch, request):
    from tests.pkm_conformance.postgres_harness import find_pg_bin
    from tests.test_owner_access_erasure_migration import (
        HUSHH_ID,
        OWNER,
        SUB,
        TENANT,
        _checkpoint,
        _reserve,
        _resource_group,
        _retain_checkpoint,
    )
    from tests.test_personal_agent_notification_checkpoint import _notification_server

    if find_pg_bin() is None:
        pytest.skip("local PostgreSQL unavailable")
    server = _notification_server(monkeypatch)
    try:
        parked = Path(__file__).resolve().parents[1] / "db/migrations/parked"
        for name in (
            "960_owner_erasure_provider_outcomes.sql",
            "961_azure_setup_erasure_binding.sql",
            "962_azure_owner_cleanup_admission.sql",
        ):
            server.apply_file(parked / name)
        group = f"/subscriptions/{SUB}/resourceGroups/{_resource_group()}"
        if getattr(request, "param", True):
            _seed_qualified_history(server, OWNER, HUSHH_ID, SUB, TENANT, _resource_group())
            if getattr(request, "param", True) == "untracked_hosted":
                # The trigger preserves original setup receipts across job
                # replacement; they cannot prove this later worker exited.
                server.execute(
                    "UPDATE byoc_setup_jobs SET job_id='upgrade-untracked',status='failed',"
                    "stages='[]'::jsonb WHERE user_id=%s",
                    (OWNER,),
                )
            server.execute(
                "UPDATE personal_agent_registry SET status='provisioned',backend='user_azure',"
                "deployment_target='user_azure',user_cloud_tenant_id=%s,user_cloud_subscription_id=%s,"
                "user_cloud_resource_group=%s,user_cloud_region='eastus2',backend_metadata=%s::jsonb WHERE user_id=%s",
                (
                    TENANT,
                    SUB,
                    _resource_group(),
                    json.dumps({"serviceUid": "incarnation-1", "setupNonce": "0123456789abcdef"}),
                    OWNER,
                ),
            )
            reservation = server.execute(
                "SELECT reserve_personal_agent_erasure(%s,'attempt-1')", (OWNER,)
            )[0][0]
            checkpoint = _checkpoint()
            provider_case = getattr(request, "param", True)
            if provider_case == "provider_legacy":
                checkpoint["agentErased"].pop("providerCoverage")
            elif provider_case == "provider_pending":
                checkpoint["agentErased"]["providerUnconfirmed"] = 1
            elif provider_case == "provider_unavailable":
                checkpoint["agentErased"].update(providerRevoked=0, providerUnavailable=1)
            assert _retain_checkpoint(server, reservation, checkpoint) is True
        else:
            server.execute(
                "INSERT INTO byoc_setup_jobs(user_id,job_id,project_id,status) VALUES (%s,'setup-1',%s,'recorded')",
                (OWNER, group),
            )
            reservation = _reserve(server)
        context = server.execute("SELECT azure_erasure_context(%s)", (OWNER,))[0][0]
        assert context is not None
        yield server, OWNER, reservation, context
    finally:
        server.stop()


@pytest.fixture
def cleanup_state(cleanup_pg):
    pg, owner, reservation, context = cleanup_pg
    group = f"/subscriptions/{context['subscriptionId']}/resourceGroups/{context['resourceGroup']}"
    plan = {
        "version": 1,
        "context": context,
        "termsVersion": "azure-exact-parent-v1",
        "resources": {
            group: {
                "apiVersion": "2021-04-01",
                "kind": "resource",
                "expected": {},
                "coveredBy": None,
                "identity": {"id": group},
                "deletionScope": "whole_group",
            }
        },
    }
    state = {"plan": plan, "approvals": [], "resources": {}}

    def retain(value):
        current = pg.execute(
            "SELECT backend_metadata->'erasure' FROM personal_agent_registry WHERE user_id=%s",
            (owner,),
        )[0][0]
        return pg.execute(
            "SELECT retain_azure_erasure_state(%s,%s,%s::jsonb,%s::jsonb)",
            (owner, reservation["attemptId"], json.dumps(current), json.dumps(value)),
        )[0][0]

    return pg, owner, reservation, plan, state, retain


def _approve_cleanup(pg, owner, reservation, plan):
    digest = pg.execute(
        "SELECT encode(sha256(convert_to(%s::jsonb::text,'UTF8')),'hex')", (json.dumps(plan),)
    )[0][0]
    return pg.execute(
        "SELECT approve_azure_erasure_plan(%s,%s,%s,%s)",
        (owner, reservation["attemptId"], digest, next(iter(plan["resources"]))),
    )[0][0]


def _begin_cleanup(pg, owner, reservation, execution):
    return pg.execute(
        "SELECT begin_azure_erasure_worker(%s,%s,%s)", (owner, reservation["attemptId"], execution)
    )[0][0]


def test_durable_cleanup_requires_exact_plan_owner_approval_and_live_worker(cleanup_state):
    pg, owner, reservation, plan, state, retain = cleanup_state
    wrong = copy.deepcopy(state)
    wrong["plan"]["context"]["ownerId"] = "another-owner"
    assert retain(wrong) is False
    assert retain(state) is True
    execution = str(uuid.uuid4())
    # No Microsoft OAuth callback or inference binding can manufacture approval.
    assert _begin_cleanup(pg, owner, reservation, execution) is False
    assert (
        pg.execute(
            "SELECT approve_azure_erasure_plan(%s,%s,%s,%s)",
            (owner, reservation["attemptId"], "f" * 64, next(iter(plan["resources"]))),
        )[0][0]
        is None
    )
    approval = _approve_cleanup(pg, owner, reservation, plan)
    assert approval["scope"] == "exact_plan"
    assert approval["ownerId"] == owner
    assert _begin_cleanup(pg, owner, reservation, execution) is True
    assert (
        pg.execute(
            "SELECT assert_azure_erasure_worker(%s,%s,%s)",
            (owner, reservation["attemptId"], execution),
        )[0][0]
        is True
    )
    from tests.test_byoc_setup_job_azure_admission_postgres import _Client

    foreign = _Client(pg)
    try:
        # A separate SQL session cannot impersonate the real worker by copying
        # the retained execution UUID.
        assert foreign.execute_raw(
            "SELECT assert_azure_erasure_worker(:owner,:attempt,:execution) AS admitted",
            {"owner": owner, "attempt": reservation["attemptId"], "execution": execution},
        ).data == [{"admitted": False}]
    finally:
        foreign._engine.dispose()


@pytest.mark.parametrize("cleanup_pg", [False, "untracked_hosted"], indirect=True)
def test_legacy_missing_journal_can_be_inspected_but_cannot_admit_cleanup(cleanup_state):
    pg, owner, reservation, plan, state, retain = cleanup_state
    assert retain(state) is True
    assert _approve_cleanup(pg, owner, reservation, plan)
    assert pg.execute("SELECT azure_erasure_authorization(%s,'inspect')", (owner,))[0][0]
    assert pg.execute("SELECT azure_erasure_authorization(%s,'execute')", (owner,))[0][0] is None
    assert _begin_cleanup(pg, owner, reservation, str(uuid.uuid4())) is False


@pytest.mark.parametrize(
    "cleanup_pg", ["provider_legacy", "provider_pending", "provider_unavailable"], indirect=True
)
def test_owner_approval_cannot_qualify_unknown_or_incomplete_connector_revocation(cleanup_state):
    pg, owner, reservation, plan, state, retain = cleanup_state
    assert retain(state) is True
    assert _approve_cleanup(pg, owner, reservation, plan)
    assert pg.execute("SELECT azure_erasure_writers_drained(%s)", (owner,))[0][0] is True
    assert _begin_cleanup(pg, owner, reservation, str(uuid.uuid4())) is False


def test_cleanup_schema_rollback_cannot_discard_a_retained_owner_operation(cleanup_state):
    from tests.test_byoc_setup_job_azure_admission_postgres import psycopg2

    pg, owner, reservation, plan, state, retain = cleanup_state
    migrations = Path(__file__).resolve().parents[1] / "db/migrations"
    rollback = migrations / "rollback/962_azure_owner_cleanup_admission.rollback.sql"
    forward = migrations / "parked/962_azure_owner_cleanup_admission.sql"
    # An unused authority can be removed and installed without changing the
    # existing reservation. Once retained, recovery must move forward.
    pg.apply_file(rollback)
    pg.apply_file(forward)
    assert retain(state) is True
    with pytest.raises(psycopg2.Error, match="forward recovery"):
        pg.apply_file(rollback)
    pg.execute("ROLLBACK")
    observed = pg.execute(
        "SELECT backend_metadata->'erasure'->'azureTeardown' FROM personal_agent_registry "
        "WHERE user_id=%s",
        (owner,),
    )[0][0]
    assert observed == state


def test_durable_absence_cannot_settle_an_uncertain_provider_request(cleanup_state):
    pg, owner, reservation, plan, state, retain = cleanup_state
    assert retain(state) is True
    assert _approve_cleanup(pg, owner, reservation, plan)
    assert _begin_cleanup(pg, owner, reservation, str(uuid.uuid4())) is True
    group = next(iter(plan["resources"]))
    state = pg.execute(
        "SELECT backend_metadata->'erasure'->'azureTeardown' FROM personal_agent_registry WHERE user_id=%s",
        (owner,),
    )[0][0]
    resource = state["resources"][group] = {}
    resource["intent"] = {"identity": plan["resources"][group]["identity"]}
    assert retain(state) is True
    request_id = str(uuid.uuid4())
    resource["provider_request"] = {
        "requestId": request_id,
        "method": "DELETE",
        "path": group,
        "apiVersion": "2021-04-01",
    }
    assert retain(state) is True
    absence = {"status": "active_resource_absent", "id": group}
    # 404 cannot settle an uncertain provider operation.
    resource["absence"] = absence
    assert retain(state) is False
    del resource["absence"]
    resource["provider_ack"] = {
        "requestId": request_id,
        "status": 200,
        "operationUrl": None,
        "operationUrlSha256": None,
    }
    assert retain(state) is True
    resource["provider_terminal"] = {"requestId": request_id, "outcome": "succeeded"}
    assert retain(state) is True
    resource["absence"] = absence
    assert retain(state) is True


@pytest.mark.parametrize("interrupted", [False, True])
async def test_actual_arm_transport_retains_cleanup_receipts_on_its_live_sql_session(
    cleanup_state, interrupted
):
    from contextlib import asynccontextmanager

    import asyncpg

    from hushh_mcp.services.azure_arm_client import ArmClient, ArmError
    from hushh_mcp.services.azure_teardown_authority import azure_teardown_authority
    from hushh_mcp.services.azure_teardown_inventory import TeardownResource
    from hushh_mcp.services.azure_teardown_receipts import TeardownMutationJournal
    from hushh_mcp.services.azure_teardown_reconciliation import reconcile_delete
    from tests.test_azure_arm_client import _Response, _Session

    pg, owner, reservation, plan, state, retain = cleanup_state
    assert retain(state) is True
    assert _approve_cleanup(pg, owner, reservation, plan)
    path = next(iter(plan["resources"]))
    resource = TeardownResource(path, "2021-04-01", "resource", {})
    poll = f"https://management.azure.com/subscriptions/{path.split('/')[2]}/operations/cleanup?api-version=2021-04-01"
    session = (
        _Session(_Response(202, {}, {"Azure-AsyncOperation": poll}), _Response(503, {}))
        if interrupted
        else _Session(_Response(200))
    )

    @asynccontextmanager
    async def connection():
        conn = await asyncpg.connect(
            host=str(pg.dir), port=pg.port, user="hushh", database="postgres"
        )
        try:
            yield conn
        finally:
            await conn.close()

    async with azure_teardown_authority(
        owner=owner, attempt=reservation["attemptId"], connection_factory=connection
    ) as authority:

        def delete():
            authority.assert_parent_approved(resource)
            assert authority.retain(resource, "intent", {"identity": {"id": path}})
            arm = ArmClient("synthetic-token", session=session, sleep=lambda _: None)
            arm = arm.with_write_guard(authority.assert_admitted).with_mutations(
                TeardownMutationJournal(authority, resource)
            )
            arm.delete(path, api_version=resource.api_version)
            return authority.state(resource)

        if interrupted:
            with pytest.raises(ArmError):
                await asyncio.to_thread(delete)
            assert "provider_terminal" not in authority.state(resource)
        else:
            receipts = await asyncio.to_thread(delete)
    if interrupted:
        # A new real SQL worker observes the original dispatch after restart.
        # It never invents a new request ID or repeats the provider DELETE.
        resumed = _Session(_Response(200, {"status": "Succeeded"}))
        async with azure_teardown_authority(
            owner=owner, attempt=reservation["attemptId"], connection_factory=connection
        ) as authority:
            client = ArmClient("synthetic-token", session=resumed, sleep=lambda _: None)
            receipts = await asyncio.to_thread(reconcile_delete, client, resource, authority)
        assert [call["method"] for call in session.sent] == ["DELETE", "GET"]
        assert [call["method"] for call in resumed.sent] == ["GET"]
    assert receipts["provider_terminal"]["outcome"] == "succeeded"
    assert receipts["provider_ack"]["requestId"] == receipts["provider_request"]["requestId"]
