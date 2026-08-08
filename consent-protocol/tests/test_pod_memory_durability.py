"""Does a pod's agent memory actually survive the pod?

The economy tier scales to zero, so "between turns" and "after a restart" are the
same event. Before this, `PodMemoryStore._records` was an in-process list that
nothing persisted -- the module said so itself -- which meant a pod configured for
durability still woke up with no memory of its owner. These tests are the ones that
would have caught that: they do not check that persistence is *configured*, they
destroy the store and ask whether anything comes back.

The model of pod death is deliberate: build a service, use it, DROP every reference,
then build a second service from nothing but the owner id and key. Nothing is carried
across in Python; only the log is.
"""

from __future__ import annotations

import asyncio
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from hushh_mcp.services.pod_commit_log import (  # noqa: E402
    LocalObjectStore,
    PodCommitLog,
    PodLogTampered,
)
from hushh_mcp.services.pod_memory_service import (  # noqa: E402
    PodMemoryError,
    PodMemoryStore,
    SealedMemory,
    build_pod_memory_service,
)

pytest.importorskip("google.adk.memory.base_memory_service")

OWNER = "HA1MEMDURABLE001"
OTHER = "HA1MEMDURABLE002"
KEY = b"\x11" * 32
OTHER_KEY = b"\x22" * 32


class _Event:
    """The shape `add_session_to_memory` reads: an author and part-shaped content."""

    def __init__(self, text: str, author: str = "user") -> None:
        self.author = author
        self.content = _Content(text)


class _Content:
    def __init__(self, text: str) -> None:
        self.parts = [_Part(text)]


class _Part:
    def __init__(self, text: str) -> None:
        self.text = text


class _Session:
    def __init__(self, *texts: str) -> None:
        self.events = [_Event(t) for t in texts]


def _log(tmp_path: Path, key: bytes = KEY) -> PodCommitLog:
    return PodCommitLog(LocalObjectStore(str(tmp_path / "store")), key)


def test_memory_survives_the_death_of_the_pod(tmp_path: Path) -> None:
    """The whole point: a second generation recalls what the first was told."""

    async def run() -> None:
        first = build_pod_memory_service(hushh_id=OWNER, pod_key=KEY, log=_log(tmp_path))
        await first.add_session_to_memory(_Session("the guest room radiator leaks"))

        # The pod dies. Nothing survives in-process.
        del first

        second = build_pod_memory_service(hushh_id=OWNER, pod_key=KEY, log=_log(tmp_path))
        hits = await second.search_memory(app_name="one", user_id=OWNER, query="radiator")
        assert [m.content.parts[0].text for m in hits.memories] == [
            "the guest room radiator leaks"
        ]

    asyncio.run(run())


def test_without_a_log_memory_does_not_survive(tmp_path: Path) -> None:
    """The honest negative. No durable state configured means forgetful, not broken."""

    async def run() -> None:
        first = build_pod_memory_service(hushh_id=OWNER, pod_key=KEY, log=None)
        await first.add_session_to_memory(_Session("the guest room radiator leaks"))
        del first

        second = build_pod_memory_service(hushh_id=OWNER, pod_key=KEY, log=None)
        hits = await second.search_memory(app_name="one", user_id=OWNER, query="radiator")
        assert list(hits.memories) == []

    asyncio.run(run())


def test_a_neighbours_key_cannot_open_this_pods_memory(tmp_path: Path) -> None:
    """Custody, not just configuration: the same log under a different key is unreadable."""

    async def run() -> None:
        first = build_pod_memory_service(hushh_id=OWNER, pod_key=KEY, log=_log(tmp_path))
        await first.add_session_to_memory(_Session("the guest room radiator leaks"))
        del first

        # A pod holding a different derived key, pointed at the same objects. The
        # commit log seals every record under its own key, so this fails at the log
        # -- and specifically as TAMPERING, not as an empty history. The distinction
        # is the point: a wrong key must be loud, because "I have no memories" is a
        # plausible-looking answer that would hide a custody failure completely.
        impostor = build_pod_memory_service(
            hushh_id=OWNER, pod_key=OTHER_KEY, log=_log(tmp_path, OTHER_KEY)
        )
        with pytest.raises(PodLogTampered):
            await impostor.search_memory(app_name="one", user_id=OWNER, query="radiator")

    asyncio.run(run())


def test_replaying_another_owners_record_is_refused_not_skipped() -> None:
    """Invariant 1 at the replay boundary.

    Silently dropping a foreign record would make a wrong prefix look exactly like a
    first boot -- an empty history is indistinguishable from a misconfigured one, so
    it must raise.
    """
    store = PodMemoryStore(hushh_id=OWNER, pod_key=KEY)
    foreign = SealedMemory(
        memory_id="deadbeef",
        hushh_id=OTHER,
        created_at_ms=1,
        ciphertext="v2.irrelevant",
        token_digests=(),
    )
    with pytest.raises(PodMemoryError):
        store.hydrate([foreign])


