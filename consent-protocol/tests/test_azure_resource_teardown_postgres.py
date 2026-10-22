"""Owner cleanup approval and provider settlement through real PostgreSQL."""

from __future__ import annotations

import asyncio
import copy
import json
import uuid
from contextlib import asynccontextmanager
from pathlib import Path

import asyncpg
import pytest

from tests.fixtures.azure_teardown import (
    partial_setup_state,
    retain_provider_checkpoint,
    seed_qualified_history,
)


@pytest.fixture
def cleanup_pg(monkeypatch, request):
    from tests.pkm_conformance.postgres_harness import find_pg_bin
    from tests.test_owner_access_erasure_migration import (
        HUSHH_ID,
        OWNER,
        SUB,
        TENANT,
        _reserve,
        _resource_group,
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
            "963_personal_agent_operator_mail_custody.sql",
        ):
            server.apply_file(parked / name)
        group = f"/subscriptions/{SUB}/resourceGroups/{_resource_group()}"
        if getattr(request, "param", True):
            seed_qualified_history(
                server,
                OWNER,
                HUSHH_ID,
                SUB,
                TENANT,
                _resource_group(),
                getattr(request, "param", True),
            )
            partial = partial_setup_state(server, getattr(request, "param", True), OWNER, HUSHH_ID)
            if partial is not None:
                yield partial
                return
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
            if getattr(request, "param", True) == "unreserved":
                yield server, OWNER, None, None
                return
            reservation = server.execute(
                "SELECT reserve_personal_agent_erasure(%s,'attempt-1')", (OWNER,)
            )[0][0]
            retain_provider_checkpoint(server, reservation, getattr(request, "param", True))
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
        "termsVersion": "azure-exact-parent-retention-v2",
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
    state = {
        "plan": plan,
        "approvals": [],
        "resources": {},
        "setupHistory": pg.execute("SELECT azure_erasure_setup_history(%s)", (owner,))[0][0],
    }

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


@pytest.fixture
def cleanup_connection(cleanup_pg):
    pg = cleanup_pg[0]

    @asynccontextmanager
    async def connection():
        conn = await asyncpg.connect(
            host=str(pg.dir), port=pg.port, user="hushh", database="postgres"
        )
        try:
            yield conn
        finally:
            await conn.close()

    return connection


def _approve_cleanup(pg, owner, reservation, plan):
    digest = pg.execute(
        "SELECT encode(sha256(convert_to(%s::jsonb::text,'UTF8')),'hex')", (json.dumps(plan),)
    )[0][0]
    return pg.execute(
        "SELECT approve_azure_erasure_plan(%s,%s,%s,%s)",
        (
            owner,
            reservation["attemptId"],
            digest,
            f"/subscriptions/{plan['context']['subscriptionId']}/resourceGroups/{plan['context']['resourceGroup']}",
        ),
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
        assert foreign.execute_raw(
            "SELECT retain_azure_erasure_execution_receipt(:owner,:attempt,:execution,"
            "'workerExits','failed',NULL) AS retained",
            {"owner": owner, "attempt": reservation["attemptId"], "execution": execution},
        ).data == [{"retained": False}]
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
    cleanup_state, cleanup_connection, interrupted
):
    from hushh_mcp.services.azure_arm_client import ArmClient, ArmError
    from hushh_mcp.services.azure_teardown_authority import azure_teardown_authority
    from hushh_mcp.services.azure_teardown_inventory import AzureTeardownRefused, TeardownResource
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
        else _Session(_Response(200), _Response(404))
    )

    async with azure_teardown_authority(
        owner=owner, attempt=reservation["attemptId"], connection_factory=cleanup_connection
    ) as authority:

        def delete(**kwargs):
            kwargs["guard"]()
            authority.assert_parent_approved(resource)
            assert authority.retain(resource, "intent", {"identity": {"id": path}})
            arm = ArmClient("synthetic-token", session=session, sleep=lambda _: None)
            arm = arm.with_write_guard(authority.assert_admitted).with_mutations(
                TeardownMutationJournal(authority, resource)
            )
            arm.delete(path, api_version=resource.api_version)
            assert arm.get_or_none(path, api_version=resource.api_version) is None
            assert authority.retain(
                resource, "absence", {"status": "active_resource_absent", "id": path}
            )
            assert authority.retain_final_readback((path + "/wrong",)) is False
            assert authority.retain_final_readback((path,)) is True
            with pytest.raises(AzureTeardownRefused):
                authority.assert_admitted()
            return authority.state(resource)

        if interrupted:
            with pytest.raises(ArmError):
                await authority.run_worker(delete)
            assert "provider_terminal" not in authority.state(resource)
        else:
            receipts = await authority.run_worker(delete)
    if interrupted:
        # A new real SQL worker observes the original dispatch after restart.
        # It never invents a new request ID or repeats the provider DELETE.
        resumed = _Session(_Response(200, {"status": "Succeeded"}))
        async with azure_teardown_authority(
            owner=owner, attempt=reservation["attemptId"], connection_factory=cleanup_connection
        ) as authority:
            client = ArmClient("synthetic-token", session=resumed, sleep=lambda _: None)
            receipts = await authority.run_worker(
                lambda **_: reconcile_delete(client, resource, authority)
            )
        assert [call["method"] for call in session.sent] == ["DELETE", "GET"]
        assert [call["method"] for call in resumed.sent] == ["GET"]
    assert receipts["provider_terminal"]["outcome"] == "succeeded"
    assert receipts["provider_ack"]["requestId"] == receipts["provider_request"]["requestId"]
    observed = pg.execute(
        "SELECT backend_metadata#>'{erasure,azureTeardown}' FROM personal_agent_registry WHERE user_id=%s",
        (owner,),
    )[0][0]
    exits = list(observed["workerExits"].values())
    assert [value["outcome"] for value in exits].count("failed") == int(interrupted)
    assert len(exits) == 1 + int(interrupted)
    assert bool(observed.get("finalReadbacks")) is not interrupted
    assert sum(value["finalReadbackSha256"] is not None for value in exits) == int(not interrupted)


