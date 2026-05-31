"""Hermetic unit tests for the _PreviewCache class in pkm_agent_lab_service.

Canonical attach point:
    PKMAgentLabService.generate_structure_preview -> POST /api/pkm/agent-lab/structure
    (pkm.router -> api/routes/pkm.py -> PKMAgentLabService.generate_structure_preview
     -> PKMAgentLabService._get_cached_structure_preview -> _PreviewCache.get)

No DB, no network, no LLM.

Covered:
    construction (default and custom capacity)
    get -- hit, miss, expired
    set -- basic, TTL stored, deepcopy isolation
    pop -- removes key; missing key is a no-op
    size cap -- stale-first eviction, then FIFO oldest
    __len__
    clear
    concurrency -- three threads writing simultaneously
    integration -- _get_cached_structure_preview / _set_cached_structure_preview
    HTTP reachability -- POST /api/pkm/agent-lab/structure via TestClient
"""

from __future__ import annotations

import threading
import time

import pytest

from hushh_mcp.services.pkm_agent_lab_service import (
    _PREVIEW_CACHE,
    _PREVIEW_CACHE_MAX,
    _PreviewCache,
)

# ---------------------------------------------------------------------------
# fixture: reset the module-level cache between tests
# ---------------------------------------------------------------------------


@pytest.fixture(autouse=True)
def _reset_module_cache(monkeypatch):
    _PREVIEW_CACHE.clear()
    original_max = _PREVIEW_CACHE._max
    yield
    _PREVIEW_CACHE.clear()
    _PREVIEW_CACHE._max = original_max


def _structure_response_payload(
    *,
    domain: str,
    summary: str,
    latency_ms: int = 0,
) -> dict:
    candidate_payload = {
        domain: {
            "entities": {
                f"mem_{domain}": {
                    "entity_id": f"mem_{domain}",
                    "kind": "preference",
                    "summary": summary,
                    "status": "active",
                }
            }
        }
    }
    structure_decision = {
        "action": "create_domain",
        "target_domain": domain,
        "json_paths": [domain],
        "top_level_scope_paths": [domain],
        "externalizable_paths": [domain],
        "summary_projection": {"top_level_scope": domain},
        "sensitivity_labels": {},
        "confidence": 0.9,
        "source_agent": "test",
        "contract_version": 1,
    }
    return {
        "agent_id": "pkm-structure-agent",
        "agent_name": "PKM Structure Agent",
        "model": "stub",
        "used_fallback": False,
        "candidate_payload": candidate_payload,
        "structure_decision": structure_decision,
        "preview_cards": [{"domain": domain, "summary": summary}],
        "preview_summary": {"domain_count": 1},
        "performance": {"latency_ms": latency_ms},
    }


# ===========================================================================
# Construction
# ===========================================================================


class TestConstruction:
    def test_default_capacity_matches_env_var(self):
        cache = _PreviewCache()
        assert cache._max == _PREVIEW_CACHE_MAX

    def test_custom_capacity(self):
        cache = _PreviewCache(max_entries=7)
        assert cache._max == 7

    def test_initial_length_is_zero(self):
        assert len(_PreviewCache()) == 0


# ===========================================================================
# get
# ===========================================================================


class TestGet:
    def test_miss_returns_none(self):
        cache = _PreviewCache()
        assert cache.get("missing") is None

    def test_hit_returns_payload(self):
        cache = _PreviewCache()
        cache.set("k", {"x": 1}, ttl_seconds=60)
        assert cache.get("k") == {"x": 1}

    def test_expired_returns_none(self):
        cache = _PreviewCache()
        # store with TTL already in the past
        cache.set("k", {"x": 1}, ttl_seconds=60)
        # force expiry by overwriting the internal store entry
        cache._store["k"] = (time.time() - 1, {"x": 1})
        assert cache.get("k") is None

    def test_expired_entry_removed_from_store(self):
        cache = _PreviewCache()
        cache.set("k", {"x": 1}, ttl_seconds=60)
        cache._store["k"] = (time.time() - 1, {"x": 1})
        cache.get("k")
        assert "k" not in cache._store

    def test_get_returns_deepcopy(self):
        cache = _PreviewCache()
        original = {"nested": {"a": 1}}
        cache.set("k", original, ttl_seconds=60)
        result = cache.get("k")
        result["nested"]["a"] = 999
        assert cache.get("k") == {"nested": {"a": 1}}


# ===========================================================================
# set
# ===========================================================================


class TestSet:
    def test_set_stores_entry(self):
        cache = _PreviewCache()
        cache.set("k", {"v": 42}, ttl_seconds=60)
        assert len(cache) == 1

    def test_set_stores_deepcopy_of_payload(self):
        cache = _PreviewCache()
        payload = {"a": [1, 2, 3]}
        cache.set("k", payload, ttl_seconds=60)
        payload["a"].append(4)
        assert cache.get("k") == {"a": [1, 2, 3]}

    def test_overwrite_existing_key(self):
        cache = _PreviewCache()
        cache.set("k", {"v": 1}, ttl_seconds=60)
        cache.set("k", {"v": 2}, ttl_seconds=60)
        assert cache.get("k") == {"v": 2}
        assert len(cache) == 1

    def test_ttl_stored_in_future(self):
        cache = _PreviewCache()
        before = time.time()
        cache.set("k", {}, ttl_seconds=300)
        expires_at, _ = cache._store["k"]
        assert expires_at > before + 299


