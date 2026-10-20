"""VM wake/deallocation authority, incarnation and uncertain-dispatch boundaries."""

from __future__ import annotations

from copy import deepcopy
from dataclasses import replace
from urllib.parse import urlsplit

import pytest

from hushh_mcp.services.azure_arm_client import ArmClient, ArmError
from hushh_mcp.services.azure_vm_power import (
    AzureVmPower,
    AzureVmPowerRefused,
    AzureVmPowerTarget,
)
from hushh_mcp.services.pod_azure_vm_identity import AzureVmInstallation
from tests.fixtures.azure_vm_power import (
    cleanup_connection as cleanup_connection,
)
from tests.fixtures.azure_vm_power import (
    cleanup_pg as cleanup_pg,
)
from tests.fixtures.azure_vm_power import (
    idle_receipt,
    power_receipt,
)
from tests.fixtures.azure_vm_power import (
    vm_installation as vm_installation,
)


class _Response:
    def __init__(self, status, body):
        self.status_code, self._body = status, body
        self.headers, self.content = {}, b"{}"

    def json(self):
        return self._body


_GROUP = "/subscriptions/22222222-2222-2222-2222-222222222222/resourceGroups/owner"
_VM = _GROUP + "/providers/Microsoft.Compute/virtualMachines/agent"
_IDENTITY = _GROUP + "/providers/Microsoft.ManagedIdentity/userAssignedIdentities/agent"
_PRINCIPAL = "33333333-3333-3333-3333-333333333333"


class Journal:
    def __init__(self):
        self.events = []

    def admit(self, request_id, request):
        self.events.append(("admit", request_id, request.path))
        return True

    def acknowledge(self, request_id, receipt):
        self.events.append(("ack", request_id, receipt.status))
        return True

    def terminal(self, request_id, outcome):
        self.events.append(("terminal", request_id, outcome))
        return True


class Provider:
    def __init__(self, target):
        install = target.installation
        self.vm = {
            "id": install.resource_id,
            "location": target.location,
            "properties": {"vmId": install.vm_id},
            "tags": dict(target.binding_tags),
            "identity": {
                "userAssignedIdentities": {
                    target.identity_resource_id: {
                        "principalId": target.principal_id,
                        "clientId": install.client_id,
                    }
                }
            },
        }
        self.power = "deallocated"
        self.posts = []
        self.failure = None
        self.settle = True
        self.closed = False
        self.before_read = lambda: None
        self.timeouts = []

    def request(self, method, url, **_kwargs):
        self.timeouts.append(_kwargs["timeout"])
        path = urlsplit(url).path
        if method == "POST":
            self.posts.append(path)
            if self.failure:
                raise self.failure
            if self.settle:
                self.power = "running" if path.endswith("/start") else "deallocated"
            return _Response(202, {})
        self.before_read()
        if path.endswith("/instanceView"):
            return _Response(200, {"statuses": [{"code": "PowerState/" + self.power}]})
        return _Response(200, deepcopy(self.vm))

    def close(self):
        self.closed = True


@pytest.fixture
def setup():
    installation = AzureVmInstallation(
        version=1,
        resource_id=_VM,
        vm_id="44444444-4444-4444-4444-444444444444",
        client_id="55555555-5555-5555-5555-555555555555",
        hushh_id="ha1_owner",
        image_digest="sha256:" + "a" * 64,
        generation="vm_" + "b" * 32,
    )
    target = AzureVmPowerTarget(
        installation,
        _IDENTITY,
        _PRINCIPAL,
        "northcentralus",
        {
            "husshPod": installation.hushh_id,
            "husshPodGeneration": installation.generation,
            "husshPodImage": installation.image_digest,
        },
    )
    provider, journal, ticks = Provider(target), Journal(), [0.0]
    allowed = [True]

    def guard():
        if not allowed[0]:
            raise PermissionError("owner operation ended")

    def build(arm=None):
        return AzureVmPower(
            target=target,
            arm=arm or ArmClient("synthetic-test-bearer", session=provider),
            journal=journal,
            require_operation=guard,
            clock=lambda: ticks[0],
            sleep=lambda delta: ticks.__setitem__(0, ticks[0] + delta),
        )

    return target, provider, journal, allowed, build