@pytest.mark.parametrize("cancel_during", ["thread", "receipt"])
async def test_cleanup_cancellation_joins_thread_and_exit_receipt_before_releasing_session(
    cleanup_state, cleanup_connection, monkeypatch, cancel_during
):
    from threading import Event

    from hushh_mcp.services.azure_teardown_authority import azure_teardown_authority

    pg, owner, reservation, plan, state, retain = cleanup_state
    assert retain(state) is True
    assert _approve_cleanup(pg, owner, reservation, plan)
    loop = asyncio.get_running_loop()
    entered, exiting, persist = asyncio.Event(), asyncio.Event(), asyncio.Event()
    release, stopped = Event(), Event()
    writes = []

    def worker(**kwargs):
        loop.call_soon_threadsafe(entered.set)
        try:
            assert release.wait(5)
            authority.assert_admitted()
            writes.append("synthetic-next-write")
        finally:
            stopped.set()

    async with azure_teardown_authority(
        owner=owner, attempt=reservation["attemptId"], connection_factory=cleanup_connection
    ) as authority:
        original = authority._retain_execution

        async def retain_exit(*args):
            assert stopped.is_set(), "exit cannot be recorded while the real thread is alive"
            exiting.set()
            await persist.wait()
            return await original(*args)

        monkeypatch.setattr(authority, "_retain_execution", retain_exit)
        task = asyncio.create_task(authority.run_worker(worker))
        try:
            await asyncio.wait_for(entered.wait(), 5)
            if cancel_during == "thread":
                task.cancel()
                await asyncio.sleep(0)
                task.cancel()
                assert not task.done() and not stopped.is_set()
            release.set()
            await asyncio.wait_for(exiting.wait(), 5)
            task.cancel()
            await asyncio.sleep(0)
            task.cancel()
            assert not task.done(), "receipt persistence must be joined before connection close"
            persist.set()
            with pytest.raises(asyncio.CancelledError):
                await asyncio.wait_for(task, 5)
        finally:
            release.set()
            persist.set()
            if not task.done():
                task.cancel()
                await asyncio.gather(task, return_exceptions=True)
    observed = pg.execute(
        "SELECT backend_metadata#>'{erasure,azureTeardown}' FROM personal_agent_registry WHERE user_id=%s",
        (owner,),
    )[0][0]
    exits = list(observed["workerExits"].values())
    assert len(exits) == 1 and exits[0]["finalReadbackSha256"] is None
    assert exits[0]["outcome"] == ("cancelled" if cancel_during == "thread" else "returned")
    assert bool(writes) == (cancel_during == "receipt")
    assert "finalReadbacks" not in observed


