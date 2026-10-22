"""The pod fences new work while an approved replacement drains."""

from __future__ import annotations

import asyncio
from copy import deepcopy

import pytest

from hushh_mcp.services.pod_upgrade_admission import (
    PodUpgradeAdmission,
    PodUpgradeAdmissionRefused,
)


class MemoryLog:
    def __init__(self) -> None:
        self.records: list[dict] = []

    async def replay(self) -> list[dict]:
        return deepcopy(self.records)

    async def append(self, kind: str, payload: dict) -> dict:
        record = {
            "seq": len(self.records) + 1,
            "kind": kind,
            "payload": deepcopy(payload),
            "sha": f"sha-{len(self.records) + 1}",
        }
        self.records.append(record)
        return deepcopy(record)


@pytest.fixture
def admission() -> PodUpgradeAdmission:
    log = MemoryLog()
    return PodUpgradeAdmission(log_resolver=lambda: log)


@pytest.mark.asyncio
async def test_prepare_waits_for_active_turn_and_emits_bound_idle_receipt(admission) -> None:
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
    # A legacy failure release is not a cursor-checked successful VM recovery.
    with pytest.raises(PodUpgradeAdmissionRefused, match="retained idle"):
        await admission.release(
            operation_id="op_12345678",
            incarnation="rev-a",
            expected_idle_record=receipt["idleRecord"],
        )
    # Existing failed-image update retries retain their original operation.
    assert (await admission.prepare(operation_id="op_12345678", incarnation="rev-a"))[
        "state"
    ] == "idle"


@pytest.mark.asyncio
async def test_draining_fences_new_turns_and_rejects_stale_release(admission) -> None:
    await admission.prepare(operation_id="op_12345678", incarnation="rev-a")

    with pytest.raises(PodUpgradeAdmissionRefused, match="preparing"):
        await admission.acquire_turn(incarnation="rev-a")
    with pytest.raises(PodUpgradeAdmissionRefused, match="does not match"):
        await admission.release(operation_id="op_other", incarnation="rev-a")
    with pytest.raises(PodUpgradeAdmissionRefused, match="does not match"):
        await admission.release(operation_id="op_12345678", incarnation="rev-b")


@pytest.mark.asyncio
async def test_wait_idle_has_a_bounded_timeout(admission) -> None:
    permit = await admission.acquire_turn(incarnation="rev-a")
    await admission.prepare(operation_id="op_12345678", incarnation="rev-a")
    with pytest.raises(asyncio.TimeoutError):
        await admission.wait_idle(operation_id="op_12345678", incarnation="rev-a", timeout=0.01)
    await permit.release()


@pytest.mark.asyncio
async def test_durable_fence_recovers_across_restart_and_revalidates_receipt() -> None:
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
    assert recovered["retainedIdleRecord"] == receipt["idleRecord"]
    with pytest.raises(PodUpgradeAdmissionRefused, match="retained idle"):
        await restarted.release(
            operation_id="op_12345678",
            incarnation="rev-a",
            expected_idle_record={"seq": 2, "sha": "wrong"},
        )

    # Re-preparing the same operation issues a receipt from this runtime epoch;
    # a stale receipt cannot authorize the provider replacement.
    renewed = await restarted.prepare(operation_id="op_12345678", incarnation="rev-a")
    assert renewed["state"] == "idle"
    assert renewed["idleReceipt"]["runtimeEpoch"] != receipt["runtimeEpoch"]
    assert renewed["retainedIdleRecord"] == receipt["idleRecord"]
    # Current-runtime receipt is stable on retry; old idle remains recovery evidence.
    repeated = await restarted.prepare(operation_id="op_12345678", incarnation="rev-a")
    assert repeated["idleReceipt"] == renewed["idleReceipt"]
    released = await restarted.release(
        operation_id="op_12345678",
        incarnation="rev-a",
        expected_idle_record=receipt["idleRecord"],
    )
    release_receipt = released["releaseReceipt"]
    assert release_receipt["retainedIdleRecord"] == receipt["idleRecord"]
    assert release_receipt["runtimeEpoch"] == renewed["runtimeEpoch"]
    before = len(log.records)
    recovered_again = PodUpgradeAdmission(log_resolver=lambda: log)
    repeated_release = await recovered_again.release(
        operation_id="op_12345678",
        incarnation="rev-a",
        expected_idle_record=receipt["idleRecord"],
    )
    assert repeated_release["releaseReceipt"] == release_receipt
    assert len(log.records) == before
    with pytest.raises(PodUpgradeAdmissionRefused, match="already released"):
        await recovered_again.prepare(operation_id="op_12345678", incarnation="rev-a")
    await recovered_again.prepare(operation_id="op_next", incarnation="rev-a")
    with pytest.raises(PodUpgradeAdmissionRefused, match="does not match"):
        await recovered_again.release(operation_id="op_12345678", incarnation="rev-a")


