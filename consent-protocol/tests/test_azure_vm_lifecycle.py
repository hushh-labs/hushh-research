"""Real registry + sealed admission across a synthetic VM drain/restart/release."""

from __future__ import annotations

import asyncio
import hashlib
import json
from copy import deepcopy
from threading import Event
from types import SimpleNamespace

import pytest

from hushh_mcp.services.azure_arm_client import ArmClient
from hushh_mcp.services.azure_vm_lifecycle import run_vm_lifecycle
from hushh_mcp.services.azure_vm_power import AzureVmPowerRefused
from hushh_mcp.services.azure_vm_power_authority import _target, azure_vm_power_authority
from hushh_mcp.services.pod_upgrade_admission import PodUpgradeAdmission
from hushh_mcp.services.pod_upgrade_handoff import (
    PodUpgradeHandoffClient,
    PodUpgradeHandoffUnavailable,
)
from tests.fixtures.azure_vm_power import cleanup_connection as cleanup_connection
from tests.fixtures.azure_vm_power import cleanup_pg as cleanup_pg
from tests.fixtures.azure_vm_power import vm_installation as vm_installation
from tests.test_azure_vm_power import Provider
from tests.test_azure_vm_power import setup as setup
from tests.test_pod_upgrade_admission import MemoryLog


class SealedFixture(MemoryLog):
    async def append(self, kind, payload):
        record = await super().append(kind, payload)
        self.records[-1]["sha"] = hashlib.sha256(json.dumps(record).encode()).hexdigest()
        return deepcopy(self.records[-1])


class Pod:
    def __init__(self, binding, provider):
        self.binding, self.provider = binding, provider
        self.loop, self.log = asyncio.get_running_loop(), SealedFixture()
        self.admission = PodUpgradeAdmission(log_resolver=lambda: self.log)
        self.prepared = asyncio.Event()
        self.tamper = lambda snapshot: None
        self.lose_release = False
        self.refuse_release = False

    def restart(self):
        self.admission = PodUpgradeAdmission(log_resolver=lambda: self.log)

    def call(self, awaitable):
        return asyncio.run_coroutine_threadsafe(awaitable, self.loop).result(10)

    def get(self, url, *, headers, allow_redirects, **_):
        assert headers["Authorization"] == "Bearer synthetic-machine"
        assert headers["X-Hushh-Pod-Id"] == self.binding["hushhId"]
        assert allow_redirects is False
        b, i = self.binding, self.binding["host"]["installation"]
        snapshot = {
            "info": {
                "vmInstallation": deepcopy(i),
                "hushhId": b["hushhId"],
                "podMode": True,
                "memoryEnabled": True,
                "storageBackend": "commit_log",
            },
            "keys": {
                "hushhId": b["hushhId"],
                "podKeyDurable": True,
                "podKeyId": b["podKeyId"],
                "podPublicKey": b["podPublicKey"],
                "podSigningKeyId": b["signingKeyId"],
                "podSigningKey": b["signingPublicKey"],
            },
            "status": {
                **self.call(self.admission.status(incarnation=i["generation"])),
                "sessionAuthority": {
                    "state": "held",
                    "hushhId": b["hushhId"],
                    "podKeyId": b["podKeyId"],
                    "incarnation": i["generation"],
                    "epoch": 1,
                },
            },
        }
        self.tamper(snapshot)
        key = (
            "info"
            if url.endswith("/pod/info")
            else ("keys" if url.endswith("/pod/public-key") else "status")
        )
        return SimpleNamespace(status_code=200, json=lambda: snapshot[key])

    def post(self, url, *, json, headers, allow_redirects, **_):
        assert headers["Authorization"] == "Bearer synthetic-machine"
        assert allow_redirects is False
        if url.endswith("/prepare"):
            result = self.call(
                self.admission.prepare(
                    operation_id=json["operationId"], incarnation=json["incarnation"]
                )
            )
            self.loop.call_soon_threadsafe(self.prepared.set)
        else:
            if self.refuse_release:
                self.refuse_release = False
                raise OSError("synthetic restart before release")
            result = self.call(
                self.admission.release(
                    operation_id=json["operationId"],
                    incarnation=json["incarnation"],
                    expected_idle_record=json.get("expectedIdleRecord"),
                )
            )
            if self.lose_release:
                self.lose_release = False
                raise OSError("synthetic lost release acknowledgement")
        return SimpleNamespace(status_code=200, json=lambda: result)

    def client(self, **kwargs):
        return PodUpgradeHandoffClient(
            **kwargs,
            session=self,
            identity_token_provider=lambda audience: "synthetic-machine",
        )