def _canonical_cleanup_plan(context):
    from hushh_mcp.services.azure_setup_plan import PlanInputs, Scopes, resource_names
    from hushh_mcp.services.azure_teardown_inventory import inventory
    from tests.fixtures.azure_teardown import CREATED

    inputs = PlanInputs(
        context["hushhId"],
        context["tenantId"],
        context["subscriptionId"],
        context["location"],
        context["resourceGroup"],
        context["setupNonce"],
        files_enabled=True,
    )
    resources = inventory(
        inputs,
        pod_principal="11111111-1111-1111-1111-111111111111",
        hub_principal="88888888-8888-8888-8888-888888888888",
        pod_incarnation="incarnation-1",
    )
    values = {
        r.path: {
            "apiVersion": r.api_version,
            "kind": r.kind,
            "expected": r.expected,
            "coveredBy": r.covered_by,
            "identity": None,
            "deletionScope": "whole_group"
            if r.path.endswith("/resourceGroups/" + inputs.resource_group)
            else "all_contents"
            if r.kind == "resource"
            else "resource_only",
        }
        for r in resources
    }
    storage = Scopes(inputs, resource_names(inputs)).storage
    values[storage]["identity"] = {"id": storage, "createdAt": CREATED}
    return (
        inputs,
        resources,
        {
            "version": 1,
            "context": context,
            "resources": values,
            "termsVersion": "azure-exact-parent-retention-v2",
        },
    )


async def test_full_inventory_retains_original_setup_and_bounded_provider_retention(
    cleanup_state, cleanup_connection
):
    from types import SimpleNamespace

    from hushh_mcp.services.azure_teardown_authority import azure_teardown_authority
    from hushh_mcp.services.azure_teardown_retention import observe_retention, retention_target
    from tests.fixtures.azure_teardown import retention_body

    pg, owner, reservation, old_plan, state, retain = cleanup_state
    inputs, resources, plan = _canonical_cleanup_plan(old_plan["context"])
    state["plan"] = plan
    forged = {**state, "setupHistory": []}
    assert retain(forged) is False
    assert retain(state) is True
    assert _approve_cleanup(pg, owner, reservation, plan)
    async with azure_teardown_authority(
        owner=owner, attempt=reservation["attemptId"], connection_factory=cleanup_connection
    ) as authority:

        def observe(**kwargs):
            for resource in resources:
                target = retention_target(resource, inputs)
                receipt = (
                    None
                    if target is None
                    else observe_retention(
                        SimpleNamespace(
                            get_or_none=lambda *a, resource=resource, target=target, **k: (
                                retention_body(inputs, resource.path, target[0])
                            )
                        ),
                        inputs,
                        resource,
                        plan["resources"][resource.path]["identity"],
                    )
                )
                if receipt is None:
                    continue
                assert (
                    authority.retain(resource, "retention", receipt) is False
                )  # no active absence yet
                assert authority.retain(
                    resource, "absence", {"id": resource.path, "status": "active_resource_absent"}
                )
                assert (
                    authority.retain(
                        resource, "retention", {**receipt, "physicalPurgeVerified": True}
                    )
                    is False
                )
                assert (
                    authority.retain(
                        resource,
                        "retention",
                        {**receipt, "providerRecord": receipt["providerRecord"] + "/foreign"},
                    )
                    is False
                )
                assert authority.retain(resource, "retention", receipt)
            return True

        assert await authority.run_worker(observe) is True
    current = pg.execute(
        "SELECT backend_metadata->'erasure' FROM personal_agent_registry WHERE user_id=%s", (owner,)
    )[0][0]
    assert (
        current["azureTeardown"]["setupHistory"]
        == pg.execute("SELECT stages FROM byoc_setup_jobs WHERE user_id=%s", (owner,))[0][0]
    )
    root = Path(__file__).resolve().parents[1] / "db/migrations"
    pg.apply_file(root / "parked/963_personal_agent_operator_mail_custody.sql")
    archived = pg.execute(
        "SELECT personal_agent_erasure_archive(%s::jsonb,'{}'::jsonb)", (json.dumps(current),)
    )[0][0]
    assert archived["receipts"]["azureCleanup"] == current["azureTeardown"]
    with pytest.raises(Exception, match="forward recovery"):
        pg.apply_file(root / "rollback/963_personal_agent_operator_mail_custody.rollback.sql")
    pg.execute("ROLLBACK")
    assert pg.execute("SELECT personal_agent_erasure_complete(%s)", (owner,))[0][0] is False


