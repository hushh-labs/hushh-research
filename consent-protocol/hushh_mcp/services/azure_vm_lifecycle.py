"""Authenticated VM drain/wake using one durable registry operation.

Only an already installed, qualified VM can use this path. It does not provision,
grant cloud roles, migrate an owner or enable the unavailable VM hosting offer.
"""

from __future__ import annotations

import time
from collections.abc import Callable
from contextlib import AbstractAsyncContextManager
from typing import Any, Literal

from db.connection import dedicated_connection
from hushh_mcp.services.azure_arm_client import ArmClient
from hushh_mcp.services.azure_setup_worker import run_setup_thread
from hushh_mcp.services.azure_vm_power import AzureVmPower, AzureVmPowerRefused
from hushh_mcp.services.azure_vm_power_authority import (
    AzureVmPowerAuthority,
    azure_vm_power_authority,
)
from hushh_mcp.services.azure_vm_power_reconciliation import reconcile_power_dispatch
from hushh_mcp.services.azure_vm_recovery import (
    verified_vm_release,
    verify_vm_drain,
    verify_vm_identity,
    verify_vm_recovery,
)
from hushh_mcp.services.pod_upgrade_handoff import PodUpgradeHandoffClient


def _provider(tenant: str) -> ArmClient:
    from hushh_mcp.services.azure_federation import app_token

    # Existing broker federation only. A missing exact VM/operation-status grant
    # produces a provider refusal; local admin credentials are never a fallback.
    return ArmClient(lambda: app_token(tenant).access_token, lro_timeout_seconds=180)


def _event(state: dict, kind: str) -> dict | None:
    return next((e for e in reversed(state["events"]) if e["kind"] == kind), None)


def _power(
    authority: AzureVmPowerAuthority,
    arm: ArmClient,
    action: str,
    guard: Callable[[], None],
    require_drained: Callable[[], None],
) -> None:
    guard()
    settled = reconcile_power_dispatch(arm, authority, action=action)
    expected = "running" if action == "start" else "deallocated"
    with AzureVmPower(
        target=authority.target, arm=arm, journal=authority, require_operation=guard
    ) as power:
        if settled:
            if power.observe() != expected:
                raise AzureVmPowerRefused("VM_POWER_STATE_UNCONFIRMED")
        elif action == "start":
            power.start()
        else:
            power.deallocate(require_drained=require_drained)
    guard()
    authority.record_from_thread(
        {
            "kind": "power",
            "resourceId": authority.target.installation.resource_id,
            "vmId": authority.target.installation.vm_id,
            "state": expected,
        }
    )


def _deallocate(
    authority: AzureVmPowerAuthority,
    client: PodUpgradeHandoffClient,
    arm: ArmClient,
    guard: Callable[[], None],
) -> dict:
    state, binding = authority.read_from_thread(), authority.binding
    operation, incarnation = authority.operation_id, authority.target.installation.generation
    if state["phase"] == "deallocated":
        guard()
        return {"state": "sleeping", "operationId": operation}
    if state["phase"] not in {"preparing", "drained"}:
        raise AzureVmPowerRefused("VM_POWER_TRANSITION_PENDING")
    drain = _event(state, "drain")
    if drain is None:
        verify_vm_identity(client.recovery_snapshot(), binding)
        receipt = client.prepare_and_wait(
            operation_id=operation, incarnation=incarnation, guard=guard, timeout_seconds=120
        )
        verify_vm_drain(client.recovery_snapshot(), binding, receipt, operation)
        guard()
        authority.record_from_thread({"kind": "drain", "receipt": receipt})
    else:
        receipt = drain["receipt"]
    if state["phase"] == "preparing":
        guard()
        authority.advance_from_thread("drained")

    def drained() -> None:
        guard()
        verify_vm_drain(client.recovery_snapshot(), binding, receipt, operation)

    _power(authority, arm, "deallocate", guard, drained)
    guard()
    authority.advance_from_thread("deallocated")
    return {"state": "sleeping", "operationId": operation}