@pytest.mark.asyncio
@pytest.mark.parametrize("committed", [False, True])
@pytest.mark.parametrize("failure", [OSError, asyncio.CancelledError])
async def test_lost_release_response_is_reconciled_from_sealed_state(
    monkeypatch, committed, failure
):
    log = MemoryLog()
    admission = PodUpgradeAdmission(log_resolver=lambda: log)
    idle = await admission.prepare(operation_id="operation-a", incarnation="revision-a")
    cursor = idle["idleReceipt"]["idleRecord"]
    append = log.append

    async def interrupted(kind, payload):
        if committed:
            await append(kind, payload)
        raise failure("release response unavailable")

    monkeypatch.setattr(log, "append", interrupted)
    expected_error = PodUpgradeAdmissionRefused if failure is OSError else asyncio.CancelledError
    with pytest.raises(expected_error):
        await admission.release(
            operation_id="operation-a", incarnation="revision-a", expected_idle_record=cursor
        )
    monkeypatch.setattr(log, "append", append)
    released = await admission.release(
        operation_id="operation-a", incarnation="revision-a", expected_idle_record=cursor
    )
    assert released["state"] == "accepting"
    assert len([r for r in log.records if r["kind"] == "pod_upgrade_release"]) == 1
    assert released["releaseReceipt"]["releaseRecord"]["seq"] == 3
    permit = await admission.acquire_turn(incarnation="revision-a")
    await permit.release()


@pytest.mark.asyncio
async def test_cancelled_recovery_and_idle_append_reconcile_before_admission(monkeypatch):
    log = MemoryLog()
    admission = PodUpgradeAdmission(log_resolver=lambda: log)
    append, replay = log.append, log.replay

    async def interrupted_idle(kind, payload):
        result = await append(kind, payload)
        if kind == "pod_upgrade_idle":
            raise asyncio.CancelledError
        return result

    monkeypatch.setattr(log, "append", interrupted_idle)
    with pytest.raises(asyncio.CancelledError):
        await admission.prepare(operation_id="operation-a", incarnation="revision-a")
    monkeypatch.setattr(log, "append", append)
    recovered = await admission.wait_idle(operation_id="operation-a", incarnation="revision-a")
    assert recovered["idleReceipt"]["idleRecord"] == recovered["retainedIdleRecord"]
    assert len(log.records) == 2

    async def interrupted_replay():
        raise asyncio.CancelledError

    admission = PodUpgradeAdmission(log_resolver=lambda: log)
    monkeypatch.setattr(log, "replay", interrupted_replay)
    with pytest.raises(asyncio.CancelledError):
        await admission.status(incarnation="revision-a")
    monkeypatch.setattr(log, "replay", replay)
    with pytest.raises(PodUpgradeAdmissionRefused, match="preparing"):
        await admission.acquire_turn(incarnation="revision-a")


@pytest.mark.asyncio
async def test_unconfigured_turns_work_but_handoff_requires_durability() -> None:
    admission = PodUpgradeAdmission(log_resolver=lambda: None)
    permit = await admission.acquire_turn(incarnation="rev-a")
    await permit.release()
    assert (await admission.status(incarnation="rev-a"))["state"] == "accepting"
    with pytest.raises(PodUpgradeAdmissionRefused, match="durable storage"):
        await admission.prepare(operation_id="op_12345678", incarnation="rev-a")
    assert (await admission.status(incarnation="rev-a"))["idleReceipt"] is None