@pytest.fixture
async def lifecycle(vm_installation, cleanup_connection):
    pg, owner, installation = vm_installation
    row = pg.execute(
        "SELECT azure_vm_power_binding(to_jsonb(r)) FROM personal_agent_registry r WHERE user_id=%s",
        (owner,),
    )[0][0]
    provider = Provider(_target(row))
    provider.power = "running"
    pod = Pod(row, provider)
    request = provider.request

    def send(method, url, **kwargs):
        result = request(method, url, **kwargs)
        if method == "POST" and "/start?" in url:
            pod.restart()
        return result

    provider.request = send

    async def run(action):
        return await run_vm_lifecycle(
            owner=owner,
            expected_vm_id=installation.vm_id,
            action=action,
            connection_factory=cleanup_connection,
            arm_factory=lambda tenant: ArmClient(
                "synthetic", session=provider, sleep=lambda _: None
            ),
            handoff_factory=pod.client,
        )

    def state():
        return pg.execute(
            "SELECT backend_metadata->'vmPower' FROM personal_agent_registry WHERE user_id=%s",
            (owner,),
        )[0][0]

    return pod, provider, run, state


@pytest.mark.parametrize("cleanup_pg", ["unreserved"], indirect=True)
@pytest.mark.parametrize("before_release", [False, True])
async def test_vm_active_turn_drain_restart_lost_release_and_warm_wake_use_one_operation(
    lifecycle, before_release, vm_installation
):
    pod, provider, run, state = lifecycle
    with pytest.raises(AzureVmPowerRefused, match="RECEIPT_REQUIRED"):
        await run("wake")
    assert state() is None and provider.posts == []
    permit = await pod.admission.acquire_turn(incarnation=pod.binding["serviceUid"])
    pending = asyncio.create_task(run("deallocate"))
    await asyncio.wait_for(pod.prepared.wait(), 10)
    assert not provider.posts
    await permit.release()
    assert (await pending)["state"] == "sleeping"
    original = state()
    assert original["phase"] == "deallocated"
    pod.lose_release, pod.refuse_release = not before_release, before_release
    with pytest.raises(PodUpgradeHandoffUnavailable):
        await run("wake")
    assert state()["phase"] == "recovered"
    assert len(provider.posts) == 2
    pod.restart()
    assert (await run("wake"))["state"] == "awake"
    completed = state()
    assert completed["operationId"] == original["operationId"]
    assert completed["phase"] == "ready"
    assert sum(e["kind"] == "released" for e in completed["events"]) == 1
    assert sum(r["kind"] == "pod_upgrade_release" for r in pod.log.records) == 1
    assert (await run("wake"))["state"] == "awake"
    assert state() == completed and len(provider.posts) == 2
    # Even a raw authority caller cannot append a later recovery after release
    # or use an old release as evidence for a different recovery epoch.
    future = {
        **next(e for e in reversed(completed["events"]) if e["kind"] == "recovery"),
        "runtimeEpoch": "future-process",
    }
    pg = vm_installation[0]
    assert (
        pg.execute(
            "SELECT valid_azure_vm_power_event(%s::jsonb,%s::jsonb)",
            (json.dumps({**completed, "phase": "recovered"}), json.dumps(future)),
        )[0][0]
        is False
    )
    assert (
        pg.execute(
            "SELECT azure_vm_power_phase_proven(%s::jsonb,'ready')",
            (json.dumps({**completed, "events": [*completed["events"], future]}),),
        )[0][0]
        is False
    )


@pytest.mark.parametrize("cleanup_pg", ["unreserved"], indirect=True)
@pytest.mark.parametrize(
    "changed", ["image", "vm", "owner", "encryption", "signing", "cursor", "lease"]
)
async def test_vm_recovery_cannot_adopt_changed_identity_keys_or_log(lifecycle, changed):
    pod, provider, run, state = lifecycle
    await run("deallocate")

    def tamper(snapshot):
        if changed in {"image", "vm"}:
            snapshot["info"]["vmInstallation"][
                "image_digest" if changed == "image" else "vm_id"
            ] = "different"
        elif changed == "owner":
            snapshot["info"]["hushhId"] = "different-owner"
        elif changed in {"encryption", "signing"}:
            snapshot["keys"]["podPublicKey" if changed == "encryption" else "podSigningKey"] = (
                "different-key"
            )
        elif changed == "lease":
            snapshot["status"]["sessionAuthority"] = {"state": "unavailable"}
        else:
            snapshot["status"]["retainedIdleRecord"] = {"seq": 999, "sha": "0" * 64}

    pod.tamper = tamper
    with pytest.raises(AzureVmPowerRefused, match="RECOVERY"):
        await run("wake")
    assert state()["phase"] == "starting" and len(provider.posts) == 2
    assert not any(r["kind"] == "pod_upgrade_release" for r in pod.log.records)


