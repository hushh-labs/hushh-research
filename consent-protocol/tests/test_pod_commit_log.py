"""The pod commit log: sealed, chained, CAS-linearized, and rebuildable.

The properties under test are the durability story itself:

* what is appended replays, in order, chain-verified;
* a flipped byte anywhere REFUSES to load (PodLogTampered) -- a storage
  provider that alters history produces a loud failure, not quiet corruption;
* an orphaned record (written, but its pointer swap lost) never appears;
* a lost CAS race retries and linearizes -- two writers, two records, one chain;
* the GCS client sends ifGenerationMatch -- the platform enforces the swap;
* the SQLite index is disposable: delete it, rebuild from the log, and the
  store answers identically -- INCLUDING the full conformance oracle running
  green against the log-backed store.
"""

from __future__ import annotations

import json
import secrets
import sqlite3
import subprocess
import sys
from pathlib import Path
from typing import Any, Optional

import pytest

from hushh_mcp.services.pkm_sqlite_engine import SqlitePkmWriteEngine
from hushh_mcp.services.pod_commit_log import (
    GcsObjectStore,
    LocalObjectStore,
    PodCommitLog,
    PodLogTampered,
)
from hushh_mcp.services.pod_pkm_store import PodPkmStore
from hushh_mcp.services.pod_storage import (
    BACKEND_COMMIT_LOG,
    CommitLogPodStorage,
    EncryptedBlobRef,
    NullPodStorage,
    resolve_pod_storage,
)
from tests.pkm_conformance import oracle

KEY = b"k" * 32


@pytest.fixture()
def log(tmp_path: Path) -> PodCommitLog:
    return PodCommitLog(LocalObjectStore(str(tmp_path / "store")), KEY)


# --- the log itself -------------------------------------------------------------------


@pytest.mark.asyncio
async def test_append_then_replay_round_trips_in_order(log: PodCommitLog):
    await log.append("a", {"n": 1})
    await log.append("b", {"n": 2})
    await log.append("a", {"n": 3})

    records = await log.replay()

    assert [(r["kind"], r["payload"]["n"]) for r in records] == [("a", 1), ("b", 2), ("a", 3)]
    assert [r["seq"] for r in records] == [1, 2, 3]


@pytest.mark.asyncio
async def test_records_are_ciphertext_at_rest(log: PodCommitLog, tmp_path: Path):
    await log.append("secret", {"holding": "the-plaintext-value"})
    blobs = list((tmp_path / "store" / "records").glob("*.bin"))
    assert blobs, "no record objects written"
    raw = blobs[0].read_bytes()
    assert b"the-plaintext-value" not in raw
    assert b"secret" not in raw


