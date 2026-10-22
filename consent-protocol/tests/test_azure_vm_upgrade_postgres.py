"""Existing owner update ledger against real PostgreSQL; provider transport is synthetic."""

from __future__ import annotations

import asyncio
import json
from contextlib import closing

import pytest

from tests.fixtures.azure_hosted_worker import owner_update as owner_update
from tests.fixtures.azure_vm_power import cleanup_connection as cleanup_connection
from tests.fixtures.azure_vm_power import cleanup_pg as cleanup_pg
from tests.fixtures.azure_vm_power import vm_installation as vm_installation
from tests.test_azure_arm_client import _Response, _Session
from tests.test_azure_vm_lifecycle import lifecycle as lifecycle


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
    assert (
        server.execute(
            "SELECT block_unattempted_azure_vm_upgrade(%s,%s,%s,%s,%s::jsonb)",
            (
                owner,
                intent["jobId"],
                intent["operationId"],
                intent["attemptId"],
                json.dumps(intent["binding"]),
            ),
        )[0][0]
        is None
    )
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
            if fault == "host":
                from psycopg2.errors import InsufficientPrivilege

                with pytest.raises(InsufficientPrivilege, match="verified recovery"):
                    write(changed)
                continue
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


@pytest.mark.parametrize("cleanup_pg", ["unreserved"], indirect=True)
@pytest.mark.parametrize("had_power_cycle", [False, True])
async def test_vm_owner_job_composes_update_and_publishes_image_recovery_atomically(
    owner_update, had_power_cycle
):
    from hushh_mcp.services.azure_agent_observation import AzureJitAuthorizationRequired
    from hushh_mcp.services.azure_hosted_authority import hosted_job
    from hushh_mcp.services.pod_update_identity import verified_upgrade_approval
    from hushh_mcp.services.user_azure_backend import jit_person_authority

    server, owner, pod, plan, intent, spec, repo, backend, writes = owner_update
    with pytest.raises(AzureJitAuthorizationRequired):
        await backend.upgrade(spec)
    with jit_person_authority("synthetic-owner-token"):
        with pytest.raises(RuntimeError, match="approved owner job"):
            await backend.upgrade(spec)
    with (
        jit_person_authority("synthetic-owner-token"),
        hosted_job(owner=owner, job="vm-upgrade-1"),
    ):
        handle = await backend.upgrade(spec)
    before = await repo.get(owner)
    assert not set(handle.backend_metadata) & {
        "upgradeLease",
        "upgradeApproval",
        "upgradeAcknowledgement",
        "vmPower",
    }
    old = before["backend_metadata"]
    if not had_power_cycle:
        for fault in ("keys", "release", "host"):
            if fault == "keys":
                pod.tamper = lambda value: value["keys"].update(podPublicKey="changed-key")
            elif fault == "release":
                pod.tamper = lambda value: value["status"].pop("releaseReceipt", None)
            else:
                pod.tamper = lambda _: pod.provider.vm["properties"].update(vmId="changed-host")
            assert await backend.observe_upgrade(spec, old["upgradeAcknowledgement"]) is None
            pod.provider.vm["properties"]["vmId"] = spec.azure_vm_host.installation.vm_id
        pod.tamper = lambda _: None
    recovered = await backend.observe_upgrade(spec, old["upgradeAcknowledgement"])
    assert recovered.backend_metadata == handle.backend_metadata and len(writes) == 3
    candidate = {**old, **handle.backend_metadata}
    candidate["upgradeAcknowledgement"] = {**old["upgradeAcknowledgement"], "outcome": "ready"}
    candidate["upgradeApproval"] = verified_upgrade_approval(old["upgradeApproval"])
    candidate.pop("upgradeLease")
    candidate.pop("vmPower", None)
    _refuse_vm_publication_changes(server, owner, before, candidate, intent)
    assert await repo.record_image_upgrade(
        user_id=owner,
        backend_metadata=candidate,
        expected_lease=old["upgradeLease"],
        previous_metadata=old,
        observed=before,
    )
    after = (await repo.get(owner))["backend_metadata"]
    assert after["image"] == plan.target_image and "vmPower" not in after
    assert ("previousPower" in after["vmUpdateVerification"]) is had_power_cycle
    assert after["upgradeApproval"]["presentationPhase"] == "verified"
    assert backend.live is False