@pytest.mark.parametrize("cleanup_pg", ["unreserved"], indirect=True)
async def test_cancelled_vm_worker_holds_exclusion_until_real_thread_exits(
    lifecycle, cleanup_connection
):
    from hushh_mcp.services.azure_setup_worker import AzureSetupCancelled

    pod, provider, run, state = lifecycle
    await run("deallocate")
    entered, finish = Event(), Event()

    def wait():
        entered.set()
        assert finish.wait(10)

    provider.before_read = wait
    pending = asyncio.create_task(run("wake"))
    try:
        assert await asyncio.to_thread(entered.wait, 10)
        pending.cancel()
        await asyncio.sleep(0)
        assert not pending.done()
        with pytest.raises(AzureVmPowerRefused, match="WORKER_ACTIVE"):
            async with azure_vm_power_authority(
                owner=pod.binding["ownerId"],
                expected_vm_id=provider.vm["properties"]["vmId"],
                create_cycle=False,
                connection_factory=cleanup_connection,
            ):
                pytest.fail("cancelled proxy released a live provider worker")
    finally:
        finish.set()
        with pytest.raises(AzureSetupCancelled):
            await pending
    assert state()["phase"] == "starting" and len(provider.posts) == 1


@pytest.mark.parametrize("reference", ["async", "sync", "missing", "hash", "foreign", "expired"])
def test_vm_original_dispatch_reconciliation_is_get_only(setup, reference):
    from hushh_mcp.services.azure_arm_client import ArmError
    from hushh_mcp.services.azure_vm_power_reconciliation import reconcile_power_dispatch

    target, provider, *_ = setup
    # setup's first return is the target; its real fake provider checks VM identity.
    provider.power = "running"
    url = "https://management.azure.com/subscriptions/22222222-2222-2222-2222-222222222222/providers/Microsoft.Compute/locations/northcentralus/operations/synthetic?api-version=2024-03-01"
    if reference == "foreign":
        url = url.replace(
            "22222222-2222-2222-2222-222222222222", "99999999-9999-9999-9999-999999999999"
        )
    ack = {
        "kind": "ack",
        "requestId": "synthetic-request",
        "status": 202,
        "operationUrl": url,
        "operationUrlSha256": hashlib.sha256(url.encode()).hexdigest(),
        "operationKind": "azure-asyncoperation",
    }
    if reference == "missing":
        ack = {}
    elif reference == "hash":
        ack["operationUrlSha256"] = "0" * 64
    elif reference == "sync":
        ack.update(status=200, operationUrl=None, operationUrlSha256=None, operationKind=None)
    events = [
        {
            "kind": "request",
            "requestId": "synthetic-request",
            "path": target.installation.resource_id + "/start",
            "purpose": "vm_start",
            "apiVersion": "2024-03-01",
        },
        ack,
    ]
    events = [e for e in events if e]
    terminal, reads = [], []
    authority = SimpleNamespace(
        target=target,
        require_operation=lambda: None,
        read_from_thread=lambda: {"events": deepcopy(events)},
        terminal=lambda *args: terminal.append(args) or True,
    )
    request = provider.request

    def send(method, endpoint, **kwargs):
        assert method == "GET"
        reads.append(endpoint)
        if "/operations/" in endpoint:
            return SimpleNamespace(
                status_code=404 if reference == "expired" else 200,
                headers={},
                content=b"{}",
                json=lambda: {"status": "Succeeded"},
            )
        return request(method, endpoint, **kwargs)

    provider.request = send
    arm = ArmClient("synthetic", session=provider, sleep=lambda _: None)
    if reference in {"async", "sync"}:
        assert reconcile_power_dispatch(arm, authority, action="start") is True
        assert terminal == [("synthetic-request", "succeeded")]
        assert reads
    else:
        with pytest.raises((AzureVmPowerRefused, ArmError)):
            reconcile_power_dispatch(arm, authority, action="start")
        assert not terminal
    assert not provider.posts
