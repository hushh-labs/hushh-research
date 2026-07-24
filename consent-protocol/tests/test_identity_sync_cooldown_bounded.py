"""Hermetic unit tests for _IdentitySyncCooldownStore in actor_identity_service.

Canonical attach point:
    ActorIdentityService.schedule_sync_from_firebase -> GET /api/user/lookup
    (session.router -> api/routes/session.py -> ActorIdentityService.schedule_sync_from_firebase
     -> _IDENTITY_SYNC_COOLDOWN_UNTIL.get/.set -> _IdentitySyncCooldownStore)

No DB, no network, no LLM.

Covered:
    construction (default and custom capacity)
    get -- hit, miss
    set -- basic, overwrites, deadline stored
    size cap -- stale-first eviction, then FIFO oldest
    __len__ and clear
    concurrency -- concurrent writers, concurrent reader+writer
    call proof -- schedule_sync_from_firebase reads and writes _IDENTITY_SYNC_COOLDOWN_UNTIL
"""

from __future__ import annotations

import threading
from datetime import datetime, timedelta, timezone

import pytest

from hushh_mcp.services.actor_identity_service import (
    _IDENTITY_SYNC_COOLDOWN_MAX,
    _IDENTITY_SYNC_COOLDOWN_UNTIL,
    ActorIdentityService,
    _IdentitySyncCooldownStore,
    _positive_int_env,
)


def _future(seconds: float = 60) -> datetime:
    return datetime.now(timezone.utc) + timedelta(seconds=seconds)


def _past(seconds: float = 1) -> datetime:
    return datetime.now(timezone.utc) - timedelta(seconds=seconds)


# ---------------------------------------------------------------------------
# fixture: reset module-level store between tests
# ---------------------------------------------------------------------------


@pytest.fixture(autouse=True)
def _reset():
    _IDENTITY_SYNC_COOLDOWN_UNTIL.clear()
    original_max = _IDENTITY_SYNC_COOLDOWN_UNTIL._max
    yield
    _IDENTITY_SYNC_COOLDOWN_UNTIL.clear()
    _IDENTITY_SYNC_COOLDOWN_UNTIL._max = original_max


# ===========================================================================
# Construction
# ===========================================================================


class TestConstruction:
    def test_default_capacity_matches_env_var(self):
        store = _IdentitySyncCooldownStore()
        assert store._max == _IDENTITY_SYNC_COOLDOWN_MAX

    def test_custom_capacity(self):
        store = _IdentitySyncCooldownStore(max_entries=10)
        assert store._max == 10

    def test_initial_length_is_zero(self):
        assert len(_IdentitySyncCooldownStore()) == 0

    def test_invalid_capacity_env_uses_default(self, monkeypatch: pytest.MonkeyPatch):
        monkeypatch.setenv("ACTOR_IDENTITY_SYNC_COOLDOWN_MAX", "not-an-int")
        assert _positive_int_env("ACTOR_IDENTITY_SYNC_COOLDOWN_MAX", 5000) == 5000


# ===========================================================================
# get
# ===========================================================================


class TestGet:
    def test_missing_key_returns_none(self):
        store = _IdentitySyncCooldownStore()
        assert store.get("uid_unknown") is None

    def test_hit_returns_stored_deadline(self):
        store = _IdentitySyncCooldownStore()
        deadline = _future(300)
        store.set("uid_1", deadline)
        assert store.get("uid_1") == deadline

    def test_get_does_not_evict_expired_entries(self):
        # get() is a pure lookup — eviction only happens in set()
        store = _IdentitySyncCooldownStore()
        past = _past()
        store._store["uid_old"] = past
        result = store.get("uid_old")
        assert result == past
        assert "uid_old" in store._store


# ===========================================================================
# set
# ===========================================================================


class TestSet:
    def test_set_adds_entry(self):
        store = _IdentitySyncCooldownStore()
        store.set("uid_1", _future())
        assert len(store) == 1

    def test_set_overwrites_existing_key(self):
        store = _IdentitySyncCooldownStore()
        store.set("uid_1", _future(60))
        new_deadline = _future(120)
        store.set("uid_1", new_deadline)
        assert store.get("uid_1") == new_deadline
        assert len(store) == 1

    def test_set_stores_future_deadline(self):
        store = _IdentitySyncCooldownStore()
        deadline = _future(300)
        store.set("uid_1", deadline)
        assert store._store["uid_1"] > datetime.now(timezone.utc)


# ===========================================================================
# size cap — eviction
# ===========================================================================


class TestSizeCap:
    def test_stale_entries_evicted_first(self):
        store = _IdentitySyncCooldownStore(max_entries=3)
        for i in range(3):
            store._store[f"stale_{i}"] = _past()
        store.set("fresh", _future())
        assert store.get("fresh") is not None
        assert len(store) == 1

    def test_oldest_evicted_when_no_stale(self):
        store = _IdentitySyncCooldownStore(max_entries=3)
        store.set("first", _future())
        store.set("second", _future())
        store.set("third", _future())
        store.set("fourth", _future())
        assert len(store) == 3
        assert store.get("first") is None
        assert store.get("fourth") is not None

    def test_overwriting_existing_key_does_not_evict(self):
        store = _IdentitySyncCooldownStore(max_entries=2)
        store.set("a", _future())
        store.set("b", _future())
        store.set("a", _future(120))
        assert len(store) == 2
        assert store.get("b") is not None

    def test_capacity_one_always_holds_latest(self):
        store = _IdentitySyncCooldownStore(max_entries=1)
        for i in range(5):
            store.set(f"uid_{i}", _future())
        assert len(store) == 1
        assert store.get("uid_4") is not None


