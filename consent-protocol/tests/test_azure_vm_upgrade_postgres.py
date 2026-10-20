"""Existing owner update ledger against real PostgreSQL; provider transport is synthetic."""

from __future__ import annotations

import asyncio
import json
from contextlib import closing

import pytest

from tests.fixtures.azure_vm_power import cleanup_connection as cleanup_connection
from tests.fixtures.azure_vm_power import cleanup_pg as cleanup_pg
from tests.fixtures.azure_vm_power import vm_installation as vm_installation
from tests.test_azure_arm_client import _Response, _Session


@pytest.mark.parametrize("cleanup_pg", ["unreserved"], indirect=True)
@pytest.mark.parametrize("complete", [True, False])
async def test_vm_update_is_ordered_payload_bound_and_unknown_dispatch_stays_fenced(
    vm_installation, cleanup_connection, complete
):
    import uuid

    from hushh_mcp.services.azure_arm_client import ArmClient
    from hushh_mcp.services.azure_setup_applier import AzureSetupRefused
    from hushh_mcp.services.azure_setup_authority import azure_setup_authority
    from tests.fixtures.azure_hosted_worker import vm_upgrade_worker

    server, owner, installed = vm_installation
    plan, intent, *_ = await vm_upgrade_worker(server, owner, installed)
    session = _Session(*[_Response(200, {}) for _ in range(3)])
    async with azure_setup_authority(
        owner=owner, job="vm-upgrade-1", hosted_intent=intent, connection_factory=cleanup_connection
    ) as authority:
        calls = [_request(c) for c in intent["allowedRequests"]]
        assert not await asyncio.to_thread(authority.admit, str(uuid.uuid4()), calls[1])
        for changed in ("bodySha256", "path", "method"):
            c = {
                **intent["allowedRequests"][0],
                changed: {"bodySha256": "0" * 64, "path": installed.resource_id, "method": "PATCH"}[
                    changed
                ],
            }
            assert not await asyncio.to_thread(
                authority.admit,
                str(uuid.uuid4()),
                _request(c),
            )
        await _refuse_changed_bindings(server, owner, authority, calls[0])
        with closing(ArmClient("synthetic", session=session, mutations=authority)) as arm:
            for n, step in enumerate(plan.steps()):
                if n == 1 and not complete:
                    assert await asyncio.to_thread(authority.admit, str(uuid.uuid4()), calls[n])
                    assert not await asyncio.to_thread(
                        authority.admit, str(uuid.uuid4()), calls[n + 1]
                    )
                    break
                assert await asyncio.to_thread(
                    arm.request,
                    step.method,
                    step.path,
                    api_version=intent["allowedRequests"][n]["apiVersion"],
                    body=step.body,
                    op=step.stage,
                    body_sha256=intent["allowedRequests"][n]["bodySha256"],
                )
                assert not await asyncio.to_thread(authority.admit, str(uuid.uuid4()), calls[n])
    assert len(session.sent) == (3 if complete else 1)
    stages = server.execute("SELECT stages FROM byoc_setup_jobs WHERE user_id=%s", (owner,))[0][0]
    current = [e for e in stages if e.get("jobId") == "vm-upgrade-1"]
    assert sum(e["stage"] == "azure_provider_terminal" for e in current) == (3 if complete else 1)
    assert "RunShellScript" not in json.dumps(stages)
    if complete:
        await _refuse_replayed_job(server, owner, installed, plan, cleanup_connection)
    if not complete:
        with pytest.raises(AzureSetupRefused):
            async with azure_setup_authority(
                owner=owner,
                job="vm-upgrade-1",
                hosted_intent=intent,
                connection_factory=cleanup_connection,
            ):
                pytest.fail("unknown RunCommand was replayed")


def _request(call):
    from hushh_mcp.services.azure_arm_mutations import ArmMutationRequest

    return ArmMutationRequest(
        call["method"], call["path"], call["apiVersion"], call["purpose"], call["bodySha256"]
    )


async def _refuse_replayed_job(server, owner, installed, plan, cleanup_connection):
    from hushh_mcp.services.azure_setup_applier import AzureSetupRefused
    from hushh_mcp.services.azure_setup_authority import azure_setup_authority
    from hushh_mcp.services.byoc_setup_job_service import ByocSetupJobRepo
    from tests.test_byoc_setup_job_azure_admission_postgres import _Client

    server.execute("UPDATE byoc_setup_jobs SET status='failed' WHERE user_id=%s", (owner,))
    repo = ByocSetupJobRepo(client=_Client(server))
    assert await repo.start(
        user_id=owner,
        job_id="vm-upgrade-2",
        project_id=installed.resource_id.split("/providers/", 1)[0],
    )
    with pytest.raises(AzureSetupRefused):
        async with azure_setup_authority(
            owner=owner,
            job="vm-upgrade-2",
            hosted_intent=plan.intent(job="vm-upgrade-2"),
            connection_factory=cleanup_connection,
        ):
            pytest.fail("completed owner operation was replayed under a new job")


