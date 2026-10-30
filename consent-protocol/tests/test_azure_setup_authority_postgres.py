"""Actual Azure transport and durable owner-worker authority over PostgreSQL."""

from __future__ import annotations

import asyncio
import json

import pytest

from hushh_mcp.services.azure_setup_plan import group_id
from tests.fixtures.azure_hosted_worker import _hosted_worker, _prepared_worker
from tests.test_azure_arm_client import _Response, _Session
from tests.test_byoc_setup_job_azure_admission_postgres import (
    GROUP,
    OWNER,
    PARKED,
    SUB,
    TENANT,
    psycopg2,
)  # noqa: F401 - shared temporary PostgreSQL fixture and availability marker
from tests.test_byoc_setup_job_azure_admission_postgres import pg as pg
from tests.test_byoc_setup_job_azure_admission_postgres import pytestmark as pg_availability

pytestmark = pg_availability


class _ErasingSession(_Session):
    def __init__(self, pg, *responses):
        super().__init__(*responses)
        self._pg = pg

    def request(self, method, url, **kwargs):
        if method == "PUT":
            # The existing SQL erasure reservation fences new writes while
            # preserving the already-admitted cloud request's eventual result.
            stages = self._pg.execute(
                "SELECT stages FROM byoc_setup_jobs WHERE user_id=%s", (OWNER,)
            )[0][0]
            assert stages[-1]["stage"] == "azure_provider_request"
            self._pg.execute(
                "SELECT reserve_personal_agent_erasure(%s,%s)", (OWNER, "attempt-transport")
            )
            request = stages[-1]
            ack = {
                "stage": "azure_provider_ack",
                "jobId": "job-1",
                "executionId": request["executionId"],
                "requestId": request["requestId"],
                "status": 200,
                "operationUrl": None,
                "operationUrlSha256": None,
            }
            for invalid in (
                [None],
                [{"unknown": "not-a-receipt"}],
                [ack, {**ack, "status": 503}],
            ):
                with pytest.raises(psycopg2.errors.InsufficientPrivilege):
                    self._pg.execute(
                        "UPDATE byoc_setup_jobs SET stages=stages||%s::jsonb WHERE user_id=%s",
                        (json.dumps(invalid), OWNER),
                    )
        return super().request(method, url, **kwargs)


async def test_real_azure_transport_retains_late_provider_completion_after_erasure(pg):
    from hushh_mcp.services.azure_arm_client import ArmClient, ArmError
    from hushh_mcp.services.azure_setup_authority import azure_setup_authority

    _repo, connection = await _prepared_worker(pg)

    path = group_id(SUB, GROUP) + "/providers/Microsoft.Storage/storageAccounts/synthetic"
    poll = f"https://management.azure.com/subscriptions/{SUB}/operations/synthetic?api-version=2023-05-01"

    async with azure_setup_authority(
        owner=OWNER, job="job-1", connection_factory=connection
    ) as authority:
        # Another connection cannot steal the owner worker's session lease.
        async with connection() as other:
            assert (
                await other.fetchval(
                    "SELECT begin_byoc_azure_worker($1,$2,$3)",
                    OWNER,
                    "job-1",
                    "1" * 8 + "-1111-1111-1111-" + "1" * 12,
                )
                is False
            )
        session = _ErasingSession(
            pg,
            _Response(202, {}, {"Location": poll}),
            _Response(200, {}),
            _Response(200, {"id": path}),
        )
        arm = ArmClient("synthetic", session=session, mutations=authority, sleep=lambda _: None)
        assert await asyncio.to_thread(
            arm.put,
            path,
            api_version="2023-05-01",
            body={"private": "must-not-be-retained"},
            op="creating_storage",
        ) == {"id": path}
        with pytest.raises(ArmError, match="MutationAdmissionUnconfirmed"):
            await asyncio.to_thread(
                arm.put, path, api_version="2023-05-01", body={}, op="creating_storage"
            )
        assert len(session.sent) == 3
    stages = pg.execute("SELECT stages FROM byoc_setup_jobs WHERE user_id=%s", (OWNER,))[0][0]
    assert [x["stage"] for x in stages] == [
        "azure_setup_intent",
        "azure_worker_started",
        "azure_provider_request",
        "azure_provider_ack",
        "azure_provider_terminal",
        "azure_worker_exited",
    ]
    assert stages[-2]["outcome"] == "succeeded"
    assert "must-not-be-retained" not in str(stages)
    # No direct rewrite or discarded receipt can invent completion or lose the obligation.
    with pytest.raises(psycopg2.errors.InsufficientPrivilege):
        pg.execute("UPDATE byoc_setup_jobs SET stages='[]'::jsonb WHERE user_id=%s", (OWNER,))