def _wake(
    authority: AzureVmPowerAuthority,
    client: PodUpgradeHandoffClient,
    arm: ArmClient,
    guard: Callable[[], None],
) -> dict:
    state, binding = authority.read_from_thread(), authority.binding
    operation, incarnation = authority.operation_id, authority.target.installation.generation
    if state["phase"] == "ready":
        snapshot = client.recovery_snapshot()
        drain = _event(state, "drain")
        if drain is None:
            raise AzureVmPowerRefused("VM_POWER_RECOVERY_RECEIPT_REQUIRED")
        recovery = verify_vm_recovery(snapshot, binding, drain["receipt"], operation)
        if verified_vm_release(snapshot["status"], recovery, operation) != _event(
            state, "released"
        ):
            raise AzureVmPowerRefused("VM_POWER_RELEASE_UNVERIFIED")
        guard()
        return {"state": "awake", "etaMs": 0, "operationId": operation}
    drain = _event(state, "drain")
    if state["phase"] not in {"deallocated", "starting", "recovered"} or drain is None:
        raise AzureVmPowerRefused("VM_POWER_RECOVERY_RECEIPT_REQUIRED")
    if state["phase"] == "deallocated":
        guard()
        authority.advance_from_thread("starting")
    if state["phase"] != "recovered":
        _power(authority, arm, "start", guard, lambda: None)
    snapshot = client.recovery_snapshot()
    recovery = verify_vm_recovery(snapshot, binding, drain["receipt"], operation)
    if snapshot["status"]["state"] != "accepting":
        # Complete the new process's registered drain hooks before handback.
        # Its new idle receipt must never replace the original retained cursor.
        client.prepare_and_wait(
            operation_id=operation, incarnation=incarnation, guard=guard, timeout_seconds=120
        )
        recovery = verify_vm_recovery(
            client.recovery_snapshot(), binding, drain["receipt"], operation
        )
    previous = _event(authority.read_from_thread(), "recovery")
    if previous != recovery:
        guard()
        authority.record_from_thread(recovery)
    if state["phase"] != "recovered":
        guard()
        authority.advance_from_thread("recovered")
    status = client.release(
        operation_id=operation,
        incarnation=incarnation,
        expected_idle_record=drain["receipt"]["idleRecord"],
        guard=guard,
    )
    released = verified_vm_release(status, recovery, operation)
    guard()
    authority.record_from_thread(released)
    authority.advance_from_thread("ready")
    return {"state": "awake", "etaMs": 0, "operationId": operation}


def _execute(
    *,
    authority: AzureVmPowerAuthority,
    action: str,
    arm_factory: Callable[[str], ArmClient],
    handoff_factory: Callable[..., PodUpgradeHandoffClient],
    guard: Callable[[], None],
    advance: Callable[[str], None],
) -> dict:
    deadline = time.monotonic() + 300

    def remaining() -> float:
        guard()
        value = deadline - time.monotonic()
        if value <= 0:
            raise AzureVmPowerRefused("VM_POWER_OUTCOME_UNCONFIRMED")
        return min(value, 60.0)

    remaining()
    binding = authority.binding
    client = handoff_factory(
        url=binding["url"], hushh_id=binding["hushhId"], request_budget=remaining
    )
    arm = arm_factory(binding["tenantId"])
    bounded = arm.with_request_budget(remaining)
    try:
        operation = _deallocate if action == "deallocate" else _wake
        return operation(authority, client, bounded, guard)
    finally:
        bounded.close()
        arm.close()


async def run_vm_lifecycle(
    *,
    owner: str,
    expected_vm_id: str,
    action: Literal["wake", "deallocate"],
    connection_factory: Callable[[], AbstractAsyncContextManager[Any]] = dedicated_connection,
    arm_factory: Callable[[str], ArmClient] = _provider,
    handoff_factory: Callable[..., PodUpgradeHandoffClient] = PodUpgradeHandoffClient,
) -> dict:
    if action not in {"wake", "deallocate"}:
        raise AzureVmPowerRefused("VM_POWER_ACTION_INVALID")
    async with azure_vm_power_authority(
        owner=owner,
        expected_vm_id=expected_vm_id,
        create_cycle=action == "deallocate",
        connection_factory=connection_factory,
    ) as authority:
        # Cancellation joins the real worker before the dedicated DB session and
        # owner lease exit. A cancelled executor proxy is not a shutdown receipt.
        result: dict = await run_setup_thread(
            _execute,
            authority=authority,
            action=action,
            arm_factory=arm_factory,
            handoff_factory=handoff_factory,
            guard=authority.require_operation,
            advance=lambda _: None,
        )
        return result
