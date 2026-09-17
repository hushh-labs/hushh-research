"""The pod fences new work while an approved replacement drains."""

from __future__ import annotations

import asyncio

import pytest

from hushh_mcp.services.pod_upgrade_admission import (
    PodUpgradeAdmission,
    PodUpgradeAdmissionRefused,
)


@pytest.mark.asyncio
async def test_prepare_waits_for_active_turn_and_emits_bound_idle_receipt() -> None:
    admission = PodUpgradeAdmission()
    permit = await admission.acquire_turn(incarnation="rev-a")

    pending = await admission.prepare(operation_id="op_12345678", incarnation="rev-a")
    assert pending["state"] == "draining"
    assert pending["activeWork"] == 1
    assert pending["idleReceipt"] is None

    with pytest.raises(PodUpgradeAdmissionRefused, match="active pod work"):
        await admission.release(operation_id="op_12345678", incarnation="rev-a")

    await permit.release()
    idle = await admission.status(incarnation="rev-a")
    assert idle["state"] == "idle"
    receipt = idle["idleReceipt"]
    assert receipt["operationId"] == "op_12345678"
    assert receipt["incarnation"] == "rev-a"
    assert receipt["activeWork"] == 0
    assert receipt["committedState"]

    released = await admission.release(operation_id="op_12345678", incarnation="rev-a")
    assert released["state"] == "accepting"


@pytest.mark.asyncio
async def test_draining_fences_new_turns_and_rejects_stale_release() -> None:
    admission = PodUpgradeAdmission()
    await admission.prepare(operation_id="op_12345678", incarnation="rev-a")

    with pytest.raises(PodUpgradeAdmissionRefused, match="preparing"):
        await admission.acquire_turn(incarnation="rev-a")
    with pytest.raises(PodUpgradeAdmissionRefused, match="does not match"):
        await admission.release(operation_id="op_other", incarnation="rev-a")
    with pytest.raises(PodUpgradeAdmissionRefused, match="does not match"):
        await admission.release(operation_id="op_12345678", incarnation="rev-b")


@pytest.mark.asyncio
async def test_wait_idle_has_a_bounded_timeout() -> None:
    admission = PodUpgradeAdmission()
    permit = await admission.acquire_turn(incarnation="rev-a")
    await admission.prepare(operation_id="op_12345678", incarnation="rev-a")
    with pytest.raises(asyncio.TimeoutError):
        await admission.wait_idle(operation_id="op_12345678", incarnation="rev-a", timeout=0.01)
    await permit.release()


@pytest.mark.asyncio
async def test_durable_fence_recovers_across_restart_and_revalidates_receipt() -> None:
    class MemoryLog:
        def __init__(self) -> None:
            self.records: list[dict] = []

        async def replay(self) -> list[dict]:
            return list(self.records)

        async def append(self, kind: str, payload: dict) -> dict:
            record = {
                "seq": len(self.records) + 1,
                "kind": kind,
                "payload": payload,
                "sha": f"sha-{len(self.records) + 1}",
            }
            self.records.append(record)
            return record

    log = MemoryLog()
    first = PodUpgradeAdmission(log_resolver=lambda: log)
    await first.prepare(operation_id="op_12345678", incarnation="rev-a")
    receipt = (await first.status(incarnation="rev-a"))["idleReceipt"]
    assert receipt["committedCursor"]["seq"] == 1
    assert receipt["idleRecord"]["seq"] == 2

    restarted = PodUpgradeAdmission(log_resolver=lambda: log)
    recovered = await restarted.status(incarnation="rev-a")
    assert recovered["state"] == "draining"
    assert recovered["operationId"] == "op_12345678"
    assert recovered["idleReceipt"] is None

    # Re-preparing the same operation issues a receipt from this runtime epoch;
    # a stale receipt cannot authorize the provider replacement.
    renewed = await restarted.prepare(operation_id="op_12345678", incarnation="rev-a")
    assert renewed["state"] == "idle"
    assert renewed["idleReceipt"]["runtimeEpoch"] != receipt["runtimeEpoch"]
    await restarted.release(operation_id="op_12345678", incarnation="rev-a")