@pytest.fixture
async def settled_cleanup(cleanup_state, cleanup_connection, request):
    from types import SimpleNamespace

    from hushh_mcp.services.azure_arm_client import ArmClient
    from hushh_mcp.services.azure_resource_teardown import execute
    from hushh_mcp.services.azure_teardown_authority import azure_teardown_authority
    from tests.test_owner_access_erasure_migration import _receipt, _retain

    pg, owner, reservation, prior, state, retain = cleanup_state
    inputs, resources, plan = _canonical_cleanup_plan(prior["context"])
    state["plan"] = plan
    if plan["context"].get("neverDeployed") is True:
        forged = copy.deepcopy(state)
        app = next(p for p in plan["resources"] if p.endswith("/containerApps/ca-hussh-one-pod"))
        forged["plan"]["resources"][app]["identity"] = {"id": app}
        assert retain(forged) is False
    assert retain(state) is True
    assert _approve_cleanup(pg, owner, reservation, plan)
    current = pg.execute(
        "SELECT backend_metadata->'erasure' FROM personal_agent_registry WHERE user_id=%s", (owner,)
    )[0][0]
    if getattr(request, "param", False):
        assert _retain(pg, current, _receipt()) is True

    class AbsentAzure:
        def request(self, method, *args, **kwargs):
            assert method == "GET", "an already-absent inventory must not issue another DELETE"
            return SimpleNamespace(status_code=404, headers={}, json=lambda: {})

    # Real transport, executor, durable SQL and joined worker, synthetic provider.
    arm = ArmClient("synthetic-memory-only", session=AbsentAzure())
    async with azure_teardown_authority(
        owner=owner, attempt=reservation["attemptId"], connection_factory=cleanup_connection
    ) as authority:
        await authority.run_worker(
            lambda **_kwargs: execute(
                arm,
                inputs,
                resources,
                authority,
                {p: v["identity"] for p, v in plan["resources"].items() if not v["coveredBy"]},
            )
        )
    pg.apply_file(
        Path(__file__).resolve().parents[1]
        / "db/migrations/parked/963_personal_agent_operator_mail_custody.sql"
    )
    current = pg.execute(
        "SELECT backend_metadata->'erasure' FROM personal_agent_registry WHERE user_id=%s", (owner,)
    )[0][0]
    assert (
        pg.execute(
            "SELECT azure_erasure_resources_complete(%s,%s::jsonb)", (owner, json.dumps(current))
        )[0][0]
        is True
    )
    return pg, owner, current, cleanup_connection


@pytest.mark.parametrize(
    "change",
    [
        None,
        "old_terms",
        "missing_parent",
        "missing_retention",
        "stale_final",
        "other_exit",
        "failed_exit",
        "legacy_coverage",
        "writer_changed",
    ],
)
async def test_account_completion_rechecks_current_same_execution_and_retained_coverage(
    settled_cleanup, change
):
    pg, owner, current, _ = settled_cleanup
    changed = copy.deepcopy(current)
    state = changed["azureTeardown"]
    execution = state["worker"]["executionId"]
    if change == "old_terms":
        state["plan"]["termsVersion"] = "azure-exact-parent-v1"
    elif change == "missing_parent":
        path = next(p for p in state["plan"]["resources"] if "/containerApps/" in p)
        del state["plan"]["resources"][path]
    elif change == "missing_retention":
        path = next(p for p, v in state["resources"].items() if "retention" in v)
        del state["resources"][path]["retention"]
    elif change == "stale_final":
        state["finalReadbacks"][execution]["resourcesSha256"] = "a" * 64
    elif change == "other_exit":
        state["workerExits"][str(uuid.uuid4())] = state["workerExits"].pop(execution)
    elif change == "failed_exit":
        state["workerExits"][execution]["outcome"] = "failed"
    elif change == "legacy_coverage":
        changed["agentCryptoErase"]["agentErased"].pop("providerCoverage")
    elif change == "writer_changed":
        state["setupHistory"].append({"stage": "azure_worker_started", "executionId": "late"})
    assert bool(
        pg.execute(
            "SELECT azure_erasure_resources_complete(%s,%s::jsonb)", (owner, json.dumps(changed))
        )[0][0]
    ) is (change is None)
    assert pg.execute("SELECT personal_agent_erasure_complete(%s)", (owner,))[0][0] is True


