"""Restart acceleration must preserve the log's authority and erasure boundary."""

import json

import pytest

from hushh_mcp.services.pod_commit_log import (
    LocalObjectStore,
    PodCommitLog,
    PodLogFenced,
    PodLogTampered,
)
from hushh_mcp.services.pod_recovery_projection import KEY, OwnerRecoveryProjection

OWNER, DEK = "ha1_recovery_fixture", b"R" * 32


def log_at(path, key=DEK, owner=OWNER):
    return PodCommitLog(LocalObjectStore(str(path)), key, owner_id=owner)


async def test_restart_reads_only_tail_and_preserves_revocations(tmp_path, monkeypatch):
    log = log_at(tmp_path)
    await log.append("pod_config_v1", {"hushh_id": OWNER, "config": {"puppy_broker": True}})
    await log.append("authority_trust_v1", {"subject_id": "synthetic", "version": 1})
    await log.append("unrelated", {"synthetic": True})
    first = OwnerRecoveryProjection(owner=OWNER)
    expected = await first.replay(log)
    await log.append("authority_tombstone_v1", {"subject_id": "synthetic", "at_version": 1})
    await log.append("pod_upgrade_fence", {"incarnation": "previous", "operationId": "test"})
    await log.append("unrelated", {})
    original_get, reads = log._store.get, []

    async def get(key):
        reads.append(key)
        return await original_get(key)

    monkeypatch.setattr(log._store, "get", get)
    recovered = await OwnerRecoveryProjection(owner=OWNER).replay(log)
    assert recovered[:2] == expected
    assert [row["kind"] for row in recovered[2:]] == ["authority_tombstone_v1", "pod_upgrade_fence"]
    assert len(reads) == 3  # only the tail, including unrelated records for ancestry
    await log.fence_for_erasure(owner_id=OWNER, attempt_id="erase")
    with pytest.raises(PodLogFenced):
        await first.replay(log)


@pytest.mark.parametrize("changed", ["key", "owner", "location", "cursor", "oversize"])
async def test_checkpoint_rejects_wrong_binding_or_unverified_ancestry(tmp_path, changed):
    log = log_at(tmp_path)
    await log.append("pod_config_v1", {"hushh_id": OWNER})
    await OwnerRecoveryProjection(owner=OWNER).replay(log)
    blob = await log._store.get(KEY)
    limits = {}
    if changed == "key":
        log = log_at(tmp_path, key=b"W" * 32)
    elif changed == "owner":
        log = log_at(tmp_path, owner="ha1_foreign")
    elif changed == "location":
        log = log_at(tmp_path / "elsewhere")
        await log._store.put(KEY, blob)
    elif changed == "cursor":
        payload = log._unseal(blob)
        payload["cursor"]["sha"] = "0" * 64
        _, generation = await log._store.get_with_generation(KEY)
        await log._store.put_if_generation(KEY, log._seal(payload), generation)
    else:
        limits["max_bytes"] = len(blob) - 1
    projection = OwnerRecoveryProjection(owner=OWNER, **limits)
    with pytest.raises(PodLogTampered):
        await projection.replay(log)
    assert not projection._loaded


async def test_budget_falls_back_and_failed_tail_never_publishes(tmp_path, monkeypatch):
    log = log_at(tmp_path)
    await log.append("authority_trust_v1", {"subject_id": "synthetic"})
    await log.append("authority_tombstone_v1", {"subject_id": "synthetic"})
    bounded = OwnerRecoveryProjection(owner=OWNER, max_records=1)
    assert await bounded.replay(log) == await log.replay()
    assert bounded._uncached and await log._store.get(KEY) is None
    original = log.fold_since

    async def fenced(cursor, visit):
        await original(cursor, visit)
        await log.fence_for_erasure(owner_id=OWNER, attempt_id="race")
        await log.require_open()

    monkeypatch.setattr(log, "fold_since", fenced)
    projection = OwnerRecoveryProjection(owner=OWNER)
    with pytest.raises(PodLogFenced):
        await projection.replay(log)
    assert projection._sealed is None and await log._store.get(KEY) is None


async def test_lost_checkpoint_cas_reloads_winner_and_unconfirmed_save_retains_log(
    tmp_path, monkeypatch
):
    log = log_at(tmp_path)
    await log.append("pod_config_v1", {"hushh_id": OWNER})
    first, second = (OwnerRecoveryProjection(owner=OWNER) for _ in range(2))
    await first.replay(log)
    await second.replay(log)
    await log.append("authority_tombstone_v1", {"subject_id": "synthetic"})
    expected = await second.recover(log, force_save=True)
    assert await first.recover(log, force_save=True) == expected
    assert not first._loaded
    assert await first.replay(log) == expected and first._loaded
    original = log._store.put_if_generation

    async def uncertain(key, value, generation):
        result = await original(key, value, generation)
        if key == KEY:
            raise RuntimeError("synthetic response lost after commit")
        return result

    monkeypatch.setattr(log._store, "put_if_generation", uncertain)
    assert await first.recover(log, force_save=True) == expected
    assert not first._loaded
    assert await OwnerRecoveryProjection(owner=OWNER).replay(log) == expected
    assert [r["kind"] for r in await log.replay()] == [r["kind"] for r in expected]


async def test_actual_sealed_bound_and_original_records_are_enforced(tmp_path):
    log = log_at(tmp_path)
    await log.append("pod_config_v1", {"hushh_id": OWNER})
    records = await log.replay()
    projection = OwnerRecoveryProjection(
        owner=OWNER, max_bytes=len(json.dumps(records).encode()) + 2
    )
    assert await projection.replay(log) == records
    assert projection._uncached and await log._store.get(KEY) is None