def test_start_reads_back_exact_vm_and_does_not_claim_application_readiness(setup):
    _, provider, journal, _, build = setup
    with build() as power:
        receipt = power.start()
        assert receipt.power_state == "running" and not receipt.application_ready
        assert power.start().mutation_submitted is False
    assert provider.posts == [_VM + "/start"]
    assert [event[0] for event in journal.events] == ["admit", "ack", "terminal"]
    assert journal.events[-1][-1] == "succeeded"
    assert not provider.closed  # explicitly borrowed pool


@pytest.mark.parametrize(
    "field", ["vmId", "location", "principalId", "husshPod", "husshPodGeneration", "husshPodImage"]
)
def test_another_incarnation_location_identity_or_owner_never_dispatches(setup, field):
    _, provider, journal, _, build = setup
    if field == "vmId":
        provider.vm["properties"]["vmId"] = "66666666-6666-6666-6666-666666666666"
    elif field == "location":
        provider.vm["location"] = "eastus2"
    elif field == "principalId":
        provider.vm["identity"]["userAssignedIdentities"][_IDENTITY][field] = "foreign"
    else:
        provider.vm["tags"][field] = "foreign"
    with build() as power, pytest.raises(AzureVmPowerRefused, match="IDENTITY_CHANGED"):
        power.start()
    assert not provider.posts and not journal.events


@pytest.mark.parametrize("inherited_guard", [False, True])
def test_deallocation_requires_current_drain_and_operation_at_dispatch(setup, inherited_guard):
    _, provider, journal, allowed, build = setup
    provider.power = "running"

    def expired_drain():
        allowed[0] = False

    arm = ArmClient(
        "synthetic-test-bearer",
        session=provider,
        before_write=expired_drain if inherited_guard else None,
    )
    with build(arm) as power, pytest.raises(PermissionError):
        power.deallocate(require_drained=(lambda: None) if inherited_guard else expired_drain)
    assert not provider.posts
    assert journal.events[-1][-1] == "not_dispatched"
    allowed[0] = True
    with build() as power:
        assert power.deallocate(require_drained=lambda: None).power_state == "deallocated"


@pytest.mark.parametrize("lost_response", [True, False])
def test_uncertain_dispatch_never_retries_or_marks_success(setup, lost_response):
    _, provider, journal, _, build = setup
    provider.settle = False
    if lost_response:
        provider.failure = TimeoutError("synthetic transport loss")
    expected = TimeoutError if lost_response else AzureVmPowerRefused
    with build() as power, pytest.raises(expected):
        power.start(timeout_seconds=2)
    assert provider.posts == [_VM + "/start"]
    assert not any(event[0] == "terminal" for event in journal.events)


def test_unknown_power_and_relocated_identity_are_refused(setup):
    target, provider, _, _, build = setup
    provider.power = "invented"
    with build() as power, pytest.raises(AzureVmPowerRefused, match="OBSERVATION_INVALID"):
        power.start()
    with pytest.raises(AzureVmPowerRefused, match="TARGET_INVALID"):
        replace(target, identity_resource_id=_IDENTITY.replace("/owner/", "/sibling/"))
    assert not provider.posts


def test_transport_pool_is_closed_on_failure_when_created_internally(setup, monkeypatch):
    import requests

    _, provider, _, _, build = setup
    provider.failure = ArmError("forbidden", status=403, code="", message="", op="start")
    monkeypatch.setattr(requests, "Session", lambda: provider)
    with build(ArmClient("synthetic-test-bearer")) as power, pytest.raises(ArmError):
        power.start()
    assert provider.closed


def test_open_parent_transport_remains_owned_by_parent(setup, monkeypatch):
    import requests

    _, provider, _, _, build = setup
    monkeypatch.setattr(requests, "Session", lambda: provider)
    parent = ArmClient("synthetic-test-bearer")
    parent.get(_VM, api_version="2024-03-01")
    with build(parent) as power:
        power.start()
    assert not provider.closed
    parent.close()
    assert provider.closed


def test_expired_budget_during_observation_never_dispatches(setup):
    _, provider, journal, _, build = setup
    clock = [0.0]
    power = build()
    power._clock = lambda: clock[0]
    provider.before_read = lambda: clock.__setitem__(0, clock[0] + 2)
    with power, pytest.raises(AzureVmPowerRefused, match="UNCONFIRMED"):
        power.start(timeout_seconds=2)
    assert provider.timeouts == [2]
    assert not provider.posts and not journal.events


