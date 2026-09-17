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