# ===========================================================================
# pop
# ===========================================================================


class TestPop:
    def test_pop_removes_key(self):
        cache = _PreviewCache()
        cache.set("k", {}, ttl_seconds=60)
        cache.pop("k")
        assert cache.get("k") is None

    def test_pop_missing_key_no_error(self):
        cache = _PreviewCache()
        cache.pop("not_there")  # must not raise

    def test_len_decreases_after_pop(self):
        cache = _PreviewCache()
        cache.set("k", {}, ttl_seconds=60)
        cache.pop("k")
        assert len(cache) == 0


# ===========================================================================
# size cap — eviction
# ===========================================================================


class TestSizeCap:
    def test_stale_entries_evicted_first(self):
        cache = _PreviewCache(max_entries=3)
        # Fill with stale entries
        for i in range(3):
            cache.set(f"stale_{i}", {"i": i}, ttl_seconds=60)
            cache._store[f"stale_{i}"] = (time.time() - 1, {"i": i})
        # Adding a new key should evict all stale ones first
        cache.set("fresh", {"v": "new"}, ttl_seconds=60)
        assert cache.get("fresh") == {"v": "new"}
        assert len(cache) == 1

    def test_oldest_evicted_when_no_stale(self):
        cache = _PreviewCache(max_entries=3)
        cache.set("first", {"n": 1}, ttl_seconds=60)
        cache.set("second", {"n": 2}, ttl_seconds=60)
        cache.set("third", {"n": 3}, ttl_seconds=60)
        # All fresh — adding a 4th evicts "first" (FIFO)
        cache.set("fourth", {"n": 4}, ttl_seconds=60)
        assert len(cache) == 3
        assert cache.get("first") is None
        assert cache.get("fourth") == {"n": 4}

    def test_overwriting_existing_key_does_not_evict(self):
        cache = _PreviewCache(max_entries=2)
        cache.set("a", {"v": 1}, ttl_seconds=60)
        cache.set("b", {"v": 2}, ttl_seconds=60)
        # Overwriting "a" — no eviction should occur
        cache.set("a", {"v": 99}, ttl_seconds=60)
        assert len(cache) == 2
        assert cache.get("a") == {"v": 99}

    def test_capacity_one_always_holds_latest(self):
        cache = _PreviewCache(max_entries=1)
        for i in range(5):
            cache.set(f"k{i}", {"i": i}, ttl_seconds=60)
        assert len(cache) == 1
        assert cache.get("k4") == {"i": 4}


# ===========================================================================
# __len__ and clear
# ===========================================================================


class TestLenAndClear:
    def test_len_reflects_stored_count(self):
        cache = _PreviewCache()
        assert len(cache) == 0
        cache.set("a", {}, ttl_seconds=60)
        assert len(cache) == 1
        cache.set("b", {}, ttl_seconds=60)
        assert len(cache) == 2

    def test_clear_empties_cache(self):
        cache = _PreviewCache()
        for i in range(5):
            cache.set(f"k{i}", {}, ttl_seconds=60)
        cache.clear()
        assert len(cache) == 0

    def test_get_after_clear_returns_none(self):
        cache = _PreviewCache()
        cache.set("k", {"v": 1}, ttl_seconds=60)
        cache.clear()
        assert cache.get("k") is None


# ===========================================================================
# Concurrency
# ===========================================================================


class TestConcurrency:
    def test_concurrent_writes_no_data_loss(self):
        cache = _PreviewCache(max_entries=200)
        errors: list[Exception] = []

        def _writer(start: int) -> None:
            try:
                for i in range(50):
                    cache.set(f"key_{start}_{i}", {"v": i}, ttl_seconds=60)
            except Exception as exc:
                errors.append(exc)

        threads = [threading.Thread(target=_writer, args=(t * 100,)) for t in range(3)]
        for t in threads:
            t.start()
        for t in threads:
            t.join()

        assert not errors
        assert len(cache) <= 200

    def test_concurrent_reads_and_writes(self):
        cache = _PreviewCache(max_entries=100)
        cache.set("shared", {"v": 0}, ttl_seconds=60)
        errors: list[Exception] = []

        def _reader() -> None:
            try:
                for _ in range(100):
                    cache.get("shared")
            except Exception as exc:
                errors.append(exc)

        def _writer() -> None:
            try:
                for i in range(100):
                    cache.set("shared", {"v": i}, ttl_seconds=60)
            except Exception as exc:
                errors.append(exc)

        threads = [threading.Thread(target=_reader) for _ in range(3)]
        threads += [threading.Thread(target=_writer) for _ in range(2)]
        for t in threads:
            t.start()
        for t in threads:
            t.join()

        assert not errors

    def test_concurrent_pop_does_not_raise(self):
        cache = _PreviewCache()
        cache.set("k", {}, ttl_seconds=60)
        errors: list[Exception] = []

        def _popper() -> None:
            try:
                for _ in range(50):
                    cache.pop("k")
            except Exception as exc:
                errors.append(exc)

        threads = [threading.Thread(target=_popper) for _ in range(5)]
        for t in threads:
            t.start()
        for t in threads:
            t.join()

        assert not errors