def test_drain_expiring_during_final_identity_read_refuses_post(setup):
    _, provider, journal, _, build = setup
    provider.power = "running"
    reads = [0]

    def read():
        reads[0] += 1

    def drain():
        if reads[0] >= 4:
            raise PermissionError("idle fence expired")

    provider.before_read = read
    with build() as power, pytest.raises(PermissionError, match="idle fence"):
        power.deallocate(require_drained=drain)
    assert not provider.posts
    assert journal.events[-1][-1] == "not_dispatched"


@pytest.mark.parametrize("cleanup_pg", ["unreserved"], indirect=True)
async def test_vm_cycle_retains_exact_registry_authority_across_worker_restart(
    vm_installation, cleanup_connection
):
    import asyncio

    import asyncpg

    from hushh_mcp.services.azure_vm_power_authority import azure_vm_power_authority

    pg, owner, installation = vm_installation
    args = dict(
        owner=owner, expected_vm_id=installation.vm_id, connection_factory=cleanup_connection
    )
    async with azure_vm_power_authority(**args) as authority:
        operation = authority.operation_id
        with pytest.raises(AzureVmPowerRefused, match="WORKER_ACTIVE"):
            async with azure_vm_power_authority(**args):
                pytest.fail("second worker admitted")
        with pytest.raises(asyncpg.InsufficientPrivilegeError):
            await authority.advance("drained")
        receipt = idle_receipt(authority)
        await authority.retain({"kind": "drain", "receipt": receipt})
        await authority.advance("drained")
        await _assert_vm_conflicts_refused(pg, owner, authority, cleanup_connection)
        provider = Provider(authority.target)
        provider.power = "running"
        with AzureVmPower(
            target=authority.target,
            arm=ArmClient("synthetic", session=provider),
            journal=authority,
            require_operation=authority.require_operation,
            sleep=lambda _: None,
        ) as power:
            await asyncio.to_thread(power.deallocate, require_drained=authority.require_operation)
        await authority.retain(power_receipt(authority, "deallocated"))
        await authority.advance("deallocated")
    # A new local process adopts the same durable cycle, without repeating sleep.
    async with azure_vm_power_authority(**args) as authority:
        assert authority.operation_id == operation
        assert (await authority.read())["phase"] == "deallocated"
        await authority.advance("starting")
        with AzureVmPower(
            target=authority.target,
            arm=ArmClient("synthetic", session=provider),
            journal=authority,
            require_operation=authority.require_operation,
            sleep=lambda _: None,
        ) as power:
            await asyncio.to_thread(power.start)
        await authority.retain(power_receipt(authority, "running"))
        with pytest.raises(asyncpg.InsufficientPrivilegeError):
            await authority.advance("ready")
        await authority.retain(
            {
                "kind": "recovery",
                "incarnation": installation.generation,
                "podKeyId": "synthetic-key",
                "imageDigest": installation.image_digest,
                "runtimeEpoch": "after-restart",
                "retainedIdleRecord": receipt["idleRecord"],
            }
        )
        await authority.advance("recovered")
        await authority.retain(
            {
                "kind": "released",
                "operationId": operation,
                "incarnation": installation.generation,
                "runtimeEpoch": "after-restart",
                "releaseRecord": {"seq": 3, "sha": "f" * 64},
            }
        )
        assert (await authority.advance("ready"))["phase"] == "ready"
        assert len(provider.posts) == 2
    async with azure_vm_power_authority(**args) as following:
        state = await following.read()
        assert following.operation_id != operation and state["previousOperationId"] == operation


