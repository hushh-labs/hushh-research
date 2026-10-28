"""Two runtimes compete on the same sealed-log CAS, never on local counters."""

import asyncio

import pytest

from hushh_mcp.services.pod_commit_log import (
    LocalObjectStore,
    PodCommitLog,
    PodLogConflict,
    PodLogFenced,
    PodLogTampered,
)
from hushh_mcp.services.pod_runtime_writer import KIND, LEASE_MS, RuntimeWriter


@pytest.fixture
def writers(tmp_path):
    clock = [1000]
    store = LocalObjectStore(str(tmp_path / "log"))
    logs = [PodCommitLog(store, b"w" * 32, owner_id="owner") for _ in range(2)]
    a = RuntimeWriter("owner", "runtime-a", "revision-a", "initial", clock=lambda: clock[0])
    b = RuntimeWriter("owner", "runtime-b", "revision-b", "approved-update", clock=lambda: clock[0])
    return clock, logs, a, b


async def test_competing_initial_claims_have_exactly_one_committed_writer(writers):
    _, logs, a, b = writers
    results = await asyncio.gather(
        a.append(logs[0], "fact", "a", None),
        b.append(logs[1], "fact", "b", None),
        return_exceptions=True,
    )
    assert sum(isinstance(result, dict) for result in results) == 1
    assert len([r for r in await logs[0].replay() if r["kind"] == "fact"]) == 1


async def test_takeover_fences_old_runtime_even_through_a_fresh_log_wrapper(writers):
    clock, logs, a, b = writers
    await a.append(logs[0], "fact", "a", None)
    clock[0] += LEASE_MS
    await b.append(logs[1], "fact", "b", None)
    clock[0] += LEASE_MS
    with pytest.raises(PodLogFenced):
        await a.append(logs[1], "fact", "stale", None)
    assert a.lost
    assert [r["payload"] for r in await logs[0].replay() if r["kind"] == "fact"] == ["a", "b"]


async def test_lost_claim_acknowledgement_reconciles_without_a_second_generation(
    writers, monkeypatch
):
    _, logs, a, _ = writers
    original = PodCommitLog.append
    lost = [False]

    async def append(log, kind, payload, **kwargs):
        record = await original(log, kind, payload, **kwargs)
        if kind == KIND and not lost[0]:
            lost[0] = True
            raise TimeoutError("synthetic lost acknowledgement")
        return record

    monkeypatch.setattr(PodCommitLog, "append", append)
    await a.append(logs[0], "fact", "persisted", None)
    assert len([r for r in await logs[0].replay() if r["kind"] == KIND]) == 1


async def test_draining_blocks_expiry_takeover_and_idle_requires_approved_successor(writers):
    clock, logs, a, b = writers
    await a.append(logs[0], "fact", "a", None)
    payload = {
        "runtimeEpoch": a.epoch,
        "incarnation": a.incarnation,
        "operationId": "approved-update",
    }
    await a.append(logs[0], "pod_upgrade_fence", payload, None)
    clock[0] += LEASE_MS
    with pytest.raises(PodLogFenced):
        await b.append(logs[1], "fact", "premature", None)
    await a.append(logs[0], "fact", "drained", None)
    await a.append(logs[0], "pod_upgrade_idle", payload, a.cursor.seq)
    b.operation = "wrong-operation"
    with pytest.raises(PodLogFenced):
        await b.append(logs[1], "fact", "wrong", None)
    b.operation = "approved-update"
    await b.append(logs[1], "fact", "new", None)
    with pytest.raises(PodLogFenced):
        await a.append(logs[0], "pod_upgrade_release", payload, None)


async def test_snapshot_mutation_is_not_rebased_and_erasure_remains_final(writers):
    _, logs, a, _ = writers
    await a.append(logs[0], "fact", "first", None)
    old = a.cursor.seq
    await a.append(logs[0], "fact", "second", None)
    with pytest.raises(PodLogConflict):
        await a.append(logs[0], "fact", "stale", old)
    await logs[0].fence_for_erasure(owner_id="owner", attempt_id="erasure")
    with pytest.raises(PodLogFenced):
        await a.append(logs[0], "fact", "after-erasure", None)