def test_hydrate_is_bounded_and_keeps_the_newest() -> None:
    """A pod waking with more history than it can hold keeps the recent end."""
    from hushh_mcp.services.pod_memory_service import _MAX_ENTRIES_PER_OWNER

    store = PodMemoryStore(hushh_id=OWNER, pod_key=KEY)
    overflow = _MAX_ENTRIES_PER_OWNER + 10
    store.hydrate(
        SealedMemory(
            memory_id=f"id{i}",
            hushh_id=OWNER,
            created_at_ms=i,
            ciphertext="v2.x",
            token_digests=(),
        )
        for i in range(overflow)
    )
    assert len(store) == _MAX_ENTRIES_PER_OWNER
    # Oldest evicted: the first record kept is the one at the truncation boundary.
    assert store.export().find(f'"id{overflow - 1}"') != -1
    assert store.export().find('"id0"') == -1


def test_the_persisted_envelope_carries_no_plaintext_metadata() -> None:
    """Invariant 2 applies to the envelope, not only the message.

    `custom_metadata` is caller-supplied. Storing it beside the ciphertext would make
    the invariant true of the text and false of everything around it.
    """
    store = PodMemoryStore(hushh_id=OWNER, pod_key=KEY)
    rec = store.add(
        text="the guest room radiator leaks",
        author="user",
        custom_metadata={"note": "SENSITIVE-MARKER"},
    )
    assert rec is not None
    payload = rec.as_payload(KEY)
    blob = str(payload)
    assert "SENSITIVE-MARKER" not in blob
    assert "radiator" not in blob
    # And it round-trips.
    back = SealedMemory.from_payload(KEY, payload)
    assert back.author == "user"
    assert back.custom_metadata == {"note": "SENSITIVE-MARKER"}


def test_an_envelope_cannot_be_replayed_into_another_owners_pod() -> None:
    """The envelope is owner-bound, so lifting a record between pods fails."""
    store = PodMemoryStore(hushh_id=OWNER, pod_key=KEY)
    rec = store.add(text="the guest room radiator leaks", author="user")
    assert rec is not None
    payload = rec.as_payload(KEY)
    payload["hushh_id"] = OTHER  # pretend it belongs to the neighbour
    with pytest.raises(PodMemoryError):
        SealedMemory.from_payload(KEY, payload)


def test_hydration_happens_once_not_per_turn(tmp_path: Path) -> None:
    """Replay is serial and unparallelisable; paying it twice would be a real cost."""

    async def run() -> None:
        log = _log(tmp_path)
        seed = build_pod_memory_service(hushh_id=OWNER, pod_key=KEY, log=log)
        await seed.add_session_to_memory(_Session("the guest room radiator leaks"))
        del seed

        counting = _log(tmp_path)
        calls = {"n": 0}
        real_replay = counting.replay

        async def counted():
            calls["n"] += 1
            return await real_replay()

        counting.replay = counted  # type: ignore[method-assign]

        svc = build_pod_memory_service(hushh_id=OWNER, pod_key=KEY, log=counting)
        await svc.search_memory(app_name="one", user_id=OWNER, query="radiator")
        await svc.search_memory(app_name="one", user_id=OWNER, query="radiator")
        await svc.add_session_to_memory(_Session("and the window sticks"))
        assert calls["n"] == 1

    asyncio.run(run())


def test_a_failed_replay_stays_retryable(tmp_path: Path) -> None:
    """A transient read failure must not latch the pod into a memoryless state."""

    async def run() -> None:
        log = _log(tmp_path)
        seed = build_pod_memory_service(hushh_id=OWNER, pod_key=KEY, log=log)
        await seed.add_session_to_memory(_Session("the guest room radiator leaks"))
        del seed

        flaky = _log(tmp_path)
        real_replay = flaky.replay
        state = {"fail": True}

        async def sometimes():
            if state["fail"]:
                state["fail"] = False
                raise RuntimeError("transient GCS read failure")
            return await real_replay()

        flaky.replay = sometimes  # type: ignore[method-assign]

        svc = build_pod_memory_service(hushh_id=OWNER, pod_key=KEY, log=flaky)
        with pytest.raises(RuntimeError):
            await svc.search_memory(app_name="one", user_id=OWNER, query="radiator")
        # The second attempt must actually replay rather than report an empty history.
        hits = await svc.search_memory(app_name="one", user_id=OWNER, query="radiator")
        assert [m.content.parts[0].text for m in hits.memories] == [
            "the guest room radiator leaks"
        ]

    asyncio.run(run())


def test_memory_records_do_not_disturb_other_log_kinds(tmp_path: Path) -> None:
    """The log is shared with the PKM path, so replay must filter on kind."""

    async def run() -> None:
        log = _log(tmp_path)
        await log.append("storage_pointer", {"hushh_id": OWNER, "ref": "blob://x"})
        svc = build_pod_memory_service(hushh_id=OWNER, pod_key=KEY, log=log)
        await svc.add_session_to_memory(_Session("the guest room radiator leaks"))
        await log.append("storage_pointer", {"hushh_id": OWNER, "ref": "blob://y"})
        del svc

        second = build_pod_memory_service(hushh_id=OWNER, pod_key=KEY, log=_log(tmp_path))
        hits = await second.search_memory(app_name="one", user_id=OWNER, query="radiator")
        assert len(hits.memories) == 1

    asyncio.run(run())
