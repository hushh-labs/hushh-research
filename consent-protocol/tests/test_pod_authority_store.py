"""The pod's own record of whom it trusts, and the fence between two incarnations.

The assertions that matter are the ones that make revocation a POD fact:

  * a trust record survives a restart (replay rebuilds it);
  * a tombstone at or above the trusted version wins, and a lower one does not;
  * a newer hub-signed binding re-admits a tombstoned subject (owner recovery);
  * a version that does not move forward is refused and appends nothing;
  * the loser of the incarnation race sees itself fenced;
  * a store error reads as "uncertain", never as "held";
  * the fence object cannot be opened with the log key;
  * a log closed for erasure refuses the authority store outright.
"""

from __future__ import annotations

import pytest

from hushh_mcp.services import pod_authority_store as authority
from hushh_mcp.services.pod_commit_log import LocalObjectStore, PodCommitLog, PodLogFenced

_OWNER = "ha1_owner"
_DEK = b"K" * 32
_OTHER_DEK = b"L" * 32


def _log(tmp_path, name="state") -> tuple[LocalObjectStore, PodCommitLog]:
    store = LocalObjectStore(str(tmp_path / name))
    return store, PodCommitLog(store, _DEK, owner_id=_OWNER)


def _binding(subject="tdv_device_1", version=1, role="device", owner=_OWNER) -> dict:
    return {"hushh_id": owner, "subject_id": subject, "role": role, "version": version}


async def _loaded(log) -> authority.PodAuthorityStore:
    store = authority.PodAuthorityStore(log, hushh_id=_OWNER)
    await store.load()
    return store


# -- trust and tombstones -------------------------------------------------------------


async def test_trust_survives_replay(tmp_path):
    _, log = _log(tmp_path)
    first = await _loaded(log)
    await first.record_trust(_binding(version=1))

    second = await _loaded(log)  # a restart: a fresh index over the same log
    status = second.subject("tdv_device_1")

    assert status.state == "trusted"
    assert status.trust is not None and status.trust.version == 1
    assert status.trust.role == "device"


async def test_a_tombstone_at_or_above_the_trusted_version_wins(tmp_path):
    _, log = _log(tmp_path)
    store = await _loaded(log)
    await store.record_trust(_binding(version=2))

    await store.record_tombstone("tdv_device_1", at_version=2, reason="owner_revoked")

    assert store.subject("tdv_device_1").state == "tombstoned"
    assert store.is_trusted("tdv_device_1") is False
    # ...and it still wins after a replay, which is the point of writing it down.
    assert (await _loaded(log)).subject("tdv_device_1").state == "tombstoned"


async def test_a_tombstone_below_the_trusted_version_does_not_bind(tmp_path):
    _, log = _log(tmp_path)
    store = await _loaded(log)
    await store.record_trust(_binding(version=3))
    # A stale revocation intent that named an older binding.
    store.apply_records(
        [
            {
                "kind": authority.AUTHORITY_TOMBSTONE_KIND,
                "payload": {"hushh_id": _OWNER, "subject_id": "tdv_device_1", "at_version": 2},
            }
        ]
    )
    assert store.subject("tdv_device_1").state == "trusted"


async def test_a_higher_version_binding_readmits_a_tombstoned_subject(tmp_path):
    _, log = _log(tmp_path)
    store = await _loaded(log)
    await store.record_trust(_binding(version=1))
    await store.record_tombstone("tdv_device_1", at_version=1)
    assert store.subject("tdv_device_1").state == "tombstoned"

    await store.record_trust(_binding(version=2))

    assert store.subject("tdv_device_1").state == "trusted"
    assert (await _loaded(log)).subject("tdv_device_1").trust.version == 2


async def test_a_lower_or_equal_version_is_refused_and_appends_nothing(tmp_path):
    _, log = _log(tmp_path)
    store = await _loaded(log)
    await store.record_trust(_binding(version=3))
    before = len(await log.replay())

    for stale in (3, 2):
        with pytest.raises(authority.PodAuthorityError) as caught:
            await store.record_trust(_binding(version=stale))
        assert caught.value.code == "stale_version"

    assert len(await log.replay()) == before
    assert store.subject("tdv_device_1").trust.version == 3


async def test_a_binding_below_a_tombstone_is_refused(tmp_path):
    """Revoked at 4 means only a binding above 4 re-admits; 4 or less is stale."""
    _, log = _log(tmp_path)
    store = await _loaded(log)
    await store.record_trust(_binding(version=2))
    await store.record_tombstone("tdv_device_1", at_version=4)
    before = len(await log.replay())

    with pytest.raises(authority.PodAuthorityError) as caught:
        await store.record_trust(_binding(version=4))

    assert caught.value.code == "stale_version"
    assert len(await log.replay()) == before
    assert store.subject("tdv_device_1").state == "tombstoned"