@pytest.mark.asyncio
@pytest.mark.parametrize("phase", ["fence", "idle", "cursor"])
@pytest.mark.parametrize("failure", ["missing", "malformed", "exception"])
async def test_failed_durability_cannot_authorize_replacement(phase, failure) -> None:
    class FailingLog(MemoryLog):
        def broken(self):
            if failure == "exception":
                raise OSError("unavailable")
            return None if failure == "missing" else {"seq": 1, "sha": ""}

        async def append(self, kind, payload):
            if kind == f"pod_upgrade_{phase}":
                return self.broken()
            return await super().append(kind, payload)

        async def replay(self):
            if phase == "cursor" and self.records:
                value = self.broken()
                return [] if value is None else [value]
            return await super().replay()

    log = FailingLog()
    admission = PodUpgradeAdmission(log_resolver=lambda: log)
    with pytest.raises(PodUpgradeAdmissionRefused, match="durable"):
        await admission.prepare(operation_id="op_12345678", incarnation="rev-a")
    status = await admission.status(incarnation="rev-a")
    assert status["state"] == "draining"
    assert status["idleReceipt"] is None
    with pytest.raises(PodUpgradeAdmissionRefused, match="preparing"):
        await admission.acquire_turn(incarnation="rev-a")


@pytest.mark.asyncio
async def test_next_operation_writes_its_own_fence(admission) -> None:
    await admission.prepare(operation_id="op_first", incarnation="rev-a")
    await admission.release(operation_id="op_first", incarnation="rev-a")
    await admission.prepare(operation_id="op_second", incarnation="rev-a")
    log = admission._log()
    fences = [r for r in log.records if r["kind"] == "pod_upgrade_fence"]
    assert [r["payload"]["operationId"] for r in fences] == ["op_first", "op_second"]


@pytest.mark.asyncio
async def test_drain_append_failure_keeps_fence_until_durable_retry(monkeypatch) -> None:
    log = MemoryLog()
    admission = PodUpgradeAdmission(log_resolver=lambda: log)
    permit = await admission.acquire_turn(incarnation="rev-a")
    await admission.prepare(operation_id="op_first", incarnation="rev-a")
    append = log.append

    async def unavailable(*_args):
        raise OSError("unavailable")

    monkeypatch.setattr(log, "append", unavailable)
    with pytest.raises(PodUpgradeAdmissionRefused, match="durable append"):
        await permit.release()
    status = await admission.status(incarnation="rev-a")
    assert status["activeWork"] == 0
    assert status["state"] == "draining"
    assert status["idleReceipt"] is None
    with pytest.raises(PodUpgradeAdmissionRefused, match="durable append"):
        await admission.release(operation_id="op_first", incarnation="rev-a")
    with pytest.raises(PodUpgradeAdmissionRefused, match="preparing"):
        await admission.acquire_turn(incarnation="rev-a")
    monkeypatch.setattr(log, "append", append)
    recovered = await admission.prepare(operation_id="op_first", incarnation="rev-a")
    assert recovered["state"] == "idle"
    assert recovered["idleReceipt"]["idleRecord"]["seq"] == 2


@pytest.mark.asyncio
async def test_resource_drain_failure_cannot_issue_idle_even_after_turn_release() -> None:
    log = MemoryLog()
    admission = PodUpgradeAdmission(log_resolver=lambda: log)
    permit = await admission.acquire_turn(incarnation="rev-a")
    entered, finish = asyncio.Event(), asyncio.Event()
    fail = True

    async def close_resource():
        await log.append("browser_closed", {"incarnation": "rev-a"})
        await permit.release()
        entered.set()
        await finish.wait()
        if fail:
            raise OSError("close unconfirmed")

    admission.register_drain(incarnation="rev-a", name="browser", callback=close_resource)
    preparing = asyncio.create_task(
        admission.prepare(operation_id="op_browser", incarnation="rev-a")
    )
    await asyncio.wait_for(entered.wait(), 1)
    pending = await admission.wait_idle(operation_id="op_browser", incarnation="rev-a")
    assert pending["activeWork"] == 0 and pending["idleReceipt"] is None
    with pytest.raises(PodUpgradeAdmissionRefused, match="active pod work"):
        await admission.release(operation_id="op_browser", incarnation="rev-a")
    finish.set()
    with pytest.raises(OSError, match="close unconfirmed"):
        await preparing
    assert (await admission.status(incarnation="rev-a"))["state"] == "draining"
    assert not any(record["kind"] == "pod_upgrade_idle" for record in log.records)
    fail = False  # only acknowledged shutdown permits the retry to issue idle
    idle = await admission.prepare(operation_id="op_browser", incarnation="rev-a")
    assert idle["state"] == "idle"
    cursor = idle["idleReceipt"]["committedCursor"]
    assert log.records[cursor["seq"] - 1]["kind"] == "browser_closed"