# ===========================================================================
# __len__ and clear
# ===========================================================================


class TestLenAndClear:
    def test_len_reflects_count(self):
        store = _IdentitySyncCooldownStore()
        assert len(store) == 0
        store.set("a", _future())
        assert len(store) == 1
        store.set("b", _future())
        assert len(store) == 2

    def test_clear_empties_store(self):
        store = _IdentitySyncCooldownStore()
        for i in range(5):
            store.set(f"uid_{i}", _future())
        store.clear()
        assert len(store) == 0

    def test_get_after_clear_returns_none(self):
        store = _IdentitySyncCooldownStore()
        store.set("uid_1", _future())
        store.clear()
        assert store.get("uid_1") is None


# ===========================================================================
# Concurrency
# ===========================================================================


class TestConcurrency:
    def test_concurrent_writers_no_error(self):
        store = _IdentitySyncCooldownStore(max_entries=200)
        errors: list[Exception] = []

        def _writer(start: int) -> None:
            try:
                for i in range(60):
                    store.set(f"uid_{start}_{i}", _future())
            except Exception as exc:
                errors.append(exc)

        threads = [threading.Thread(target=_writer, args=(t * 100,)) for t in range(4)]
        for t in threads:
            t.start()
        for t in threads:
            t.join()

        assert not errors
        assert len(store) <= 200

    def test_concurrent_reads_and_writes(self):
        store = _IdentitySyncCooldownStore(max_entries=100)
        store.set("shared", _future())
        errors: list[Exception] = []

        def _reader() -> None:
            try:
                for _ in range(100):
                    store.get("shared")
            except Exception as exc:
                errors.append(exc)

        def _writer() -> None:
            try:
                for i in range(100):
                    store.set("shared", _future(60 + i))
            except Exception as exc:
                errors.append(exc)

        threads = [threading.Thread(target=_reader) for _ in range(3)]
        threads += [threading.Thread(target=_writer) for _ in range(2)]
        for t in threads:
            t.start()
        for t in threads:
            t.join()

        assert not errors

    def test_module_store_bounded_at_configured_max(self):
        _IDENTITY_SYNC_COOLDOWN_UNTIL._max = 5
        for i in range(10):
            _IDENTITY_SYNC_COOLDOWN_UNTIL.set(f"uid_{i}", _future())
        assert len(_IDENTITY_SYNC_COOLDOWN_UNTIL) <= 5


# ---------------------------------------------------------------------------
# Call proof: schedule_sync_from_firebase -> _IDENTITY_SYNC_COOLDOWN_UNTIL
#
# GET /api/user/lookup (session.router) calls
#   ActorIdentityService().schedule_sync_from_firebase(uid, force=False)
# which is the canonical route into _IdentitySyncCooldownStore.
# ---------------------------------------------------------------------------


class TestScheduleSyncFromFirebaseCallProof:
    """Prove schedule_sync_from_firebase reads and writes _IDENTITY_SYNC_COOLDOWN_UNTIL."""

    def test_cooldown_written_on_first_call(self):
        """schedule_sync_from_firebase sets a cooldown deadline on first call."""
        import asyncio

        uid = "schedulecallproof_uid_first"
        _IDENTITY_SYNC_COOLDOWN_UNTIL.clear()
        assert _IDENTITY_SYNC_COOLDOWN_UNTIL.get(uid) is None

        async def _run():
            ActorIdentityService().schedule_sync_from_firebase(uid, force=False)

        asyncio.run(_run())
        # Cooldown must have been written by schedule_sync_from_firebase.
        assert _IDENTITY_SYNC_COOLDOWN_UNTIL.get(uid) is not None

    def test_cooldown_prevents_duplicate_sync(self):
        """Second call within cooldown window returns False without scheduling a new task."""
        import asyncio

        uid = "schedulecallproof_uid_dup"
        _IDENTITY_SYNC_COOLDOWN_UNTIL.clear()

        async def _run():
            svc = ActorIdentityService()
            first = svc.schedule_sync_from_firebase(uid, force=False)
            second = svc.schedule_sync_from_firebase(uid, force=False)
            return first, second

        first, second = asyncio.run(_run())
        # First call enters the scheduler; second is rejected by the cooldown.
        assert first is True
        assert second is False

    def test_force_bypasses_cooldown(self):
        """force=True schedules a sync even when a cooldown entry exists."""
        import asyncio

        uid = "schedulecallproof_uid_force"
        _IDENTITY_SYNC_COOLDOWN_UNTIL.clear()
        _IDENTITY_SYNC_COOLDOWN_UNTIL.set(uid, _future(3600))

        async def _run():
            return ActorIdentityService().schedule_sync_from_firebase(uid, force=True)

        result = asyncio.run(_run())
        assert result is True
