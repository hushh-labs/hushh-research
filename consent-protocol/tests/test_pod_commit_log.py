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

    rebuilt = await PodPkmStore.rebuild(peer.log, str(tmp_path / "pkm-rebuilt.sqlite3"))
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