async def test_nonempty_legacy_history_and_malformed_lease_never_activate(writers):
    _, logs, a, _ = writers
    await logs[0].append("fact", "legacy")
    with pytest.raises(PodLogFenced):
        await a.append(logs[0], "fact", "unsafe-adoption", None)
    await logs[0].append(KIND, {"version": 1, "ownerId": "foreign"})
    with pytest.raises(PodLogTampered):
        await a.append(logs[0], "fact", "unsafe", None)


async def test_real_role_log_and_turn_lifetime_share_one_process_writer(monkeypatch, tmp_path):
    from hushh_mcp.services import pod_runtime_writer, pod_upgrade_admission
    from hushh_mcp.services.pod_role_log import RoleAwareCommitLog
    from tests.hosted_pod_support import install_hosted_runtime

    owner = "ha1_runtime_writer"
    install_hosted_runtime(monkeypatch, owner=owner)
    monkeypatch.setenv("K_REVISION", "revision-a")
    monkeypatch.setenv("HUSSH_POD_WRITER_PROTOCOL", "1")
    monkeypatch.setenv("HUSSH_POD_WRITER_OPERATION", "initial")
    monkeypatch.setattr(pod_runtime_writer, "_WRITERS", {})
    store = LocalObjectStore(str(tmp_path / "owner-log"))

    def new_log():
        return RoleAwareCommitLog(store, b"w" * 32, owner_id=owner)

    admission = pod_upgrade_admission.PodUpgradeAdmission(
        log_resolver=new_log, runtime_epoch="runtime-a"
    )
    monkeypatch.setattr(pod_upgrade_admission, "ADMISSION", admission)
    permit = await admission.acquire_turn(incarnation="revision-a")
    writer = pod_runtime_writer.runtime_writer()
    assert writer.active == 1 and writer.task is not None
    pending = await admission.prepare(operation_id="approved-update", incarnation="revision-a")
    assert pending["state"] == "draining"
    near_expiry = writer.lease["expiresAtMs"] - 1
    writer.clock = lambda: near_expiry
    await permit.release()
    assert writer.active == 0 and writer.task is None
    idle = await admission.status(incarnation="revision-a")
    assert idle["state"] == "idle"
    other = RuntimeWriter(owner, "runtime-b", "revision-b", "approved-update")
    await other.append(new_log(), "fact", "successor", None)
    with pytest.raises(PodLogFenced):
        await new_log().append("fact", "stale-through-new-wrapper")
    with pytest.raises(pod_upgrade_admission.PodUpgradeAdmissionRefused):
        await admission.acquire_turn(incarnation="revision-a")


async def test_cancelled_acknowledged_claim_preserves_cancellation(writers, monkeypatch):
    _, logs, a, _ = writers
    original = PodCommitLog.append

    async def cancelled(log, kind, payload, **kwargs):
        result = await original(log, kind, payload, **kwargs)
        if kind == KIND:
            raise asyncio.CancelledError()
        return result

    monkeypatch.setattr(PodCommitLog, "append", cancelled)
    with pytest.raises(asyncio.CancelledError):
        await a.append(logs[0], "fact", "cancelled-work", None)
    assert a.lease is not None and a.lease["generation"] == 1
    assert not any(r["kind"] == "fact" for r in await logs[0].replay())


async def test_invalid_handoff_leaves_the_committed_head_unchanged(writers):
    _, logs, a, _ = writers
    await a.append(logs[0], "fact", "first", None)
    before = await logs[0].replay()
    with pytest.raises(PodLogTampered):
        await a.append(
            logs[0],
            "pod_upgrade_fence",
            {"runtimeEpoch": a.epoch, "incarnation": "foreign", "operationId": "op"},
            None,
        )
    assert await logs[0].replay() == before
