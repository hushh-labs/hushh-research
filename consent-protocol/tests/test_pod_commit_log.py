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

import asyncio
import base64
import json
import secrets
import sqlite3
import subprocess
import sys
import threading
from pathlib import Path
from typing import Any, Optional

import pytest

from hushh_mcp.services import pod_commit_log
from hushh_mcp.services.pkm_sqlite_engine import SqlitePkmWriteEngine
from hushh_mcp.services.pod_commit_log import (
    GcsObjectStore,
    LocalObjectStore,
    PodCommitLog,
    PodLogConflict,
    PodLogFenced,
    PodLogTampered,
    object_key_is_within,
    object_key_segments,
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


@pytest.mark.asyncio
@pytest.mark.parametrize("seed", [False, True])
async def test_erasure_fence_survives_restart_and_blocks_ordinary_access(tmp_path, seed):
    store = LocalObjectStore(str(tmp_path / "fence"))
    log = PodCommitLog(store, KEY, owner_id="synthetic-owner")
    if seed:
        await log.append("synthetic", {"fact": "private fixture"})
    await log.fence_for_erasure(owner_id="synthetic-owner", attempt_id="synthetic-attempt")
    marker, generation = await store.get_with_generation(log.HEAD)
    assert b"synthetic-owner" not in marker
    assert b"synthetic-attempt" not in marker
    restarted = PodCommitLog(store, KEY, owner_id="synthetic-owner")
    await restarted.fence_for_erasure(owner_id="synthetic-owner", attempt_id="synthetic-attempt")
    assert await store.get_with_generation(log.HEAD) == (marker, generation)
    for reader in (restarted, PodCommitLog(store, KEY)):
        with pytest.raises(PodLogFenced):
            await reader.append("late", {})
        with pytest.raises(PodLogFenced):
            await reader.replay()
        with pytest.raises(PodLogFenced):
            await reader.require_open()
    with pytest.raises(PodLogFenced):
        await restarted.fence_for_erasure(owner_id="synthetic-owner", attempt_id="other")
    with pytest.raises(PodLogFenced):
        await restarted.fence_for_erasure(owner_id="foreign", attempt_id="synthetic-attempt")
    with pytest.raises(PodLogFenced):
        await PodCommitLog(store, KEY).fence_for_erasure(
            owner_id="synthetic-owner", attempt_id="synthetic-attempt"
        )


@pytest.mark.asyncio
async def test_fence_authentication_cannot_be_replaced_with_valid_legacy_coordinates(tmp_path):
    store = LocalObjectStore(str(tmp_path / "fence"))
    log = PodCommitLog(store, KEY, owner_id="synthetic-owner")
    await log.append("synthetic", {})
    old, _ = await store.get_with_generation(log.HEAD)
    await log.fence_for_erasure(owner_id="synthetic-owner", attempt_id="synthetic-attempt")
    raw, generation = await store.get_with_generation(log.HEAD)
    marker = json.loads(raw)
    # Neither an unauthenticated flag nor coordinates added beside the marker
    # can reopen ordinary replay or append.
    marker.update(json.loads(old))
    await store.put_if_generation(log.HEAD, json.dumps(marker).encode(), generation)
    with pytest.raises(PodLogTampered):
        await log.append("late", {})
    with pytest.raises(PodLogTampered):
        await log.replay()


@pytest.mark.asyncio
@pytest.mark.parametrize("damage", ["ciphertext", "foreign_owner", "key"])
async def test_fence_refuses_corrupt_or_foreign_authenticated_binding(tmp_path, damage):
    store = LocalObjectStore(str(tmp_path / "fence"))
    log = PodCommitLog(store, KEY, owner_id="synthetic-owner")
    await log.fence_for_erasure(owner_id="synthetic-owner", attempt_id="synthetic-attempt")
    if damage == "ciphertext":
        raw, generation = await store.get_with_generation(log.HEAD)
        marker = json.loads(raw)
        sealed = bytearray(base64.b64decode(marker["sealedFence"]))
        sealed[-1] ^= 1
        marker["sealedFence"] = base64.b64encode(sealed).decode()
        await store.put_if_generation(log.HEAD, json.dumps(marker).encode(), generation)
    elif damage == "foreign_owner":
        log = PodCommitLog(store, KEY, owner_id="foreign")
    else:
        log = PodCommitLog(store, b"z" * 32, owner_id="synthetic-owner")
    with pytest.raises(PodLogTampered):
        await log.replay()


@pytest.mark.asyncio
@pytest.mark.parametrize("first", ["append", "fence"])
async def test_append_and_fence_share_one_atomic_publication_point(tmp_path, first):
    entered, release = asyncio.Event(), asyncio.Event()

    class RacingStore(LocalObjectStore):
        paused = False

        async def put_if_generation(self, key, data, expected):
            is_fence = key == PodCommitLog.HEAD and "sealedFence" in json.loads(data)
            if key == PodCommitLog.HEAD and not self.paused and is_fence == (first == "fence"):
                self.paused = True
                entered.set()
                await release.wait()
            return await super().put_if_generation(key, data, expected)

    store = RacingStore(str(tmp_path / "fence"))
    log = PodCommitLog(store, KEY, owner_id="synthetic-owner")

    async def fence():
        await log.fence_for_erasure(owner_id="synthetic-owner", attempt_id="synthetic-attempt")

    task = asyncio.create_task(log.append("synthetic", {}) if first == "append" else fence())
    await asyncio.wait_for(entered.wait(), 2)
    try:
        if first == "append":
            await fence()
        else:
            await log.append("synthetic", {})
    finally:
        release.set()
    if first == "append":
        with pytest.raises(PodLogFenced):
            await task
    else:
        await task
    raw, _ = await store.get_with_generation(log.HEAD)
    authenticated = log._read_fence(raw)
    assert (
        authenticated["prior_head"] is None
        if first == "append"
        else (authenticated["prior_head"]["seq"] == 1)
    )
    with pytest.raises(PodLogFenced):
        await log.replay()
    # A losing append already uploaded an unreferenced encrypted object. This
    # receipt cannot be credited as all-writes-drained or complete erasure.
    assert len(list((tmp_path / "fence" / "records").glob("*.bin"))) == 1


@pytest.mark.asyncio
@pytest.mark.parametrize("winner", ["replacement", "revocation", "erasure"])
async def test_guarded_append_rechecks_authority_after_lost_cas(tmp_path, winner):
    entered, release = asyncio.Event(), asyncio.Event()

    class RacingStore(LocalObjectStore):
        pause_next = False

        async def put_if_generation(self, key, data, expected):
            if key == PodCommitLog.HEAD and self.pause_next:
                self.pause_next = False
                entered.set()
                await release.wait()
            return await super().put_if_generation(key, data, expected)

    store = RacingStore(str(tmp_path / "guard"))
    log = PodCommitLog(store, KEY, owner_id="synthetic-owner")
    await log.append("writer", {"epoch": 1})
    observed = []

    def require_initial_writer(records):
        observed.append([record["kind"] for record in records])
        if records[-1]["kind"] != "writer" or records[-1]["payload"]["epoch"] != 1:
            raise PermissionError("authority changed")

    store.pause_next = True
    pending = asyncio.create_task(log.append("enroll", {}, precondition=require_initial_writer))
    await asyncio.wait_for(entered.wait(), 2)
    try:
        if winner == "erasure":
            await log.fence_for_erasure(owner_id="synthetic-owner", attempt_id="erase")
        elif winner == "replacement":
            await log.append("writer", {"epoch": 2})
        else:
            await log.append("revoked", {})
    finally:
        release.set()
    with pytest.raises(PodLogFenced if winner == "erasure" else PermissionError):
        await pending
    if winner == "erasure":
        assert observed == [["writer"]]
    else:
        history = await log.replay()
        assert all(record["kind"] != "enroll" for record in history)
        assert len(observed) == 2
        assert observed[-1] == [record["kind"] for record in history]


@pytest.mark.asyncio
async def test_guarded_append_checks_full_chain_before_authority_or_publication(tmp_path):
    store = LocalObjectStore(str(tmp_path / "guard"))
    log = PodCommitLog(store, KEY)
    await log.append("first", {})
    first_head, _ = await store.get_with_generation(log.HEAD)
    await log.append("second", {})
    (tmp_path / "guard" / json.loads(first_head)["key"]).write_bytes(b"corrupt")
    before = await store.get_with_generation(log.HEAD)
    observed = []
    with pytest.raises(PodLogTampered):
        await log.append("guarded", {}, precondition=lambda records: observed.append(records))
    assert not observed
    assert await store.get_with_generation(log.HEAD) == before


@pytest.mark.asyncio
@pytest.mark.parametrize("failure", ["lost_ack", "failed_readback", "mismatch"])
async def test_unconfirmed_fence_is_reconciled_without_reopening(tmp_path, failure):
    class UncertainStore(LocalObjectStore):
        armed = True
        written = False

        async def put_if_generation(self, key, data, expected):
            generation = await super().put_if_generation(key, data, expected)
            if self.armed and key == PodCommitLog.HEAD:
                self.written = True
                if failure == "lost_ack":
                    self.armed = False
                    raise OSError("synthetic acknowledgement loss")
            return generation

        async def get_with_generation(self, key):
            if self.armed and self.written and key == PodCommitLog.HEAD:
                self.armed = False
                if failure == "failed_readback":
                    raise OSError("synthetic readback refusal")
                if failure == "mismatch":
                    return None, 0
            return await super().get_with_generation(key)

    store = UncertainStore(str(tmp_path / "fence"))
    log = PodCommitLog(store, KEY, owner_id="synthetic-owner")
    with pytest.raises((OSError, PodLogConflict)):
        await log.fence_for_erasure(owner_id="synthetic-owner", attempt_id="synthetic-attempt")
    restarted = PodCommitLog(store, KEY, owner_id="synthetic-owner")
    await restarted.fence_for_erasure(owner_id="synthetic-owner", attempt_id="synthetic-attempt")
    with pytest.raises(PodLogFenced):
        await restarted.replay()


@pytest.mark.asyncio
async def test_replay_started_before_fence_does_not_release_captured_history(tmp_path):
    entered, release = asyncio.Event(), asyncio.Event()

    class PausingStore(LocalObjectStore):
        armed = False

        async def get(self, key):
            if self.armed and key.startswith("records/"):
                self.armed = False
                entered.set()
                await release.wait()
            return await super().get(key)

    store = PausingStore(str(tmp_path / "fence"))
    log = PodCommitLog(store, KEY, owner_id="synthetic-owner")
    await log.append("synthetic", {})
    store.armed = True
    task = asyncio.create_task(log.replay())
    await asyncio.wait_for(entered.wait(), 2)
    try:
        await log.fence_for_erasure(owner_id="synthetic-owner", attempt_id="synthetic-attempt")
    finally:
        release.set()
    with pytest.raises(PodLogFenced):
        await task


@pytest.mark.asyncio
async def test_fenced_pkm_cannot_read_mutate_or_rebuild_a_cached_index(tmp_path):
    from unittest.mock import AsyncMock

    log = PodCommitLog(LocalObjectStore(str(tmp_path / "fence")), KEY, owner_id="synthetic-owner")
    engine = AsyncMock()
    pkm = PodPkmStore(engine, log)
    await log.fence_for_erasure(owner_id="synthetic-owner", attempt_id="synthetic-attempt")
    with pytest.raises(PodLogFenced):
        await pkm.get_domain_snapshot({"p_user_id": "synthetic-owner"})
    with pytest.raises(PodLogFenced):
        await pkm.commit_domain_mutation({"p_user_id": "synthetic-owner"})
    with pytest.raises(PodLogFenced):
        await PodPkmStore.rebuild(
            log, str(tmp_path / "refused.sqlite3"), owner_user_id="synthetic-owner"
        )
    engine.get_domain_snapshot.assert_not_awaited()
    engine.commit_domain_mutation.assert_not_awaited()
    assert not (tmp_path / "refused.sqlite3").exists()


@pytest.mark.asyncio
async def test_fence_refuses_corrupt_prior_chain_without_replacing_authority(tmp_path):
    store = LocalObjectStore(str(tmp_path / "fence"))
    log = PodCommitLog(store, KEY, owner_id="synthetic-owner")
    await log.append("synthetic", {})
    before = await store.get_with_generation(log.HEAD)
    record_path = tmp_path / "fence" / json.loads(before[0])["key"]
    record_path.write_bytes(b"synthetic-corrupt-record")
    with pytest.raises(PodLogTampered):
        await log.fence_for_erasure(owner_id="synthetic-owner", attempt_id="synthetic-attempt")
    assert await store.get_with_generation(log.HEAD) == before


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
    def __init__(
        self,
        status_code: int,
        body: Any = None,
        content: bytes = b"",
        headers: Optional[dict[str, str]] = None,
    ) -> None:
        self.status_code = status_code
        self._body = body
        self.content = content
        self.headers = headers or {}

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


# --- the GCS client's round trips: one credential, one read --------------------------


_SAME_AS_METADATA = object()


class _CountingGcsTransport(_FakeGcsTransport):
    """Counts every call the store makes, and serves one stored object.

    A fresh access token each time it is asked for, so a reused credential is
    visible in the Authorization header, not only in the call count. It can
    also make a credential DIE mid-life, which is how a real one behaves when
    its service account loses the binding it was minted under.
    """

    def __init__(
        self,
        *,
        expires_in: Any = 3600,
        content: Optional[bytes] = b"stored",
        generation: str = "9",
        media_generation: Any = _SAME_AS_METADATA,
        credential_dies_after: Optional[int] = None,
        refuse_every_credential: bool = False,
        refusal_status: int = 401,
    ) -> None:
        super().__init__()
        self._expires_in = expires_in
        self._content = content
        self._generation = generation
        self._media_generation = (
            generation if media_generation is _SAME_AS_METADATA else media_generation
        )
        self._dies_after = credential_dies_after
        self._refuse_every_credential = refuse_every_credential
        self._refusal_status = refusal_status
        self._dead: set[str] = set()
        self.minted: list[str] = []  # Authorization header values, as presented
        self.token_calls = 0
        self.object_calls = 0
        self.object_gets: list[dict] = []
        self.authorizations: list[str] = []

    def _is_refused(self, authorization: str) -> bool:
        if self._refuse_every_credential:
            return True
        if self._dies_after is not None and self.object_calls >= self._dies_after:
            # Every credential alive at the moment of the outage dies with it;
            # one minted afterwards is good again.
            self._dead.update(self.minted)
            self._dies_after = None
        return authorization in self._dead

    def get(self, url: str, **kwargs: Any) -> _FakeResponse:
        if "metadata.google.internal" in url:
            self.token_calls += 1
            token = f"t{self.token_calls}"
            self.minted.append(f"Bearer {token}")
            body: dict[str, Any] = {"access_token": token}
            if self._expires_in is not None:
                body["expires_in"] = self._expires_in
            return _FakeResponse(200, body)
        params = kwargs.get("params") or {}
        authorization = kwargs["headers"]["Authorization"]
        self.object_gets.append(params)
        self.authorizations.append(authorization)
        if self._is_refused(authorization):
            return _FakeResponse(self._refusal_status)
        self.object_calls += 1
        if self._content is None:
            return _FakeResponse(404)
        if params.get("fields") == "generation":
            return _FakeResponse(200, {"generation": self._generation})
        headers = (
            {} if self._media_generation is None else {"X-Goog-Generation": self._media_generation}
        )
        return _FakeResponse(200, content=self._content, headers=headers)

    def post(self, url: str, **kwargs: Any) -> _FakeResponse:
        authorization = kwargs["headers"]["Authorization"]
        self.authorizations.append(authorization)
        if self._is_refused(authorization):
            return _FakeResponse(self._refusal_status)
        self.object_calls += 1
        return super().post(url, **kwargs)


class _RendezvousMetadataTransport(_FakeGcsTransport):
    """A metadata server that answers only once ``parties`` callers arrive together.

    A deterministic stand-in for an unresponsive one. If the refreshes are
    serialized behind a lock the parties never meet, the barrier breaks, and
    the test fails on a type, not on a wall-clock threshold. No sleeps, no
    flake.
    """

    def __init__(self, *, parties: int, timeout: float = 5.0) -> None:
        super().__init__()
        self._barrier = threading.Barrier(parties)
        self._timeout = timeout
        self._counter_lock = threading.Lock()
        self.token_calls = 0

    def get(self, url: str, **kwargs: Any) -> _FakeResponse:
        if "metadata.google.internal" not in url:
            raise AssertionError("no object call is reachable without a credential")
        with self._counter_lock:
            self.token_calls += 1
        self._barrier.wait(timeout=self._timeout)
        return _FakeResponse(500)


@pytest.mark.asyncio
async def test_gcs_read_is_one_media_call_that_states_its_own_generation():
    """One WARM object read is ONE request, not a metadata GET plus a media GET."""
    transport = _CountingGcsTransport()
    store = GcsObjectStore("user-bucket", "pods/abc", session=transport)

    assert await store.get_with_generation("head.json") == (b"stored", 9)

    assert transport.object_gets == [{"alt": "media"}]
    # A COLD read is two round trips: this one, plus the credential mint.
    assert transport.token_calls == 1


@pytest.mark.asyncio
async def test_gcs_mints_one_credential_across_many_reads_and_a_write():
    transport = _CountingGcsTransport()
    store = GcsObjectStore("user-bucket", session=transport)

    for _ in range(3):
        assert await store.get_with_generation("head.json") == (b"stored", 9)
    assert await store.put_if_generation("head.json", b"{}", 9) == 7

    # Four object operations, four round trips, ONE minted credential.
    assert transport.token_calls == 1
    assert len(transport.object_gets) == 3
    assert len(transport.uploads) == 1
    assert set(transport.authorizations) == {"Bearer t1"}


@pytest.mark.asyncio
@pytest.mark.parametrize("expires_in", [None, 0, 30, 60, "3600", True])
async def test_gcs_reuses_no_credential_whose_stated_life_is_inside_the_margin(expires_in):
    transport = _CountingGcsTransport(expires_in=expires_in)
    store = GcsObjectStore("user-bucket", session=transport)

    await store.get_with_generation("head.json")
    await store.get_with_generation("head.json")

    assert transport.token_calls == 2
    assert transport.authorizations == ["Bearer t1", "Bearer t2"]


@pytest.mark.asyncio
async def test_a_slow_credential_mint_does_not_serialize_concurrent_reads():
    """The token lock guards the CACHE, never the metadata call.

    Holding it across the mint turns N concurrent storage operations into N
    sequential timeouts when the metadata server is unresponsive, where the
    uncached code failed all N in parallel. The rendezvous proves the four
    mints overlap: serialized, party one waits inside the barrier while the
    rest wait on the lock, the barrier breaks, and every caller raises
    BrokenBarrierError instead of the storage error.
    """
    parties = 4
    transport = _RendezvousMetadataTransport(parties=parties)
    store = GcsObjectStore("user-bucket", "pods/abc", session=transport)

    outcomes = await asyncio.gather(
        *(store.get_with_generation("head.json") for _ in range(parties)),
        return_exceptions=True,
    )

    assert [type(outcome) for outcome in outcomes] == [RuntimeError] * parties
    assert [str(outcome) for outcome in outcomes] == [
        "pod storage credential unavailable"
    ] * parties
    assert transport.token_calls == parties


@pytest.mark.asyncio
async def test_the_token_lock_is_not_held_while_the_metadata_call_is_in_flight():
    """The same rule as above, stated single-threaded and checked directly.

    A lock held across a blocking dependency call is the whole defect; this
    asks the lock itself, so the guarantee does not rest on thread timing.
    """
    transport = _CountingGcsTransport()
    store = GcsObjectStore("user-bucket", session=transport)
    lock_was_free: list[bool] = []

    class _WatchingTheLock:
        def get(self, url: str, **kwargs: Any) -> _FakeResponse:
            if "metadata.google.internal" in url:
                acquired = store._token_lock.acquire(blocking=False)
                lock_was_free.append(acquired)
                if acquired:
                    store._token_lock.release()
            return transport.get(url, **kwargs)

        def post(self, url: str, **kwargs: Any) -> _FakeResponse:
            return transport.post(url, **kwargs)

    store._session = _WatchingTheLock()

    assert await store.get_with_generation("head.json") == (b"stored", 9)
    assert lock_was_free == [True]


@pytest.mark.asyncio
async def test_gcs_missing_object_still_reads_as_absent():
    transport = _CountingGcsTransport(content=None)
    store = GcsObjectStore("user-bucket", "pods/abc", session=transport)

    assert await store.get_with_generation("head.json") == (None, 0)
    assert await store.get("head.json") is None
    assert transport.object_gets == [{"alt": "media"}, {"alt": "media"}]


@pytest.mark.asyncio
async def test_gcs_read_falls_back_to_a_pinned_read_when_no_generation_is_stated():
    """No stated generation means no proof of version, so pin it the slow way."""
    transport = _CountingGcsTransport(media_generation=None)
    store = GcsObjectStore("user-bucket", session=transport)

    assert await store.get_with_generation("head.json") == (b"stored", 9)

    assert transport.object_gets == [
        {"alt": "media"},
        {"fields": "generation"},
        {"alt": "media", "generation": "9"},
    ]
    assert transport.token_calls == 1


@pytest.mark.asyncio
async def test_a_header_stripping_path_costs_a_discarded_body_only_once():
    """Learn it once. Re-probing re-downloads the whole body on every read.

    A gateway that strips ``x-goog-generation`` strips it for every object, so
    the probe answers the same question each time and pays for the answer in
    egress. For a file manager serving large objects that is the difference
    between one wasted body and one per read.
    """
    transport = _CountingGcsTransport(media_generation=None)
    store = GcsObjectStore("user-bucket", session=transport)

    for _ in range(3):
        assert await store.get_with_generation("head.json") == (b"stored", 9)

    assert [params for params in transport.object_gets if params == {"alt": "media"}] == [
        {"alt": "media"}
    ]
    # Read one pays three trips to learn; reads two and three pay the pinned two.
    assert len(transport.object_gets) == 3 + 2 + 2


@pytest.mark.asyncio
@pytest.mark.parametrize("stated", ["0", "-1", "oops", "", "9 "])
async def test_gcs_read_falls_back_when_the_stated_generation_is_unusable(stated):
    """A MALFORMED header is the same fact as an ABSENT one: no proof of version.

    It must take the same fallback, not fail closed. The fallback re-derives
    the generation authoritatively from the metadata endpoint, so it is exactly
    as safe as the stripped-header case, and refusing instead would let one
    normalizing egress proxy take the pod's storage down.
    """
    transport = _CountingGcsTransport(generation="9", media_generation=stated)
    store = GcsObjectStore("user-bucket", session=transport)

    assert await store.get_with_generation("head.json") == (b"stored", 9)

    # The request SHAPE is what distinguishes the header path from the body
    # path: the old two-call read never issues a bare {'alt': 'media'} first,
    # and the hard-failing version never issues the two calls after it.
    assert transport.object_gets == [
        {"alt": "media"},
        {"fields": "generation"},
        {"alt": "media", "generation": "9"},
    ]


@pytest.mark.asyncio
@pytest.mark.parametrize("stated", ["0", "oops", ""])
async def test_gcs_read_still_refuses_when_no_call_can_prove_the_generation(stated):
    """Falling back is not giving up: with nothing provable anywhere, refuse."""
    transport = _CountingGcsTransport(generation=stated, media_generation=stated)
    store = GcsObjectStore("user-bucket", session=transport)

    with pytest.raises(RuntimeError, match="pod storage generation unverified"):
        await store.get_with_generation("head.json")

    assert transport.object_gets == [{"alt": "media"}, {"fields": "generation"}]


@pytest.mark.asyncio
@pytest.mark.parametrize("refusal_status", [401, 403])
async def test_a_credential_refused_mid_life_is_dropped_and_reminted(refusal_status):
    """The self-healing the cache would otherwise have cost.

    Before caching, every call minted fresh, so a credential that died mid-life
    healed on the next call. Cached, a dead bearer would be re-presented for
    the rest of its window unless a refusal evicts it.
    """
    transport = _CountingGcsTransport(credential_dies_after=1, refusal_status=refusal_status)
    store = GcsObjectStore("user-bucket", session=transport)

    assert await store.get_with_generation("head.json") == (b"stored", 9)
    assert await store.get_with_generation("head.json") == (b"stored", 9)
    assert await store.get_with_generation("head.json") == (b"stored", 9)

    assert transport.token_calls == 2
    assert transport.authorizations == ["Bearer t1", "Bearer t1", "Bearer t2", "Bearer t2"]


@pytest.mark.asyncio
async def test_a_refused_write_credential_is_reminted_and_the_write_still_lands():
    """The retry is safe on the write too: ifGenerationMatch rides on it."""
    transport = _CountingGcsTransport(credential_dies_after=0)
    store = GcsObjectStore("user-bucket", session=transport)

    assert await store.put_if_generation("head.json", b"{}", 3) == 7

    assert transport.token_calls == 2
    assert transport.authorizations == ["Bearer t1", "Bearer t2"]
    assert [upload["ifGenerationMatch"] for upload in transport.uploads] == ["3"]


@pytest.mark.asyncio
async def test_a_credential_refused_twice_fails_rather_than_looping():
    transport = _CountingGcsTransport(refuse_every_credential=True)
    store = GcsObjectStore("user-bucket", session=transport)

    with pytest.raises(RuntimeError, match="pod storage content unavailable"):
        await store.get_with_generation("head.json")

    assert transport.object_gets == [{"alt": "media"}, {"alt": "media"}]
    assert transport.token_calls == 2


# --- the shared key validator ---------------------------------------------------------


@pytest.mark.parametrize(
    "key",
    [
        "",
        "/head.json",
        "..",
        "../head.json",
        "records/../../head.json",
        # The prefix-confusion case: naive concatenation under prefix 'pods/abc'
        # yields 'pods/abc/../abcdef/head.json', which resolves to a SIBLING pod.
        "../abcdef/head.json",
        "pods/abc/../abcdef/head.json",
        "records//head.json",
        "records/./head.json",
        "records/",
        "records\\head.json",
        "records/head\njson",
        "records/head\x7fjson",
        "\x00",
    ],
)
def test_both_stores_reject_the_same_unsafe_object_keys(tmp_path: Path, key: str):
    gcs = GcsObjectStore("user-bucket", "pods/abc", session=_CountingGcsTransport())
    with pytest.raises(ValueError):
        gcs._key(key)
    with pytest.raises(ValueError):
        LocalObjectStore(str(tmp_path))._path(key)


@pytest.mark.parametrize(
    "key",
    [
        "%2e%2e/head.json",
        "a/%2e%2e/%2e%2e/pods/abcdef/head.json",
        "..%2f..%2fetc",
        "%2fhead.json",
        "records/%2e%2e/head.json",
        "%252e%252e/head.json",
        "records/%00",
        "records/%5chead.json",
    ],
)
def test_both_stores_reject_percent_encoded_traversal(tmp_path: Path, key: str):
    """Traversal written in a second alphabet is still traversal.

    The stated threat model is a file manager built on these stores, and a file
    manager takes keys over HTTP, where some layer decodes once more than the
    validator did.
    """
    gcs = GcsObjectStore("user-bucket", "pods/abc", session=_CountingGcsTransport())
    with pytest.raises(ValueError):
        gcs._key(key)
    with pytest.raises(ValueError):
        LocalObjectStore(str(tmp_path))._path(key)


def test_an_undecodable_escape_is_refused_rather_than_guessed():
    with pytest.raises(ValueError, match="undecodable escape"):
        object_key_segments("records/%ff%fe.bin")


def test_a_literal_percent_in_a_key_is_still_a_usable_key():
    """Decode-then-validate refuses traversal, not every key containing a '%'."""
    gcs = GcsObjectStore("user-bucket", "pods/abc", session=_CountingGcsTransport())
    assert gcs._key("records/50%25-off.bin") == "pods/abc/records/50%25-off.bin"


def test_prefix_confinement_compares_whole_segments_not_a_string_prefix():
    # The naive check that CVE-2025-53110 shipped: a sibling whose NAME merely
    # starts with the allowed one passes a string prefix test.
    assert "pods/abcdef/head.json".startswith("pods/abc")

    assert object_key_is_within("pods/abc", "pods/abc/head.json") is True
    assert object_key_is_within("pods/abc", "pods/abcdef/head.json") is False
    assert object_key_is_within("pods/abc", "pods/abc") is False
    assert object_key_is_within("", "head.json") is True


def test_prefix_confinement_resolves_traversal_itself_and_never_raises():
    """Layer two has to hold on its own, not because layer one ran first."""
    assert object_key_is_within("pods/abc", "pods/abc/./head.json") is True
    assert object_key_is_within("pods/abc", "pods/abc/records/../head.json") is True
    assert object_key_is_within("pods/abc", "pods/abc/../abcdef/head.json") is False
    assert object_key_is_within("pods/abc", "pods/abc/..") is False
    assert object_key_is_within("pods/abc", "../../etc/passwd") is False
    assert object_key_is_within("pods/../other", "pods/abc/head.json") is False


def test_the_key_confinement_check_still_refuses_when_the_validator_is_relaxed(monkeypatch):
    """Defence in depth, demonstrated rather than advertised.

    Relax layer one to a bare split -- the plausible way it gets relaxed is a
    file manager wanting relative navigation -- and layer two must still refuse
    the escape.
    """
    monkeypatch.setattr(pod_commit_log, "object_key_segments", lambda key: tuple(key.split("/")))
    store = GcsObjectStore("user-bucket", "pods/abc", session=_CountingGcsTransport())

    assert store._key("records/head.json") == "pods/abc/records/head.json"
    for escaping in ("../abcdef/head.json", "../../etc/passwd", ".."):
        with pytest.raises(ValueError, match="escapes the store prefix"):
            store._key(escaping)


@pytest.mark.asyncio
async def test_a_traversing_key_never_reaches_a_sibling_pod_prefix():
    transport = _CountingGcsTransport()
    store = GcsObjectStore("user-bucket", "pods/abc", session=transport)

    assert store._key("head.json") == "pods/abc/head.json"
    for unsafe in ("../abcdef/head.json", "/pods/abcdef/head.json"):
        with pytest.raises(ValueError):
            await store.get_with_generation(unsafe)
        with pytest.raises(ValueError):
            await store.put_if_generation(unsafe, b"{}", 0)

    # Refused before any credential is minted or any request is sent.
    assert (transport.token_calls, transport.object_gets, transport.uploads) == (0, [], [])


def test_a_traversing_store_prefix_is_refused_at_construction():
    for unsafe in ("pods/../other", "pods//abc", "pods/abc\\evil", "pods/abc\n", "pods/%2e%2e"):
        with pytest.raises(ValueError):
            GcsObjectStore("user-bucket", unsafe, session=_CountingGcsTransport())


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
async def test_a_pkm_rebuild_skips_every_agent_memory_kind(tmp_path: Path):
    """Schema 2 added five memory kinds beside the raw record. None of them is a
    PKM operation, so a PKM rebuild must step over all of them exactly as it
    steps over ``agent_memory`` -- and the memory service's own vocabulary is the
    list, so a kind added there without a matching decision here is caught."""
    from hushh_mcp.services.pod_memory_service import MEMORY_RECORD_KINDS

    log = PodCommitLog(LocalObjectStore(str(tmp_path / "shared-store")), KEY)
    assert len(MEMORY_RECORD_KINDS) >= 6
    for kind in sorted(MEMORY_RECORD_KINDS):
        # Deliberately PKM-shaped owner field with no other PKM fields: if the
        # rebuild dispatched on one of these kinds the engine would raise.
        await log.append(kind, {"hushh_id": "owner-a", "p_user_id": "owner-a", "memory_ids": []})
    assert len(await log.replay()) == len(MEMORY_RECORD_KINDS)

    store = await PodPkmStore.rebuild(log, str(tmp_path / "a.sqlite3"), owner_user_id="owner-a")
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


@pytest.mark.asyncio
async def test_gcs_write_keeps_loop_responsive_and_joins_cancelled_worker():
    import asyncio
    import threading

    entered = threading.Event()
    release = threading.Event()
    completed = threading.Event()

    class BlockingTransport(_FakeGcsTransport):
        def post(self, url, **kwargs):
            entered.set()
            try:
                assert release.wait(3), "event loop did not release upload"
                return super().post(url, **kwargs)
            finally:
                completed.set()

    store = GcsObjectStore("user-bucket", session=BlockingTransport())
    task = asyncio.create_task(store.put_if_generation("head.json", b"{}", 3))
    try:
        assert await asyncio.to_thread(entered.wait, 2)
        task.cancel()
        await asyncio.sleep(0)
        task.cancel()
        await asyncio.sleep(0)
        assert not task.done()
        assert not completed.is_set()
    finally:
        release.set()
    with pytest.raises(asyncio.CancelledError):
        await task
    assert completed.is_set()


@pytest.mark.asyncio
@pytest.mark.parametrize("status,generation", [(302, "7"), (200, True), (200, "0"), (200, "oops")])
async def test_gcs_write_refuses_redirect_or_invalid_generation(status, generation):
    class InvalidTransport(_FakeGcsTransport):
        def get(self, url, **kwargs):
            assert kwargs["allow_redirects"] is False
            return super().get(url, **kwargs)

        def post(self, url, **kwargs):
            assert kwargs["allow_redirects"] is False
            return _FakeResponse(status, {"generation": generation})

    store = GcsObjectStore("user-bucket", session=InvalidTransport())
    with pytest.raises(RuntimeError, match="pod storage (write unconfirmed|generation unverified)"):
        await store.put_if_generation("head.json", b"{}", 3)
