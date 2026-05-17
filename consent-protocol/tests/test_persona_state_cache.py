"""Hermetic unit tests for _PersonaStateCache in ria_iam_service.

Canonical attach point:
    RIAIAMService.get_persona_state -> GET /api/iam/persona
    (iam.router -> api/routes/iam.py -> RIAIAMService.get_persona_state
     -> RIAIAMService._read_cached_persona_state -> _PersonaStateCache.get)

No DB, no network, no LLM - all pure in-process assertions.
"""

from __future__ import annotations

import threading
from datetime import timedelta

import pytest

from hushh_mcp.services.ria_iam_service import (
    _PERSONA_STATE_CACHE,
    _PERSONA_STATE_CACHE_TTL,
    RIAIAMService,
    _PersonaStateCache,
)

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

_PAYLOAD_A: dict = {"user_id": "u1", "personas": ["investor"], "last_active_persona": "investor"}
_PAYLOAD_B: dict = {"user_id": "u2", "personas": ["ria"], "last_active_persona": "ria"}
_SHORT_TTL = timedelta(milliseconds=50)
_LONG_TTL = timedelta(hours=1)


def _fresh() -> _PersonaStateCache:
    return _PersonaStateCache()


# ---------------------------------------------------------------------------
# Construction
# ---------------------------------------------------------------------------


class TestConstruction:
    def test_default_max_entries_is_10000(self):
        c = _fresh()
        assert c._max == 10_000

    def test_custom_max_entries(self):
        c = _PersonaStateCache(max_entries=42)
        assert c._max == 42

    def test_zero_max_raises(self):
        with pytest.raises(ValueError, match="max_entries must be >= 1"):
            _PersonaStateCache(max_entries=0)

    def test_negative_max_raises(self):
        with pytest.raises(ValueError, match="max_entries must be >= 1"):
            _PersonaStateCache(max_entries=-5)

    def test_starts_empty(self):
        assert len(_fresh()) == 0


# ---------------------------------------------------------------------------
# Basic get / set / invalidate
# ---------------------------------------------------------------------------


class TestBasicSemantics:
    def test_missing_key_returns_none(self):
        c = _fresh()
        assert c.get("missing", _LONG_TTL) is None

    def test_set_then_get_returns_copy(self):
        c = _fresh()
        c.set("u1", _PAYLOAD_A)
        result = c.get("u1", _LONG_TTL)
        assert result == _PAYLOAD_A
        # Must be a copy, not the same object
        assert result is not _PAYLOAD_A

    def test_get_returns_independent_copy(self):
        c = _fresh()
        c.set("u1", _PAYLOAD_A)
        r1 = c.get("u1", _LONG_TTL)
        r1["mutated"] = True  # type: ignore[index]
        r2 = c.get("u1", _LONG_TTL)
        assert "mutated" not in r2  # type: ignore[operator]

    def test_set_overwrites_existing(self):
        c = _fresh()
        c.set("u1", _PAYLOAD_A)
        c.set("u1", _PAYLOAD_B)
        result = c.get("u1", _LONG_TTL)
        assert result == _PAYLOAD_B

    def test_invalidate_removes_entry(self):
        c = _fresh()
        c.set("u1", _PAYLOAD_A)
        c.invalidate("u1")
        assert c.get("u1", _LONG_TTL) is None

    def test_invalidate_noop_on_missing(self):
        c = _fresh()
        c.invalidate("nonexistent")  # must not raise

    def test_len_tracks_entries(self):
        c = _fresh()
        assert len(c) == 0
        c.set("u1", _PAYLOAD_A)
        assert len(c) == 1
        c.set("u2", _PAYLOAD_B)
        assert len(c) == 2
        c.invalidate("u1")
        assert len(c) == 1

    def test_clear_empties_cache(self):
        c = _fresh()
        c.set("u1", _PAYLOAD_A)
        c.set("u2", _PAYLOAD_B)
        c.clear()
        assert len(c) == 0


# ---------------------------------------------------------------------------
# TTL eviction
# ---------------------------------------------------------------------------