async def test_uncertain_provider_write_survives_retry_and_cannot_be_claimed_by_another_worker(pg):
    import uuid

    from hushh_mcp.services.azure_arm_mutations import (
        ArmMutationAcknowledgement,
        ArmMutationRequest,
    )
    from hushh_mcp.services.azure_setup_applier import AzureSetupRefused
    from hushh_mcp.services.azure_setup_authority import azure_setup_authority

    repo, connection = await _prepared_worker(pg)
    target = group_id(SUB, GROUP)

    async with azure_setup_authority(
        owner=OWNER, job="job-1", connection_factory=connection
    ) as authority:
        request_id = str(uuid.uuid4())
        denied = ArmMutationRequest(
            "PUT", group_id(TENANT, GROUP), "2023-05-01", "creating_storage"
        )
        assert await asyncio.to_thread(authority.admit, str(uuid.uuid4()), denied) is False
        request = ArmMutationRequest("PUT", target, "2021-04-01", "creating_resource_group")
        assert await asyncio.to_thread(authority.admit, request_id, request) is True
        assert (
            await asyncio.to_thread(
                authority.acknowledge, request_id, ArmMutationAcknowledgement(503, None, None)
            )
            is True
        )
        assert await asyncio.to_thread(authority.terminal, request_id, "succeeded") is False
        # No other database session can forge the admitted worker's late outcome.
        async with connection() as other:
            event = {
                "stage": "azure_provider_terminal",
                "jobId": "job-1",
                "requestId": request_id,
                "executionId": authority._execution,
                "outcome": "succeeded",
            }
            assert (
                await other.fetchval(
                    "SELECT retain_byoc_azure_worker_event($1,$2,$3::jsonb)",
                    OWNER,
                    "job-1",
                    json.dumps(event),
                )
                is False
            )
    before = pg.execute("SELECT stages FROM byoc_setup_jobs WHERE user_id=%s", (OWNER,))[0][0]
    pg.execute("UPDATE byoc_setup_jobs SET status='failed' WHERE user_id=%s", (OWNER,))
    assert await repo.start(user_id=OWNER, job_id="job-2", project_id=target)
    after = pg.execute("SELECT stages FROM byoc_setup_jobs WHERE user_id=%s", (OWNER,))[0][0]
    assert after[0] == {**before[0], "stage": "azure_setup_prior_intent"}
    assert after[1:] == before[1:]
    with pytest.raises(AzureSetupRefused, match="reconciliation"):
        async with azure_setup_authority(owner=OWNER, job="job-2", connection_factory=connection):
            pytest.fail("uncertain cloud request cannot admit another worker")


@pytest.mark.parametrize(
    "limit,padding,admitted",
    [("slots", 2042, True), ("slots", 2044, False), ("bytes", 27000, True), ("bytes", 1000, False)],
)
async def test_completion_receipts_have_reserved_capacity_before_arm_dispatch(
    pg, limit, padding, admitted
):
    from hushh_mcp.services.azure_arm_client import ArmClient, ArmError
    from hushh_mcp.services.azure_setup_authority import azure_setup_authority

    _repo, connection = await _prepared_worker(pg)
    async with azure_setup_authority(
        owner=OWNER, job="job-1", connection_factory=connection
    ) as authority:
        if limit == "slots":
            pg.execute(
                "UPDATE byoc_setup_jobs SET stages=stages||(SELECT jsonb_agg("
                "jsonb_build_object('stage','synthetic')) FROM generate_series(1,%s)) WHERE user_id=%s",
                (padding, OWNER),
            )
        else:
            size = pg.execute(
                "SELECT octet_length(stages::text) FROM byoc_setup_jobs WHERE user_id=%s", (OWNER,)
            )[0][0]
            pg.execute(
                "UPDATE byoc_setup_jobs SET stages=stages||jsonb_build_array("
                "jsonb_build_object('stage','synthetic','padding',repeat('x',%s))) WHERE user_id=%s",
                (1048576 - padding - size - 64, OWNER),
            )

        class CapacitySession(_Session):
            def request(self, *args, **kwargs):
                with pytest.raises(psycopg2.errors.InsufficientPrivilege):
                    pg.execute(
                        "UPDATE byoc_setup_jobs SET stages=stages||jsonb_build_array(jsonb_build_object('padding',repeat('x',4096))) WHERE user_id=%s",
                        (OWNER,),
                    )
                return super().request(*args, **kwargs)

        session = CapacitySession(_Response(200, {}))
        arm = ArmClient("synthetic", session=session, mutations=authority)
        work = asyncio.to_thread(
            arm.put,
            group_id(SUB, GROUP),
            api_version="2021-04-01",
            body={},
            op="creating_resource_group",
        )
        if admitted:
            assert await work == {}
        else:
            with pytest.raises(ArmError, match="MutationAdmissionUnconfirmed"):
                await work
        assert len(session.sent) == int(admitted)
    stages = pg.execute("SELECT stages FROM byoc_setup_jobs WHERE user_id=%s", (OWNER,))[0][0]
    assert stages[-1]["stage"] == "azure_worker_exited"
    if admitted:
        if limit == "slots":
            assert len(stages) == 2048
        assert stages[-2]["stage"] == "azure_provider_terminal"