@pytest.mark.parametrize("settled_cleanup", [True], indirect=True)
async def test_account_finalization_waits_for_actual_worker_and_preserves_crypto_receipts(
    settled_cleanup,
):
    pg, owner, current, connection = settled_cleanup
    async with connection() as other:
        await other.execute("SELECT pg_advisory_lock(hashtextextended($1,206))", owner)
        assert pg.execute("SELECT personal_agent_erasure_complete(%s)", (owner,))[0][0] is False
    assert pg.execute("SELECT personal_agent_erasure_complete(%s)", (owner,))[0][0] is True
    pg.execute(
        "INSERT INTO account_deletion_tombstones(user_id_hash,firebase_uid,cleanup_status) "
        "VALUES ('sha256:'||encode(sha256(convert_to(%s,'UTF8')),'hex'),%s,'pending')",
        (owner, owner),
    )
    assert pg.execute("SELECT finalize_personal_agent_erasure(%s)", (owner,))[0][0] is True
    archive = pg.execute(
        "SELECT metadata FROM personal_agent_deletion_tombstones WHERE status='erasure_completed'"
    )[0][0]
    assert archive["receipts"]["agentCryptoErase"] == current["agentCryptoErase"]
    assert archive["receipts"]["ownerAccessErasure"] == current["ownerAccessErasure"]
    assert archive["receipts"]["azureCleanup"] == current["azureTeardown"]
    assert (
        pg.execute("SELECT count(*) FROM personal_agent_registry WHERE user_id=%s", (owner,))[0][0]
        == 0
    )


async def test_cleanup_readiness_and_early_failure_are_observable_without_credentials(
    cleanup_state,
):
    from hushh_mcp.services.azure_entra_authorizer import AuthorizationState
    from hushh_mcp.services.azure_teardown_store import AzureTeardownStore
    from tests.test_byoc_setup_job_azure_admission_postgres import _Client
    from tests.test_personal_agent_never_hosted_erasure_postgres import _repo

    pg, owner, reservation, plan, state, retain = cleanup_state
    assert retain(state) is True
    assert _approve_cleanup(pg, owner, reservation, plan)
    store = AzureTeardownStore(_repo(_Client(pg)))
    await store.require_completion_contract()
    grant = await store.authorization(owner, "execute")
    selection = AuthorizationState(
        owner,
        "teardown",
        plan["context"]["subscriptionId"],
        plan["context"]["tenantId"],
        "opaque-synthetic-nonce",
        erasure_attempt=reservation["attemptId"],
        erasure_digest=grant["digest"],
    )
    await store.mark_authorization(owner, selection, "execute", "running", "STARTED")
    await store.mark_authorization(
        owner, selection, "execute", "attention_required", "RETRY_REQUIRED"
    )
    view = await store.view(owner)
    assert view["canFinalize"] is False
    assert view["authorizationOutcome"]["status"] == "attention_required"
    assert view["authorizationOutcome"]["code"] == "RETRY_REQUIRED"
    assert "opaque-synthetic-nonce" not in json.dumps(view)
    # 962 alone must not enable destruction against the older lossy archive.
    older = (
        Path(__file__).resolve().parents[1]
        / "db/migrations/parked/954_personal_agent_never_hosted_erasure.sql"
    )
    source = older.read_text()
    start = source.index("CREATE OR REPLACE FUNCTION public.personal_agent_erasure_archive(")
    pg.execute(source[start : source.index("$$;", start) + 3])
    assert pg.execute("SELECT azure_account_cleanup_ready()")[0][0] is False


@pytest.mark.parametrize("cleanup_pg", ["unreserved"], indirect=True)
def test_compatibility_preflight_snapshot_cannot_reserve_a_changed_or_different_pod(cleanup_pg):
    pg, owner, _, _ = cleanup_pg
    digest = pg.execute(
        "SELECT azure_cleanup_candidate_digest(to_jsonb(p)) FROM personal_agent_registry p WHERE user_id=%s",
        (owner,),
    )[0][0]
    assert (
        pg.execute("SELECT reserve_azure_account_cleanup(%s,%s)", (owner, "f" * 64))[0][0] is None
    )
    assert (
        pg.execute("SELECT status FROM personal_agent_registry WHERE user_id=%s", (owner,))[0][0]
        == "provisioned"
    )
    reserved = pg.execute("SELECT reserve_azure_account_cleanup(%s,%s)", (owner, digest))[0][0]
    assert reserved["registrySnapshot"]["user_id"] == owner
    assert "agentCryptoErase" not in reserved