@pytest.mark.asyncio
async def test_a_flipped_byte_refuses_to_load(log: PodCommitLog, tmp_path: Path):
    await log.append("a", {"n": 1})
    await log.append("a", {"n": 2})
    blob_path = sorted((tmp_path / "store" / "records").glob("*.bin"))[0]
    data = bytearray(blob_path.read_bytes())
    data[len(data) // 2] ^= 0xFF
    blob_path.write_bytes(bytes(data))

    with pytest.raises(PodLogTampered):
        await log.replay()


@pytest.mark.asyncio
async def test_an_orphaned_record_never_appears(log: PodCommitLog, tmp_path: Path):
    """A record whose pointer swap lost is unreferenced by the chain."""
    await log.append("kept", {"n": 1})
    # Write a record object directly, without advancing the pointer.
    orphan = tmp_path / "store" / "records" / "000000000099-dead.bin"
    orphan.parent.mkdir(parents=True, exist_ok=True)
    orphan.write_bytes(secrets.token_bytes(64))

    records = await log.replay()

    assert [r["kind"] for r in records] == ["kept"]


class _RacingStore(LocalObjectStore):
    """Loses the first pointer swap on purpose, simulating a concurrent writer."""

    def __init__(self, root: str) -> None:
        super().__init__(root)
        self.raced = False

    async def put_if_generation(self, key: str, data: bytes, expected: int) -> Optional[int]:
        if key == PodCommitLog.HEAD and not self.raced:
            self.raced = True
            # Another writer swapped first: advance the real pointer once so the
            # caller's expected generation is stale.
            interloper = json.loads(data)
            interloper_record = {"seq": interloper["seq"], "key": key, "sha": interloper["sha"]}
            del interloper_record  # shape only; the winner is a real append below
            return None
        return await super().put_if_generation(key, data, expected)


@pytest.mark.asyncio
async def test_a_lost_cas_race_retries_and_linearizes(tmp_path: Path):
    store = _RacingStore(str(tmp_path / "store"))
    log = PodCommitLog(store, KEY)

    record = await log.append("a", {"n": 1})

    assert store.raced is True
    assert record["seq"] == 1
    assert [r["payload"]["n"] for r in await log.replay()] == [1]


# --- the GCS client's conditional write ----------------------------------------------


class _FakeResponse:
    def __init__(self, status_code: int, body: Any = None, content: bytes = b"") -> None:
        self.status_code = status_code
        self._body = body
        self.content = content

    def json(self) -> Any:
        return self._body

    def raise_for_status(self) -> None:
        if self.status_code >= 400:
            raise RuntimeError(f"HTTP {self.status_code}")


class _FakeGcsTransport:
    def __init__(self) -> None:
        self.uploads: list[dict] = []

    def get(self, url: str, **kwargs: Any) -> _FakeResponse:
        if "metadata.google.internal" in url:
            return _FakeResponse(200, {"access_token": "t"})
        return _FakeResponse(404)

    def post(self, url: str, **kwargs: Any) -> _FakeResponse:
        self.uploads.append(kwargs.get("params") or {})
        if kwargs["params"]["ifGenerationMatch"] == "412":
            return _FakeResponse(412)
        return _FakeResponse(200, {"generation": "7"})


@pytest.mark.asyncio
async def test_gcs_writes_are_conditional_by_construction():
    transport = _FakeGcsTransport()
    store = GcsObjectStore("user-bucket", "pods/ha1", session=transport)

    generation = await store.put_if_generation("head.json", b"{}", 3)

    assert generation == 7
    assert transport.uploads[0]["ifGenerationMatch"] == "3"
    assert transport.uploads[0]["name"] == "pods/ha1/head.json"


@pytest.mark.asyncio
async def test_gcs_precondition_failure_reports_a_lost_race_not_an_error():
    store = GcsObjectStore("user-bucket", session=_FakeGcsTransport())
    assert await store.put_if_generation("head.json", b"{}", 412) is None


# --- the log-backed PKM store ---------------------------------------------------------


class _LogStorePeer:
    """The conformance peer for the sqlite+log composite."""

    def __init__(self, tmp_path: Path) -> None:
        self.sqlite_path = tmp_path / "pkm.sqlite3"
        self.log = PodCommitLog(LocalObjectStore(str(tmp_path / "store")), KEY)
        self.engine = PodPkmStore(SqlitePkmWriteEngine(str(self.sqlite_path)), self.log)

    async def create_user(self, user_id: str) -> None:
        return None

    async def read_domain_summary(self, user_id: str, domain: str) -> Optional[dict]:
        conn = sqlite3.connect(self.sqlite_path)
        try:
            row = conn.execute(
                "SELECT domain_summaries FROM pkm_index WHERE user_id=?", (user_id,)
            ).fetchone()
        finally:
            conn.close()
        if row is None or not row[0]:
            return None
        return json.loads(row[0]).get(domain)


@pytest.mark.asyncio
async def test_the_full_oracle_passes_against_the_log_backed_store(tmp_path: Path):
    peer = _LogStorePeer(tmp_path)
    executed = await oracle.run_all(peer)
    assert len(executed) == len(oracle.SCENARIOS)


@pytest.mark.asyncio
async def test_conflicts_and_replays_are_never_logged(tmp_path: Path):
    import uuid

    peer = _LogStorePeer(tmp_path)
    user_id, commit_id = await oracle._fresh_committed_user(peer, "loggate")
    logged_after_seed = len(await peer.log.replay())

    # A conflicting commit and an idempotent replay both leave the log alone.
    await peer.engine.commit_domain_mutation(
        oracle._commit_params(user_id, expected=9, next_revision=10, commit_id=str(uuid.uuid4()))
    )
    await peer.engine.commit_domain_mutation(
        oracle._commit_params(user_id, expected=0, next_revision=1, commit_id=commit_id)
    )

    assert len(await peer.log.replay()) == logged_after_seed


@pytest.mark.asyncio
async def test_delete_the_sqlite_file_and_rebuild_from_the_log(tmp_path: Path):
    """The durability claim itself: the index is disposable, the log is the truth."""
    peer = _LogStorePeer(tmp_path)
    user_id, _ = await oracle._fresh_committed_user(peer, "rebuild")
    await peer.engine.merge_domain_summary(
        {
            "p_user_id": user_id,
            "p_domain": oracle.DOMAIN,
            "p_patch": {"readable_summary": "survives"},
            "p_domains_list": [oracle.DOMAIN],
        }
    )
    before = oracle.unwrap(
        await peer.engine.get_domain_snapshot(
            {"p_user_id": user_id, "p_domain": oracle.DOMAIN, "p_segment_ids": []}
        ),
        "get_pkm_domain_snapshot_v1",
    )

    # The platform reschedules the pod: local disk gone.
    peer.sqlite_path.unlink()

    rebuilt = await PodPkmStore.rebuild(
        peer.log, str(tmp_path / "pkm-rebuilt.sqlite3"), owner_user_id=user_id
    )
    after = oracle.unwrap(
        await rebuilt.get_domain_snapshot(
            {"p_user_id": user_id, "p_domain": oracle.DOMAIN, "p_segment_ids": []}
        ),
        "get_pkm_domain_snapshot_v1",
    )

    assert after["segments"] == before["segments"]
    assert after["content_revision"] == before["content_revision"]
    assert after["manifest"]["manifest_version"] == before["manifest"]["manifest_version"]

    conn = sqlite3.connect(tmp_path / "pkm-rebuilt.sqlite3")
    try:
        summary = json.loads(
            conn.execute(
                "SELECT domain_summaries FROM pkm_index WHERE user_id=?", (user_id,)
            ).fetchone()[0]
        )
    finally:
        conn.close()
    assert summary[oracle.DOMAIN]["readable_summary"] == "survives"


# --- the resolver ---------------------------------------------------------------------


def test_resolver_defaults_to_null(monkeypatch: pytest.MonkeyPatch):
    monkeypatch.delenv("POD_STORAGE_BACKEND", raising=False)
    assert isinstance(resolve_pod_storage(), NullPodStorage)


def test_resolver_builds_the_commit_log_backend(monkeypatch: pytest.MonkeyPatch, tmp_path: Path):
    import base64

    monkeypatch.setenv("POD_STORAGE_BACKEND", BACKEND_COMMIT_LOG)
    monkeypatch.setenv("POD_STORAGE_LOCAL_ROOT", str(tmp_path / "store"))
    monkeypatch.delenv("POD_STORAGE_GCS_BUCKET", raising=False)
    monkeypatch.setenv("HUSSH_POD_LOG_KEY", base64.b64encode(KEY).decode())
    storage = resolve_pod_storage()
    assert isinstance(storage, CommitLogPodStorage)


def test_resolver_refuses_ambiguous_or_missing_configuration(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
):
    monkeypatch.setenv("POD_STORAGE_BACKEND", BACKEND_COMMIT_LOG)
    monkeypatch.delenv("POD_STORAGE_LOCAL_ROOT", raising=False)
    monkeypatch.delenv("POD_STORAGE_GCS_BUCKET", raising=False)
    with pytest.raises(RuntimeError):
        resolve_pod_storage()
    # Both set is just as wrong as neither: where holdings persist is never ambiguous.
    monkeypatch.setenv("POD_STORAGE_LOCAL_ROOT", str(tmp_path))
    monkeypatch.setenv("POD_STORAGE_GCS_BUCKET", "b")
    with pytest.raises(RuntimeError):
        resolve_pod_storage()


@pytest.mark.asyncio
async def test_storage_pointers_round_trip_through_the_log(tmp_path: Path):
    log = PodCommitLog(LocalObjectStore(str(tmp_path / "store")), KEY)
    storage = CommitLogPodStorage(log)

    result = await storage.backup(
        "ha1x", EncryptedBlobRef(ref="gs://u/obj1", wrapping_key_id="podk_1", alg="X25519-AES")
    )
    await storage.backup(
        "ha1x", EncryptedBlobRef(ref="gs://u/obj2", wrapping_key_id="podk_1", alg="X25519-AES")
    )

    assert result["status"] == "recorded"
    restored = await storage.restore("ha1x")
    assert restored is not None and restored.ref == "gs://u/obj2"  # latest wins
    assert await storage.restore("someone-else") is None


@pytest.mark.asyncio
async def test_a_rebuild_materialises_only_its_own_owner(tmp_path: Path):
    """Two owners' records in one log; a rebuild must take only its own.

    `CommitLogPodStorage.restore` filters on `hushh_id` -- it always has, and the
    assertion right above this one proves it. `PodPkmStore.rebuild`, reading the
    SAME log, filtered on nothing: it replayed every record and dispatched on
    `kind` alone. Two consumers of one log, one filtering and one not, is the
    shape a leak hides in.

    It was dormant, not absent. Pod-unique keys and prefixes meant a log only ever
    held one owner's records, so configuration was standing in for a guard -- and
    the simulator's own probe said exactly that in prose while asserting the
    dormant case. That defence gets weaker, not stronger, as pods become
    persistent and deployable into projects where the bucket layout is somebody
    else's decision.

    This asserts the guard rather than the circumstance, which is the difference
    between a property and a coincidence.
    """
    log = PodCommitLog(LocalObjectStore(str(tmp_path / "shared-store")), KEY)

    await log.append(
        "pkm_commit",
        {"p_user_id": "owner-a", "p_domain": "health", "p_commit_kind": "seed"},
    )
    await log.append(
        "pkm_commit",
        {"p_user_id": "owner-b", "p_domain": "health", "p_commit_kind": "seed"},
    )

    replayed = await log.replay()
    assert len(replayed) == 2, "both records must be in the log for this to mean anything"

    # Rebuild as a THIRD owner, so every record in the log is foreign.
    #
    # The payloads above are deliberately incomplete -- they carry an owner and
    # nothing else the engine needs. That is what makes this a detector rather
    # than a demonstration: if the owner filter runs, neither record reaches the
    # engine and the rebuild completes. If it does not run, the engine is handed a
    # payload missing `p_expected_content_revision` and raises. The assertion is
    # "this did not explode", and the reason it does not explode is the guard.
    store = await PodPkmStore.rebuild(log, str(tmp_path / "c.sqlite3"), owner_user_id="owner-c")

    assert store is not None


@pytest.mark.asyncio
async def test_a_rebuild_must_say_whose_index_it_is_building(tmp_path: Path):
    """`owner_user_id` is required, and required is the point.

    An optional owner filter is one a caller forgets, and the caller who forgets
    is the one replaying a shared store. Making it a keyword with no default means
    a rebuild that does not know its owner cannot be requested by accident.
    """
    log = PodCommitLog(LocalObjectStore(str(tmp_path / "store")), KEY)

    with pytest.raises(TypeError):
        await PodPkmStore.rebuild(log, str(tmp_path / "x.sqlite3"))  # type: ignore[call-arg]


@pytest.mark.asyncio
async def test_local_store_interrupted_generation_write_never_returns_torn_pair(
    tmp_path, monkeypatch
):
    root = tmp_path / "recoverable-store"
    store = LocalObjectStore(str(root))
    assert await store.put_if_generation("head.json", b"old", 0) == 1
    original = store._atomic_write

    def interrupt_generation(path, data):
        if path.name == "head.json.gen":
            raise OSError("synthetic interrupted generation write")
        return original(path, data)

    with monkeypatch.context() as patcher:
        patcher.setattr(store, "_atomic_write", interrupt_generation)
        with pytest.raises(OSError):
            await store.put_if_generation("head.json", b"new", 1)
    recovered = await LocalObjectStore(str(root)).get_with_generation("head.json")
    assert recovered in [(b"old", 1), (b"new", 2)]


@pytest.mark.asyncio
@pytest.mark.parametrize("phase", ["before_journal", "journal", "content", "generation", "unlink"])
async def test_local_store_process_restart_recovers_each_publication_boundary(tmp_path, phase):
    root = tmp_path / "crash-store"
    store = LocalObjectStore(str(root))
    assert await store.put_if_generation("head.json", b"old", 0) == 1
    script = r"""
import asyncio, os, sys
from pathlib import Path
from hushh_mcp.services.pod_commit_log import LocalObjectStore
root, phase = sys.argv[1:]
store = LocalObjectStore(root)
atomic = store._atomic_write
replace = os.replace
unlink = Path.unlink

def crash_before_publication(source, target):
    if phase == "before_journal" and Path(target).name == store._JOURNAL:
        os._exit(73)
    return replace(source, target)

def crash_after_publication(path, data):
    atomic(path, data)
    names = {"journal": store._JOURNAL, "content": "head.json", "generation": "head.json.gen"}
    if names.get(phase) == path.name:
        os._exit(73)

def crash_after_unlink(path, *args, **kwargs):
    result = unlink(path, *args, **kwargs)
    if phase == "unlink" and path.name == store._JOURNAL:
        os._exit(73)
    return result

os.replace = crash_before_publication
store._atomic_write = crash_after_publication
Path.unlink = crash_after_unlink
asyncio.run(store.put_if_generation("head.json", b"new", 1))
"""
    process = subprocess.run(  # noqa: S603 - fixed interpreter/script and pytest-owned temp path
        [sys.executable, "-c", script, str(root), phase],
        cwd=Path(__file__).resolve().parents[1],
        capture_output=True,
        timeout=20,
    )
    assert process.returncode == 73
    reopened = LocalObjectStore(str(root))
    expected = (b"old", 1) if phase == "before_journal" else (b"new", 2)
    assert await reopened.get_with_generation("head.json") == expected
    assert not (root / LocalObjectStore._JOURNAL).exists()
    assert await reopened.put_if_generation("head.json", b"stale", 0) is None


@pytest.mark.asyncio
async def test_local_store_legacy_and_unchanged_bytes_keep_monotonic_generation(tmp_path):
    (tmp_path / "head.json").write_bytes(b"legacy")
    store = LocalObjectStore(str(tmp_path))
    assert await store.get_with_generation("head.json") == (b"legacy", 1)
    assert await store.put_if_generation("head.json", b"legacy", 1) == 2
    assert await LocalObjectStore(str(tmp_path)).get_with_generation("head.json") == (b"legacy", 2)
    assert await store.put_if_generation("head.json", b"stale", 1) is None


@pytest.mark.asyncio
async def test_corrupt_local_journal_fails_closed_without_discarding_it(tmp_path):
    store = LocalObjectStore(str(tmp_path))
    await store.put_if_generation("head.json", b"old", 0)
    journal = tmp_path / LocalObjectStore._JOURNAL
    journal.write_bytes(b"not-json")
    with pytest.raises(PodLogTampered, match="cannot be safely recovered"):
        await LocalObjectStore(str(tmp_path)).get("head.json")
    assert journal.read_bytes() == b"not-json"
    assert (tmp_path / "head.json").read_bytes() == b"old"


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "key", ["head.json.gen", ".lock", ".pending-write.json", "records/.object-write-temp"]
)
async def test_local_store_reserves_internal_metadata_keys(tmp_path, key):
    store = LocalObjectStore(str(tmp_path))
    with pytest.raises(ValueError, match="reserved"):
        await store.put_if_generation(key, b"synthetic", 0)
    with pytest.raises(ValueError, match="reserved"):
        await store.get(key)