@pytest.mark.parametrize("kind", ["upgrade", "rebuild"])
async def test_hosted_worker_records_only_its_exact_requests_and_keeps_late_outcomes(pg, kind):
    import uuid

    from hushh_mcp.services.azure_arm_mutations import (
        ArmMutationAcknowledgement,
        ArmMutationRequest,
    )
    from hushh_mcp.services.azure_setup_applier import AzureSetupRefused
    from hushh_mcp.services.azure_setup_authority import azure_setup_authority

    connection, intent = await _hosted_worker(pg, kind=kind)
    async with azure_setup_authority(
        owner=OWNER, job="hosted-1", hosted_intent=intent, connection_factory=connection
    ) as authority:
        dispatch = next(
            call for call in intent["allowedRequests"] if call["purpose"] == "deploying_agent"
        )
        request = ArmMutationRequest(
            dispatch["method"], dispatch["path"], dispatch["apiVersion"], dispatch["purpose"]
        )
        # A same-group path is insufficient for an already installed pod.
        altered = ArmMutationRequest(
            request.method, request.path + "-another", request.api_version, request.purpose
        )
        assert not await asyncio.to_thread(authority.admit, str(uuid.uuid4()), altered)
        custody = ArmMutationRequest(
            "PUT", group_id(SUB, GROUP), "2021-04-01", "creating_resource_group"
        )
        assert not await asyncio.to_thread(authority.admit, str(uuid.uuid4()), custody)
        request_id = str(uuid.uuid4())
        await asyncio.to_thread(authority.assert_admitted)
        assert await asyncio.to_thread(authority.admit, request_id, request)
        # Revocation fences further actions, while the real worker still owes
        # the outcome for a mutation dispatched before that revocation.
        pg.execute(
            "UPDATE personal_agent_registry SET backend_metadata=jsonb_set(backend_metadata,'{serviceUid}','\"replacement\"') WHERE user_id=%s",
            (OWNER,),
        )
        with pytest.raises(AzureSetupRefused):
            await asyncio.to_thread(authority.assert_admitted)
        assert not await asyncio.to_thread(authority.admit, str(uuid.uuid4()), request)
        assert await asyncio.to_thread(
            authority.acknowledge, request_id, ArmMutationAcknowledgement(200, None, None)
        )
        assert await asyncio.to_thread(authority.terminal, request_id, "succeeded")
    history = pg.execute("SELECT stages FROM byoc_setup_jobs WHERE user_id=%s", (OWNER,))[0][0]
    assert history[-1]["stage"] == "azure_worker_exited"
    assert sum(x["stage"] == "azure_provider_request" for x in history) == 1


@pytest.mark.parametrize(
    "changed", ["lease", "operation", "incarnation", "key", "nonce", "job", "owner", "target"]
)
async def test_hosted_worker_refuses_stale_owner_approval_or_registry_binding(pg, changed):
    from hushh_mcp.services.azure_setup_applier import AzureSetupRefused
    from hushh_mcp.services.azure_setup_authority import azure_setup_authority

    connection, intent = await _hosted_worker(pg)
    if changed == "job":
        intent["jobId"] = "different-job"
    elif changed == "owner":
        intent["binding"]["user_id"] = "different-owner"
    elif changed == "key":
        pg.execute(
            "UPDATE personal_agent_registry SET pod_key_id='replacement' WHERE user_id=%s", (OWNER,)
        )
    else:
        path = {
            "lease": "{upgradeLease}",
            "operation": "{upgradeApproval,operationId}",
            "incarnation": "{serviceUid}",
            "nonce": "{setupNonce}",
            "target": "{upgradeApproval,targetImage}",
        }[changed]
        pg.execute(
            "UPDATE personal_agent_registry SET backend_metadata=jsonb_set(backend_metadata,%s::text[],'\"changed\"') WHERE user_id=%s",
            (path, OWNER),
        )
    with pytest.raises(AzureSetupRefused):
        async with azure_setup_authority(
            owner=OWNER, job="hosted-1", hosted_intent=intent, connection_factory=connection
        ):
            pytest.fail("stale hosted authority admitted")
    history = pg.execute("SELECT stages FROM byoc_setup_jobs WHERE user_id=%s", (OWNER,))[0][0]
    assert not any(x["stage"] == "azure_worker_started" for x in history)