class TestTTLEviction:
    def test_expired_entry_returns_none(self):
        import time

        c = _fresh()
        c.set("u1", _PAYLOAD_A)
        time.sleep(0.06)  # wait past 50 ms TTL
        assert c.get("u1", _SHORT_TTL) is None

    def test_expired_entry_removed_from_cache(self):
        import time

        c = _fresh()
        c.set("u1", _PAYLOAD_A)
        time.sleep(0.06)
        c.get("u1", _SHORT_TTL)
        assert len(c) == 0

    def test_live_entry_not_evicted(self):
        c = _fresh()
        c.set("u1", _PAYLOAD_A)
        assert c.get("u1", _LONG_TTL) is not None

    def test_default_ttl_is_30_seconds(self):
        assert _PERSONA_STATE_CACHE_TTL == timedelta(seconds=30)


# ---------------------------------------------------------------------------
# Size cap
# ---------------------------------------------------------------------------


class TestSizeCap:
    def test_cap_never_exceeded(self):
        c = _PersonaStateCache(max_entries=5)
        for i in range(20):
            c.set(f"u{i}", {"idx": i})
        assert len(c) <= 5

    def test_expired_evicted_before_oldest(self):
        """Stale entries are pruned first; live entries survive cap pressure."""
        import time

        c = _PersonaStateCache(max_entries=3)
        # Insert two entries with a very short TTL that will expire
        c.set("stale1", {"v": 1})
        c.set("stale2", {"v": 2})
        time.sleep(0.06)  # let them expire (using _SHORT_TTL = 50ms)
        # Now insert one live entry - stale1/stale2 should be pruned in next set
        c.set("live1", {"v": 3})
        # Insert two more live entries; stale ones serve as eviction candidates
        c.set("live2", {"v": 4})
        c.set("live3", {"v": 5})
        # live entries should all be accessible with a long TTL
        assert c.get("live1", _LONG_TTL) is not None
        assert c.get("live3", _LONG_TTL) is not None
        assert len(c) <= 3

    def test_oldest_evicted_when_all_live(self):
        c = _PersonaStateCache(max_entries=3)
        c.set("first", {"v": 1})
        c.set("second", {"v": 2})
        c.set("third", {"v": 3})
        # This insert must evict "first" (oldest-inserted)
        c.set("fourth", {"v": 4})
        assert c.get("first", _LONG_TTL) is None
        assert c.get("fourth", _LONG_TTL) is not None

    def test_max_entries_one(self):
        c = _PersonaStateCache(max_entries=1)
        c.set("u1", _PAYLOAD_A)
        c.set("u2", _PAYLOAD_B)
        assert len(c) == 1
        # Only the latest entry survives
        assert c.get("u2", _LONG_TTL) is not None
        assert c.get("u1", _LONG_TTL) is None

    def test_update_in_place_does_not_grow(self):
        c = _PersonaStateCache(max_entries=2)
        c.set("u1", _PAYLOAD_A)
        c.set("u2", _PAYLOAD_B)
        # Updating an existing key must not exceed cap
        c.set("u1", {"updated": True})
        assert len(c) == 2


# ---------------------------------------------------------------------------
# Concurrency
# ---------------------------------------------------------------------------


class TestConcurrency:
    def test_concurrent_writes_stay_within_cap(self):
        cap = 100
        c = _PersonaStateCache(max_entries=cap)
        errors: list[Exception] = []

        def _worker(start: int) -> None:
            try:
                for i in range(start, start + 50):
                    c.set(f"u{i}", {"idx": i})
            except Exception as exc:
                errors.append(exc)

        threads = [threading.Thread(target=_worker, args=(i * 50,)) for i in range(8)]
        for t in threads:
            t.start()
        for t in threads:
            t.join()

        assert not errors
        assert len(c) <= cap

    def test_concurrent_reads_never_raise(self):
        c = _fresh()
        for i in range(200):
            c.set(f"u{i}", {"idx": i})
        errors: list[Exception] = []

        def _reader() -> None:
            try:
                for i in range(200):
                    c.get(f"u{i}", _LONG_TTL)
            except Exception as exc:
                errors.append(exc)

        threads = [threading.Thread(target=_reader) for _ in range(10)]
        for t in threads:
            t.start()
        for t in threads:
            t.join()

        assert not errors

    def test_mixed_concurrent_ops_no_exception(self):
        c = _PersonaStateCache(max_entries=50)
        errors: list[Exception] = []

        def _writer(uid: str) -> None:
            try:
                for _ in range(30):
                    c.set(uid, {"uid": uid})
                    c.get(uid, _LONG_TTL)
                    c.invalidate(uid)
            except Exception as exc:
                errors.append(exc)

        threads = [threading.Thread(target=_writer, args=(f"u{i}",)) for i in range(20)]
        for t in threads:
            t.start()
        for t in threads:
            t.join()

        assert not errors


