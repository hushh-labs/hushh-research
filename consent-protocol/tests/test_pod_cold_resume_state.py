"""A cold pod must wake up as itself, not as a stranger.

This is the property the economy tier is built on. `min-instances=0` means the pod
is *expected* to stop and start again; if the restart loses state, the cheap tier
is not a cheaper agent, it is a new agent every time, and "continues learning over
time" cannot be built on it.

The test models a real pod lifetime and does NOT reuse any object across it:

    1. derive keys from the owner's hushh_id (`pod_key_custody`)
    2. build a real `PodCommitLog` over a real object store
    3. write records -- the pod works
    4. DROP every in-process object. This is the pod dying.
    5. re-derive the keys from the same hushh_id, rebuild over the same store
    6. replay -- and get the same state back

Step 5 re-derives rather than reusing, because that is the whole claim: a
re-provisioned pod computes its key from its identity, so it can read what its
predecessor sealed without anything having been handed to it.

The store is local here so the property is testable in CI without GCS. On Cloud
Run the store must be GCS (`POD_STORAGE_GCS_BUCKET`), because the instance's disk
is destroyed by exactly the event this test exists to survive.
"""

from __future__ import annotations

import base64

import pytest

from hushh_mcp.services.pod_commit_log import LocalObjectStore, PodCommitLog
from hushh_mcp.services.pod_key_custody import POD_KEY_MASTER_ENV, derive_pod_log_key

OWNER = "HA1RESUME0001"
NEIGHBOUR = "HA1RESUME0002"
MASTER = base64.b64encode(b"resume-master-material-------32b").decode("ascii")


@pytest.fixture
def master(monkeypatch):
    monkeypatch.setenv(POD_KEY_MASTER_ENV, MASTER)


async def _write(log: PodCommitLog, records: list[dict]) -> None:
    for record in records:
        await log.append(record["kind"], record)


async def _replay(log: PodCommitLog) -> list[dict]:
    return list(await log.replay())


async def test_a_pod_that_dies_and_is_reprovisioned_reads_its_own_history(master, tmp_path) -> None:
    root = tmp_path / "state"
    learned = [
        {"kind": "pkm.write", "domain": "finance", "seq": 1},
        {"kind": "pkm.write", "domain": "health", "seq": 2},
        {"kind": "agent.turn", "summary": "asked about savings", "seq": 3},
    ]

    # --- pod generation 1 -------------------------------------------------------
    first = PodCommitLog(LocalObjectStore(str(root)), derive_pod_log_key(OWNER))
    await _write(first, learned)
    before = await _replay(first)
    assert len(before) == 3

    # --- the pod dies. Nothing survives in process. -----------------------------
    del first

    # --- pod generation 2: same identity, freshly derived key, same store --------
    second = PodCommitLog(LocalObjectStore(str(root)), derive_pod_log_key(OWNER))
    after = await _replay(second)

    assert after == before, "a re-provisioned pod must read exactly what it wrote"
    # Assert the PAYLOAD, not r["seq"] -- that is the chain counter, which would read
    # 1,2,3 for any three records at all and so proves nothing about what survived.
    assert [r["payload"] for r in after] == learned
    assert [r["payload"]["domain"] for r in after if r["kind"] == "pkm.write"] == [
        "finance",
        "health",
    ]
    assert after[2]["payload"]["summary"] == "asked about savings"


async def test_the_resumed_pod_keeps_appending_to_the_same_chain(master, tmp_path) -> None:
    """Learning continues rather than restarting -- history accretes across lifetimes."""
    root = tmp_path / "state"

    first = PodCommitLog(LocalObjectStore(str(root)), derive_pod_log_key(OWNER))
    await _write(first, [{"kind": "agent.turn", "seq": 1}])
    del first

    second = PodCommitLog(LocalObjectStore(str(root)), derive_pod_log_key(OWNER))
    await _write(second, [{"kind": "agent.turn", "seq": 2}])
    del second

    third = PodCommitLog(LocalObjectStore(str(root)), derive_pod_log_key(OWNER))
    replayed = await _replay(third)

    assert [r["payload"]["seq"] for r in replayed] == [1, 2], (
        "two working lifetimes, one continuous chain, read by a third"
    )


async def test_a_neighbour_pod_cannot_read_this_pod_s_state(master, tmp_path) -> None:
    """Per-owner derivation is the isolation: the wrong key must not decrypt."""
    root = tmp_path / "state"
    mine = PodCommitLog(LocalObjectStore(str(root)), derive_pod_log_key(OWNER))
    await _write(mine, [{"kind": "pkm.write", "domain": "finance", "seq": 1}])

    theirs = PodCommitLog(LocalObjectStore(str(root)), derive_pod_log_key(NEIGHBOUR))

    with pytest.raises(Exception):  # noqa: B017 - any refusal is the pass; silence is the failure
        await _replay(theirs)


async def test_a_rotated_master_cannot_silently_read_old_state(monkeypatch, tmp_path) -> None:
    """Rotating the master must fail loud on old records, never return garbage."""
    root = tmp_path / "state"
    monkeypatch.setenv(POD_KEY_MASTER_ENV, MASTER)
    first = PodCommitLog(LocalObjectStore(str(root)), derive_pod_log_key(OWNER))
    await _write(first, [{"kind": "pkm.write", "seq": 1}])

    monkeypatch.setenv(
        POD_KEY_MASTER_ENV, base64.b64encode(b"a-different-master-----------32b").decode()
    )
    rotated = PodCommitLog(LocalObjectStore(str(root)), derive_pod_log_key(OWNER))

    with pytest.raises(Exception):  # noqa: B017 - a refusal is correct; a silent empty replay is not
        await _replay(rotated)