@pytest.mark.parametrize("kind", ["upgrade", "rebuild"])
async def test_supplied_request_list_cannot_grant_custody_writes(pg, kind):
    from hushh_mcp.services.azure_setup_applier import AzureSetupRefused
    from hushh_mcp.services.azure_setup_authority import azure_setup_authority

    connection, intent = await _hosted_worker(pg, kind=kind)
    intent["allowedRequests"].append(
        {
            "method": "PUT",
            "path": group_id(SUB, GROUP)
            + "/providers/Microsoft.KeyVault/vaults/kv-h1-"
            + "a" * 16
            + "/keys/pod-log-key",
            "apiVersion": "2023-07-01",
            "purpose": "creating_key_vault",
        }
    )
    with pytest.raises(AzureSetupRefused):
        async with azure_setup_authority(
            owner=OWNER, job="hosted-1", hosted_intent=intent, connection_factory=connection
        ):
            pytest.fail("self-authorizing custody tuple admitted")


async def test_files_dispatch_requires_current_exact_approved_checkpoint(monkeypatch):
    import hashlib
    import uuid

    from hushh_mcp.services.azure_arm_mutations import ArmMutationRequest
    from hushh_mcp.services.azure_hosted_intent import _request
    from hushh_mcp.services.azure_setup_authority import azure_setup_authority
    from hushh_mcp.services.pod_files.azure_capability import AzureFilesCapabilityPlan
    from hushh_mcp.services.pod_files.azure_checkpoint import AzureFilesUpgradeCheckpoint
    from tests.test_personal_agent_notification_checkpoint import _notification_server

    server = _notification_server(monkeypatch)
    try:
        server.apply_file(PARKED / "957_personal_agent_azure_files_upgrade.sql")
        connection, intent = await _hosted_worker(server, files=True)
        meta = server.execute(
            "SELECT backend_metadata FROM personal_agent_registry WHERE user_id=%s", (OWNER,)
        )[0][0]
        plan = AzureFilesCapabilityPlan.model_validate(meta["upgradeApproval"]["capabilityPlan"])
        checkpoint = AzureFilesUpgradeCheckpoint(
            plan=plan,
            operation_id="operation-1",
            attempt_id=hashlib.sha256(b"synthetic-lease").hexdigest(),
            original_inventory={},
        )
        completed = []
        async with azure_setup_authority(
            owner=OWNER, job="hosted-1", hosted_intent=intent, connection_factory=connection
        ) as authority:
            for call in plan.operations():
                request = _request("PUT", call["path"], call["api"], "files_activation")
                dispatch = ArmMutationRequest(
                    request["method"], request["path"], request["apiVersion"], request["purpose"]
                )
                # Before its own durable intent, neither a later step nor a
                # stale observation can authorize a Files provider request.
                assert not await asyncio.to_thread(authority.admit, str(uuid.uuid4()), dispatch)
                value, inventory = checkpoint.prepare("intent", call["step"], completed)
                server.execute(
                    "UPDATE personal_agent_registry SET backend_metadata=backend_metadata||%s::jsonb WHERE user_id=%s",
                    (
                        json.dumps(
                            {"filesUpgradeCheckpoint": value, "azureFilesInventory": inventory}
                        ),
                        OWNER,
                    ),
                )
                checkpoint.acknowledge(value)
                request_id = str(uuid.uuid4())
                assert await asyncio.to_thread(authority.admit, request_id, dispatch)
                assert await asyncio.to_thread(authority.terminal, request_id, "not_dispatched")
                completed.append(
                    {
                        "step": call["step"],
                        "ok": True,
                        "status": 200,
                        "observation": {
                            "id": call["path"],
                            "kind": call["kind"],
                            "properties": call["body"]["properties"],
                        },
                    }
                )
                value, inventory = checkpoint.prepare("observed", call["step"], completed)
                server.execute(
                    "UPDATE personal_agent_registry SET backend_metadata=backend_metadata||%s::jsonb WHERE user_id=%s",
                    (
                        json.dumps(
                            {"filesUpgradeCheckpoint": value, "azureFilesInventory": inventory}
                        ),
                        OWNER,
                    ),
                )
                checkpoint.acknowledge(value)
    finally:
        server.stop()