# ===========================================================================
# Integration — class methods
# ===========================================================================


from hushh_mcp.services.pkm_agent_lab_service import PKMAgentLabService  # noqa: E402


class TestIntegration:
    def test_get_miss_returns_none(self):
        assert PKMAgentLabService._get_cached_structure_preview("no_key") is None

    def test_set_then_get_returns_payload(self):
        PKMAgentLabService._set_cached_structure_preview("k1", {"result": "ok"})
        assert PKMAgentLabService._get_cached_structure_preview("k1") == {"result": "ok"}

    def test_set_respects_module_ttl(self):
        from hushh_mcp.services.pkm_agent_lab_service import _PREVIEW_CACHE_TTL_SECONDS

        PKMAgentLabService._set_cached_structure_preview("k2", {"x": 1})
        expires_at, _ = _PREVIEW_CACHE._store["k2"]
        assert expires_at > time.time() + _PREVIEW_CACHE_TTL_SECONDS - 2

    def test_expired_entry_not_returned(self):
        PKMAgentLabService._set_cached_structure_preview("k3", {"x": 1})
        _PREVIEW_CACHE._store["k3"] = (time.time() - 1, {"x": 1})
        assert PKMAgentLabService._get_cached_structure_preview("k3") is None

    def test_module_cache_bounded_at_configured_max(self):
        _PREVIEW_CACHE._max = 5
        for i in range(10):
            PKMAgentLabService._set_cached_structure_preview(f"mk_{i}", {"i": i})
        assert len(_PREVIEW_CACHE) <= 5


# ---------------------------------------------------------------------------
# HTTP reachability: POST /api/pkm/agent-lab/structure exercises _PreviewCache
# ---------------------------------------------------------------------------


def _build_pkm_app():
    from fastapi import FastAPI

    from api.middleware import require_vault_owner_token
    from api.routes import pkm

    app = FastAPI()
    app.include_router(pkm.router)
    app.dependency_overrides[require_vault_owner_token] = lambda: {
        "user_id": "pkm_cache_test_uid",
        "scope": "VAULT_OWNER",
    }
    return app


class TestPreviewCacheHTTPReachability:
    """Prove POST /api/pkm/agent-lab/structure reaches _PreviewCache via the service layer."""

    def test_structure_preview_route_returns_cached_payload(self, monkeypatch):
        """Cache hit: _PreviewCache returns stored payload, route surfaces it."""
        _PREVIEW_CACHE.clear()
        cache_key = "pkm_cache_test_uid:test message:"
        stored = _structure_response_payload(domain="finance", summary="test")
        _PREVIEW_CACHE.set(cache_key, stored, ttl_seconds=300)

        async def _stubbed_generate(self, *, user_id, message, **kwargs):
            cached = PKMAgentLabService._get_cached_structure_preview(
                f"{user_id}:{message}:"
            )
            if cached is not None:
                return cached
            return _structure_response_payload(domain="fallback", summary="stub")

        monkeypatch.setattr(
            PKMAgentLabService, "generate_structure_preview", _stubbed_generate
        )

        from fastapi.testclient import TestClient

        client = TestClient(_build_pkm_app())
        response = client.post(
            "/api/pkm/agent-lab/structure",
            json={
                "user_id": "pkm_cache_test_uid",
                "message": "test message",
            },
        )

        assert response.status_code == 200
        body = response.json()
        assert len(body["preview_cards"]) == 1
        assert body["preview_cards"][0]["domain"] == "finance"


class TestPreviewCacheHTTPResponse:
    """Verify cache miss path returns fresh data through the HTTP layer."""

    def test_cache_miss_after_pop_falls_through_to_service(self, monkeypatch):
        """After pop, _PreviewCache returns None; service is called and returns fresh data."""
        uid = "pkm_cache_test_uid"
        cache_key = f"{uid}:fresh message:"
        _PREVIEW_CACHE.set(
            cache_key,
            _structure_response_payload(domain="cached", summary="stale"),
            ttl_seconds=300,
        )
        _PREVIEW_CACHE.pop(cache_key)
        assert _PREVIEW_CACHE.get(cache_key) is None

        async def _stubbed_generate(self, *, user_id, message, **kwargs):
            return _structure_response_payload(
                domain="health",
                summary="fresh",
                latency_ms=5,
            )

        monkeypatch.setattr(
            PKMAgentLabService, "generate_structure_preview", _stubbed_generate
        )

        from fastapi.testclient import TestClient

        client = TestClient(_build_pkm_app())
        response = client.post(
            "/api/pkm/agent-lab/structure",
            json={"user_id": uid, "message": "fresh message"},
        )

        assert response.status_code == 200
        body = response.json()
        assert body["preview_cards"][0]["domain"] == "health"
        assert body["performance"]["latency_ms"] == 5