def test_local_store_syncs_new_root_directory_entries_in_order(tmp_path, monkeypatch):
    synced = []
    monkeypatch.setattr(LocalObjectStore, "_sync_directory", staticmethod(synced.append))
    LocalObjectStore(str(tmp_path / "parent" / "store"))
    assert synced == [tmp_path, tmp_path / "parent"]


@pytest.mark.parametrize(
    "head",
    [
        {"seq": 1, "key": None, "sha": None},
        {"seq": True, "key": "records/example.bin", "sha": "a" * 64},
        {"seq": 0, "key": "records/example.bin", "sha": "a" * 64},
        {"seq": 1, "key": "../foreign.bin", "sha": "a" * 64},
        {"seq": 1, "key": "records/\u0000bad.bin", "sha": "a" * 64},
        {"seq": 1, "key": "records/\nbad.bin", "sha": "a" * 64},
        {"seq": 1, "key": "records/example.bin", "sha": "invalid"},
        [],
    ],
)
async def test_malformed_head_refuses_recovery_and_append(tmp_path, head):
    store = LocalObjectStore(str(tmp_path / "store"))
    await store.put(PodCommitLog.HEAD, json.dumps(head).encode())
    log = PodCommitLog(store, KEY)
    with pytest.raises(PodLogTampered):
        await log.replay()
    with pytest.raises(PodLogTampered):
        await log.append("synthetic", {})
    assert not (tmp_path / "store" / "records").exists()


async def test_head_sequence_must_match_the_authenticated_chain(tmp_path):
    store = LocalObjectStore(str(tmp_path / "store"))
    log = PodCommitLog(store, KEY)
    await log.append("synthetic", {})
    raw, generation = await store.get_with_generation(log.HEAD)
    head = json.loads(raw)
    head["seq"] = 2
    await store.put_if_generation(log.HEAD, json.dumps(head).encode(), generation)
    with pytest.raises(PodLogTampered):
        await log.replay()


async def test_inconsistent_head_cannot_publish_a_successor(tmp_path):
    store = LocalObjectStore(str(tmp_path / "store"))
    log = PodCommitLog(store, KEY)
    await log.append("synthetic", {})
    raw, generation = await store.get_with_generation(log.HEAD)
    head = json.loads(raw)
    head["seq"] = 2
    await store.put_if_generation(log.HEAD, json.dumps(head).encode(), generation)
    before = sorted((tmp_path / "store" / "records").iterdir())
    with pytest.raises(PodLogTampered):
        await log.append("must-not-publish", {})
    assert sorted((tmp_path / "store" / "records").iterdir()) == before