async def _refuse_changed_bindings(server, owner, authority, request):
    import uuid
    from copy import deepcopy

    row = server.execute(
        "SELECT to_jsonb(r) FROM personal_agent_registry r WHERE user_id=%s", (owner,)
    )[0][0]

    def write(value):
        server.execute(
            "UPDATE personal_agent_registry SET backend_metadata=%s::jsonb,pod_signing_pubkey=%s,placement_epoch=%s WHERE user_id=%s",
            (
                json.dumps(value["backend_metadata"]),
                value["pod_signing_pubkey"],
                value["placement_epoch"],
                owner,
            ),
        )

    try:
        for fault in ("commit", "lease", "host", "signing", "placement"):
            changed = deepcopy(row)
            metadata = changed["backend_metadata"]
            if fault == "commit":
                metadata["upgradeApproval"]["handoffCommittedState"] = "0" * 64
            elif fault == "lease":
                metadata["upgradeLease"] = "another-lease"
            elif fault == "host":
                metadata["vmConfigurationSha256"] = "0" * 64
            elif fault == "signing":
                changed["pod_signing_pubkey"] = "B" * 43 + "="
            else:
                changed["placement_epoch"] += 1
            write(changed)
            assert not await asyncio.to_thread(authority.admit, str(uuid.uuid4()), request)
            write(row)
    finally:
        write(row)


@pytest.mark.parametrize("cleanup_pg", ["unreserved"], indirect=True)
@pytest.mark.parametrize("fault", [None, "release", "host_ack", "recovery_key", "cancel"])
async def test_vm_image_runtime_requires_fresh_drain_and_verified_same_key_recovery(
    vm_installation, cleanup_connection, fault
):
    from dataclasses import replace
    from threading import Event

    from hushh_mcp.services.azure_arm_client import ArmClient
    from hushh_mcp.services.azure_setup_authority import azure_setup_authority
    from hushh_mcp.services.azure_setup_worker import run_setup_thread
    from hushh_mcp.services.azure_vm_image_upgrade import VmImageUpgrade
    from hushh_mcp.services.azure_vm_power_authority import _target
    from tests.fixtures.azure_hosted_worker import vm_upgrade_worker
    from tests.test_azure_vm_lifecycle import Pod
    from tests.test_azure_vm_power import Provider

    server, owner, installed = vm_installation
    binding = server.execute(
        "SELECT azure_vm_power_binding(to_jsonb(r)) FROM "
        "personal_agent_registry r WHERE user_id=%s",
        (owner,),
    )[0][0]
    transport = Provider(_target(binding))
    pod = Pod(binding, transport)
    receipt = await asyncio.to_thread(
        pod.client(url=binding["url"], hushh_id=installed.hushh_id).prepare_and_wait,
        operation_id="vm-update-1",
        incarnation=installed.generation,
    )
    plan, intent, row, spec = await vm_upgrade_worker(server, owner, installed, receipt=receipt)
    acks, calls, clock = [], [], [0.0]
    barrier = (asyncio.Event(), Event())
    spec = replace(spec, on_upgrade_ack=acks.append)
    original = transport.request
    transport.request = _image_transport(
        original, transport, pod, plan, receipt, fault, calls, barrier
    )
    async with azure_setup_authority(
        owner=owner, job="vm-upgrade-1", hosted_intent=intent, connection_factory=cleanup_connection
    ) as authority:
        with closing(ArmClient("synthetic", session=transport)) as source:
            worker = VmImageUpgrade(
                row=row,
                spec=spec,
                plan=plan,
                receipt=receipt,
                handoff=pod.client(url=binding["url"], hushh_id=installed.hushh_id),
                authority=authority,
                clock=lambda: clock[0],
                sleep=lambda _: clock.__setitem__(0, 500.0),
            )

            async def run():
                return await run_setup_thread(
                    worker.run,
                    source=source,
                    guard=authority.assert_admitted,
                    advance=lambda _: None,
                )

            if fault == "cancel":
                task = asyncio.create_task(run())
                await asyncio.wait_for(barrier[0].wait(), 10)
                task.cancel()
                await asyncio.sleep(0)
                barrier[1].set()
                with pytest.raises(asyncio.CancelledError):
                    await task
            elif fault:
                with pytest.raises(RuntimeError):
                    await run()
            else:
                handle = await run()
                assert handle.status == "live" and len(acks) == 1
                assert handle.backend_metadata["image"] == plan.target_image
                proof = handle.backend_metadata["vmUpdateVerification"]
                assert proof["released"]["operationId"] == "vm-update-1"
                assert proof["recovery"]["retainedIdleRecord"] == receipt["idleRecord"]
    assert len(calls) == (3 if fault is None else 1 if fault in {"release", "cancel"} else 2)
    status = await pod.admission.status(incarnation=installed.generation)
    assert (status["state"] == "accepting") is (fault in {None, "release"})


def _image_transport(original, transport, pod, plan, receipt, fault, calls, barrier):
    def send(method, url, **kwargs):
        if method == "GET":
            return original(method, url, **kwargs)
        calls.append(method)
        if len(calls) == 1:
            if fault == "cancel":
                pod.loop.call_soon_threadsafe(barrier[0].set)
                assert barrier[1].wait(10)
            if fault == "release":
                pod.call(
                    pod.admission.release(
                        operation_id="vm-update-1",
                        incarnation=pod.binding["serviceUid"],
                        expected_idle_record=receipt["idleRecord"],
                    )
                )
            return _Response(200, {})
        if len(calls) == 3:
            transport.vm["tags"]["husshPodImage"] = plan.target_image.split("@", 1)[1]
            return _Response(200, {})
        pod.binding["host"]["installation"]["image_digest"] = plan.target_image.split("@", 1)[1]
        pod.restart()
        if fault == "recovery_key":
            pod.tamper = lambda snapshot: snapshot["keys"].update(podPublicKey="different-key")
        ack = {
            "version": 1,
            "operation_id": "vm-update-1",
            "request_sha256": plan.host_request_sha256,
            "configuration_sha256": "e" * 64,
            "image": plan.target_image,
            "stage": "restart_requested",
            "application_verified": False,
        }
        return _Response(
            200, {"value": [{"message": "unconfirmed" if fault == "host_ack" else json.dumps(ack)}]}
        )

    return send