def _refuse_vm_publication_changes(server, owner, before, candidate, intent):
    from copy import deepcopy

    from psycopg2.errors import InsufficientPrivilege

    for fault in ("power", "root_hash", "configuration", "release", "key", "host", "lease"):
        value, key, replacement = deepcopy(candidate), "backend_metadata", None
        if fault == "power":
            value["vmPower"] = before["backend_metadata"].get("vmPower", {"phase": "ready"})
        elif fault == "root_hash":
            value["vmUpdateVerification"]["host"]["request_sha256"] = "0" * 64
        elif fault == "configuration":
            value["vmConfigurationSha256"] = "0" * 64
        elif fault == "release":
            value["vmUpdateVerification"].pop("released")
        elif fault == "key":
            key, replacement = "pod_pubkey", "changed-public-key"
        elif fault == "host":
            value["vmHost"]["installation"]["generation"] = "vm_" + "a" * 32
        elif fault == "lease":
            value["upgradeLease"] = "wrong-lease"
        with pytest.raises(InsufficientPrivilege, match="verified recovery"):
            server.execute(
                "UPDATE personal_agent_registry SET backend_metadata=%s::jsonb"
                + (",pod_pubkey=%s" if key == "pod_pubkey" else "")
                + " WHERE user_id=%s",
                (json.dumps(value), replacement, owner)
                if replacement
                else (json.dumps(value), owner),
            )
    history = server.execute("SELECT stages FROM byoc_setup_jobs WHERE user_id=%s", (owner,))[0][0]
    missing = [
        e
        for e in history
        if not (e.get("stage") == "azure_provider_terminal" and e.get("outcome") == "succeeded")
    ]
    assert (
        server.execute(
            "SELECT azure_vm_upgrade_dispatch_settled(%s::jsonb,%s::jsonb)",
            (json.dumps(intent), json.dumps(missing)),
        )[0][0]
        is False
    )


@pytest.mark.parametrize("cleanup_pg", ["unreserved"], indirect=True)
@pytest.mark.parametrize("had_power_cycle", [False])
@pytest.mark.parametrize("fault", ["credentials", "cancel"])
async def test_vm_pre_dispatch_failure_releases_only_proven_unattempted_drain(
    owner_update, monkeypatch, fault
):
    from dataclasses import replace
    from threading import Event

    from hushh_mcp.services.azure_hosted_authority import hosted_job
    from hushh_mcp.services.user_azure_backend import jit_person_authority

    _, owner, pod, _, _, spec, repo, backend, writes = owner_update

    def refuse(*_):
        raise RuntimeError("synthetic image reader unavailable")

    ready, proceed, loop = asyncio.Event(), Event(), asyncio.get_running_loop()

    def idle(receipt):
        loop.call_soon_threadsafe(ready.set)
        assert proceed.wait(10)

    if fault == "credentials":
        monkeypatch.setattr("hushh_mcp.services.azure_image_source.import_credentials", refuse)
    else:
        spec = replace(spec, on_upgrade_idle=idle)
    with jit_person_authority("synthetic-owner-token"), hosted_job(owner=owner, job="vm-upgrade-1"):
        if fault == "credentials":
            with pytest.raises(RuntimeError, match="synthetic image reader unavailable"):
                await backend.upgrade(spec)
        else:
            task = asyncio.create_task(backend.upgrade(spec))
            try:
                await asyncio.wait_for(ready.wait(), 10)
                task.cancel()
                await asyncio.sleep(0)
            finally:
                proceed.set()
            with pytest.raises(asyncio.CancelledError):
                await task
    metadata = (await repo.get(owner))["backend_metadata"]
    assert metadata["upgradeLease"] and metadata["upgradeApproval"]["status"] == "blocked"
    assert metadata["upgradeApproval"]["failureCode"] == "VM_UPDATE_NOT_DISPATCHED"
    status = await pod.admission.status(incarnation=spec.expected_service_uid)
    assert status["state"] == "accepting" and writes == []