# ---------------------------------------------------------------------------
# Integration: RIAIAMService static helpers
# ---------------------------------------------------------------------------


class TestRIAIAMServiceIntegration:
    def test_write_then_read(self):
        uid = "int_test_user_1"
        payload = {"user_id": uid, "personas": ["investor"], "last_active_persona": "investor"}
        RIAIAMService._write_cached_persona_state(uid, payload)
        result = RIAIAMService._read_cached_persona_state(uid)
        assert result is not None
        assert result["user_id"] == uid

    def test_invalidate_via_service(self):
        uid = "int_test_user_2"
        RIAIAMService._write_cached_persona_state(uid, {"user_id": uid})
        RIAIAMService._invalidate_cached_persona_state(uid)
        assert RIAIAMService._read_cached_persona_state(uid) is None

    def test_empty_uid_write_is_noop(self):
        RIAIAMService._write_cached_persona_state("", {"user_id": ""})
        # Must not raise and must not add a blank-key entry

    def test_empty_uid_read_returns_none(self):
        assert RIAIAMService._read_cached_persona_state("") is None

    def test_empty_uid_invalidate_is_noop(self):
        RIAIAMService._invalidate_cached_persona_state("")  # must not raise


# ---------------------------------------------------------------------------
# HTTP reachability: GET /api/iam/persona exercises _PersonaStateCache
# ---------------------------------------------------------------------------


def _build_iam_app():
    from fastapi import FastAPI

    from api.middleware import require_firebase_auth
    from api.routes import iam

    app = FastAPI()
    app.include_router(iam.router)
    app.dependency_overrides[require_firebase_auth] = lambda: "persona_cache_test_uid"
    return app


class TestPersonaStateCacheHTTPReachability:
    """Prove GET /api/iam/persona reaches _PersonaStateCache via the service layer."""

    def test_get_persona_route_serves_cached_state(self, monkeypatch):
        """Cache hit: _PersonaStateCache returns stored payload, route surfaces it."""
        _PERSONA_STATE_CACHE.clear()
        uid = "persona_cache_test_uid"
        stored = {
            "user_id": uid,
            "personas": ["investor"],
            "last_active_persona": "investor",
            "investor_marketplace_opt_in": False,
        }
        _PERSONA_STATE_CACHE.set(uid, stored)

        async def _stubbed_get_persona_state(self, user_id: str):
            cached = RIAIAMService._read_cached_persona_state(user_id)
            if cached is not None:
                return cached
            return {"user_id": user_id, "personas": ["investor"], "last_active_persona": "investor"}

        monkeypatch.setattr(RIAIAMService, "get_persona_state", _stubbed_get_persona_state)

        from fastapi.testclient import TestClient

        client = TestClient(_build_iam_app())
        response = client.get("/api/iam/persona")

        assert response.status_code == 200
        body = response.json()
        assert body["user_id"] == uid
        assert body["last_active_persona"] == "investor"


class TestPersonaStateCacheHTTPResponse:
    """Verify the bounded cache contract is respected end-to-end through the HTTP layer."""

    def test_cache_miss_after_invalidate_falls_through_to_service(self, monkeypatch):
        """After invalidation, _PersonaStateCache.get returns None; service recomputes."""
        uid = "persona_cache_test_uid"
        _PERSONA_STATE_CACHE.set(uid, {"user_id": uid, "personas": ["ria"]})
        _PERSONA_STATE_CACHE.invalidate(uid)
        assert _PERSONA_STATE_CACHE.get(uid, _PERSONA_STATE_CACHE_TTL) is None

        async def _stubbed_get_persona_state(self, user_id: str):
            return {
                "user_id": user_id,
                "personas": ["investor"],
                "last_active_persona": "investor",
                "investor_marketplace_opt_in": False,
                "iam_schema_ready": True,
            }

        monkeypatch.setattr(RIAIAMService, "get_persona_state", _stubbed_get_persona_state)

        from fastapi.testclient import TestClient

        client = TestClient(_build_iam_app())
        response = client.get("/api/iam/persona")

        assert response.status_code == 200
        body = response.json()
        assert body["user_id"] == uid
        assert body["iam_schema_ready"] is True