async def _assert_vm_conflicts_refused(pg, owner, authority, connection):
    import json

    import asyncpg
    import psycopg2

    for sql in (
        'UPDATE personal_agent_registry SET backend_metadata=backend_metadata||\'{"upgradeLease":"competing"}\'::jsonb WHERE user_id=%s',
        "UPDATE personal_agent_registry SET status='suspended' WHERE user_id=%s",
        "UPDATE personal_agent_registry SET backend_metadata=backend_metadata-'vmPower' WHERE user_id=%s",
        "SELECT reserve_personal_agent_erasure(%s,'competing-erasure')",
        "UPDATE byoc_setup_jobs SET status='running' WHERE user_id=%s",
        "INSERT INTO account_deletion_tombstones(user_id_hash,firebase_uid) VALUES ('sha256:'||encode(sha256(convert_to(%s,'UTF8')),'hex'),NULL)",
    ):
        with pytest.raises(psycopg2.errors.InsufficientPrivilege):
            pg.execute(sql, (owner,))
    async with connection() as other:
        state = await authority.read()
        async with other.transaction():
            assert (
                await other.fetchval("SELECT pg_try_advisory_lock(hashtextextended($1,206))", owner)
                is False
            )
        # The operation holder cannot corrupt phase or rewrite prior receipts.
    for changed in (
        {k: v for k, v in state.items() if k != "phase"},
        {**state, "phase": "ready"},
        {**state, "events": [{"kind": "drain", "receipt": {}}]},
    ):
        with pytest.raises(asyncpg.InsufficientPrivilegeError):
            async with authority._connection.transaction():
                await authority._connection.execute(
                    "UPDATE personal_agent_registry SET backend_metadata=jsonb_set(backend_metadata,'{vmPower}',$2::jsonb) WHERE user_id=$1",
                    owner,
                    json.dumps(changed),
                )


@pytest.mark.parametrize("cleanup_pg", ["unreserved"], indirect=True)
async def test_vm_uncertain_dispatch_survives_worker_exit_without_provider_replay(
    vm_installation, cleanup_connection
):
    import asyncio

    import asyncpg

    from hushh_mcp.services.azure_vm_power_authority import azure_vm_power_authority

    _, owner, installation = vm_installation
    args = dict(
        owner=owner, expected_vm_id=installation.vm_id, connection_factory=cleanup_connection
    )
    async with azure_vm_power_authority(**args) as authority:
        await authority.retain({"kind": "drain", "receipt": idle_receipt(authority)})
        await authority.advance("drained")
        provider = Provider(authority.target)
        provider.power, provider.failure = "running", OSError("lost provider response")
        with (
            AzureVmPower(
                target=authority.target,
                arm=ArmClient("synthetic", session=provider),
                journal=authority,
                require_operation=authority.require_operation,
            ) as power,
            pytest.raises(OSError),
        ):
            await asyncio.to_thread(power.deallocate, require_drained=authority.require_operation)
        previous = await authority.read()
    async with azure_vm_power_authority(**args) as authority:
        assert await authority.read() == previous
        provider.failure = None
        with (
            AzureVmPower(
                target=authority.target,
                arm=ArmClient("synthetic", session=provider),
                journal=authority,
                require_operation=authority.require_operation,
            ) as power,
            pytest.raises(asyncpg.InsufficientPrivilegeError),
        ):
            await asyncio.to_thread(power.deallocate, require_drained=authority.require_operation)
        assert len(provider.posts) == 1
        with pytest.raises(asyncpg.InsufficientPrivilegeError):
            await authority.advance("deallocated")


@pytest.mark.parametrize("cleanup_pg", ["unreserved"], indirect=True)
async def test_vm_confirmed_not_dispatched_can_retry_same_cycle_after_worker_restart(
    vm_installation, cleanup_connection
):
    import asyncio

    from hushh_mcp.services.azure_vm_power_authority import azure_vm_power_authority

    _, owner, installation = vm_installation
    args = dict(
        owner=owner, expected_vm_id=installation.vm_id, connection_factory=cleanup_connection
    )
    provider = None
    operation = None

    def transient_final_fence():
        raise PermissionError("final drain check unavailable")

    for attempt in range(2):
        async with azure_vm_power_authority(**args) as authority:
            if attempt == 0:
                operation = authority.operation_id
                await authority.retain({"kind": "drain", "receipt": idle_receipt(authority)})
                await authority.advance("drained")
                provider = Provider(authority.target)
                provider.power = "running"
            else:
                assert authority.operation_id == operation
                assert (await authority.read())["events"][-1]["outcome"] == "not_dispatched"
            with AzureVmPower(
                target=authority.target,
                arm=ArmClient("synthetic", session=provider),
                journal=authority,
                require_operation=authority.require_operation,
                sleep=lambda _: None,
            ) as power:
                if attempt == 0:
                    with pytest.raises(PermissionError, match="final drain"):
                        await asyncio.to_thread(
                            power.deallocate, require_drained=transient_final_fence
                        )
                    assert not provider.posts
                else:
                    await asyncio.to_thread(
                        power.deallocate, require_drained=authority.require_operation
                    )
                    await authority.retain(power_receipt(authority, "deallocated"))
                    await authority.advance("deallocated")
                    assert len(provider.posts) == 1