async def test_a_foreign_owners_binding_is_refused_and_appends_nothing(tmp_path):
    _, log = _log(tmp_path)
    store = await _loaded(log)
    before = len(await log.replay())

    with pytest.raises(authority.PodAuthorityError) as caught:
        await store.record_trust(_binding(owner="ha1_someone_else"))

    assert caught.value.code == "foreign_owner"
    assert len(await log.replay()) == before
    assert store.subject("tdv_device_1").state == "unknown"


async def test_replay_skips_records_written_for_another_owner(tmp_path):
    _, log = _log(tmp_path)
    await log.append(
        authority.AUTHORITY_TRUST_KIND,
        {"hushh_id": "ha1_other", "subject_id": "tdv_x", "role": "device", "version": 1},
    )
    store = await _loaded(log)
    assert store.subject("tdv_x").state == "unknown"
    assert store.trusted_subjects() == []


async def test_other_record_kinds_are_ignored(tmp_path):
    _, log = _log(tmp_path)
    await log.append("pod_config_v1", {"hushh_id": _OWNER, "config": {}})
    await log.append("agent_memory", {"hushh_id": _OWNER})
    store = await _loaded(log)
    assert store.trusted_subjects() == []
    assert store.tombstones() == []


async def test_a_fenced_log_refuses_the_authority_store(tmp_path):
    _, log = _log(tmp_path)
    store = await _loaded(log)
    await store.record_trust(_binding(version=1))
    await log.fence_for_erasure(owner_id=_OWNER, attempt_id="erase-1")

    with pytest.raises(PodLogFenced):
        await _loaded(log)
    with pytest.raises(PodLogFenced):
        await store.record_tombstone("tdv_device_1", at_version=1)


# -- the incarnation fence ------------------------------------------------------------


async def test_the_cas_loser_sees_the_fence(tmp_path):
    store, _ = _log(tmp_path)
    first = await authority.claim_incarnation(store, _DEK, instance_id="rev-a")
    second = await authority.claim_incarnation(store, _DEK, instance_id="rev-b")

    assert second.epoch == first.epoch + 1
    assert second.generation != first.generation

    old = authority.IncarnationLease(store, first)
    new = authority.IncarnationLease(store, second)
    assert await old.is_current(force=True) is False
    assert await old.state() == "fenced"
    assert await new.is_current(force=True) is True
    assert await new.state() == "held"


async def test_the_lease_rereads_only_after_its_window(tmp_path):
    store, _ = _log(tmp_path)
    first = await authority.claim_incarnation(store, _DEK, instance_id="rev-a")
    now = {"t": 100.0}
    lease = authority.IncarnationLease(store, first, lease_seconds=20.0, clock=lambda: now["t"])
    assert await lease.is_current() is True

    await authority.claim_incarnation(store, _DEK, instance_id="rev-b")
    # Inside the window the cached answer stands; the fence lands on the next re-read.
    assert await lease.is_current() is True
    now["t"] += 21.0
    assert await lease.is_current() is False


async def test_a_store_error_reads_as_uncertain_never_as_held(tmp_path):
    store, _ = _log(tmp_path)
    incarnation = await authority.claim_incarnation(store, _DEK, instance_id="rev-a")

    class _Broken:
        async def get_with_generation(self, key):
            raise RuntimeError("bucket unreachable")

    lease = authority.IncarnationLease(_Broken(), incarnation)
    assert await lease.is_current(force=True) is None
    assert await lease.state() == "uncertain"
    assert lease.last_state == "uncertain"


def test_the_fence_object_is_not_openable_with_the_log_key():
    from cryptography.hazmat.primitives.ciphers.aead import AESGCM

    blob = authority.seal_incarnation(_DEK, {"epoch": 1, "instance_id": "x", "claimed_at_ms": 1})
    with pytest.raises(Exception):  # noqa: B017 - any failure is a refusal here
        AESGCM(_DEK).decrypt(blob[:12], blob[12:], None)
    with pytest.raises(authority.PodIncarnationError):
        authority.open_incarnation(_OTHER_DEK, blob)
    assert authority.open_incarnation(_DEK, blob)["epoch"] == 1


def test_a_truncated_or_reshaped_fence_object_is_refused():
    with pytest.raises(authority.PodIncarnationError):
        authority.open_incarnation(_DEK, b"short")
    blob = authority.seal_incarnation(_DEK, {"epoch": "not-an-int"})
    with pytest.raises(authority.PodIncarnationError):
        authority.open_incarnation(_DEK, blob)


async def test_a_corrupt_fence_object_stops_the_claim_rather_than_minting_over_it(tmp_path):
    store, _ = _log(tmp_path)
    await store.put(authority.INCARNATION_OBJECT, b"not a sealed object at all")
    with pytest.raises(authority.PodIncarnationError):
        await authority.claim_incarnation(store, _DEK, instance_id="rev-a")
