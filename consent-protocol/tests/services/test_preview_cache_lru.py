"""Tests for _PREVIEW_CACHE LRU eviction and size bound.

The cache uses an OrderedDict so that:
  - Entries are evicted LRU-first once the cache exceeds _PREVIEW_CACHE_MAX_SIZE.
  - A cache hit moves the entry to the MRU position (prolonging its life).
  - Expired entries are still lazily removed on access.
"""

from __future__ import annotations

import pytest

import hushh_mcp.services.pkm_agent_lab_service as svc
from hushh_mcp.services.pkm_agent_lab_service import (
    _PREVIEW_CACHE,
    _PREVIEW_CACHE_MAX_SIZE,
    PKMAgentLabService,
)


@pytest.fixture(autouse=True)
def _clear_cache():
    """Ensure each test starts with an empty cache."""
    _PREVIEW_CACHE.clear()
    yield
    _PREVIEW_CACHE.clear()


# ---------------------------------------------------------------------------
# Basic get / set behaviour
# ---------------------------------------------------------------------------


def test_set_then_get_returns_payload():
    PKMAgentLabService._set_cached_structure_preview("k1", {"a": 1})
    result = PKMAgentLabService._get_cached_structure_preview("k1")
    assert result == {"a": 1}


def test_get_missing_key_returns_none():
    assert PKMAgentLabService._get_cached_structure_preview("missing") is None


def test_get_returns_deep_copy(monkeypatch):
    """Mutations to the returned dict must not corrupt the cached entry."""
    PKMAgentLabService._set_cached_structure_preview("k1", {"x": [1, 2]})
    copy = PKMAgentLabService._get_cached_structure_preview("k1")
    assert copy is not None
    copy["x"].append(99)
    fresh = PKMAgentLabService._get_cached_structure_preview("k1")
    assert fresh is not None
    assert fresh["x"] == [1, 2]


def test_expired_entry_returns_none(monkeypatch):
    """An entry whose TTL has elapsed must not be returned."""
    PKMAgentLabService._set_cached_structure_preview("k1", {"v": 1})
    # Wind the clock past the TTL
    monkeypatch.setattr(svc, "_PREVIEW_CACHE_TTL_SECONDS", -1)
    # Re-insert so the stored timestamp is in the past
    PKMAgentLabService._set_cached_structure_preview("k1", {"v": 1})
    assert PKMAgentLabService._get_cached_structure_preview("k1") is None


def test_expired_entry_is_removed_from_cache(monkeypatch):
    monkeypatch.setattr(svc, "_PREVIEW_CACHE_TTL_SECONDS", -1)
    PKMAgentLabService._set_cached_structure_preview("k1", {"v": 1})
    PKMAgentLabService._get_cached_structure_preview("k1")
    assert "k1" not in _PREVIEW_CACHE


# ---------------------------------------------------------------------------
# Size bound / LRU eviction
# ---------------------------------------------------------------------------


def test_cache_does_not_grow_beyond_max_size():
    for i in range(_PREVIEW_CACHE_MAX_SIZE + 10):
        PKMAgentLabService._set_cached_structure_preview(f"key_{i}", {"i": i})
    assert len(_PREVIEW_CACHE) <= _PREVIEW_CACHE_MAX_SIZE


def test_oldest_entry_evicted_first():
    """When the cache is full the LRU (oldest-inserted, un-accessed) entry is dropped."""
    max_size = _PREVIEW_CACHE_MAX_SIZE
    for i in range(max_size):
        PKMAgentLabService._set_cached_structure_preview(f"key_{i}", {"i": i})

    # All max_size entries are present
    assert "key_0" in _PREVIEW_CACHE

    # Insert one more — key_0 should be evicted (LRU)
    PKMAgentLabService._set_cached_structure_preview("key_overflow", {"i": -1})
    assert "key_overflow" in _PREVIEW_CACHE
    assert "key_0" not in _PREVIEW_CACHE


def test_cache_hit_protects_entry_from_lru_eviction():
    """A cache hit must move the entry to MRU position so it survives eviction."""
    max_size = _PREVIEW_CACHE_MAX_SIZE
    for i in range(max_size):
        PKMAgentLabService._set_cached_structure_preview(f"key_{i}", {"i": i})

    # Touch key_0 to make it the most-recently-used
    PKMAgentLabService._get_cached_structure_preview("key_0")

    # Fill two more entries — key_1 (now LRU) should be evicted, not key_0
    PKMAgentLabService._set_cached_structure_preview("overflow_a", {"x": 1})
    PKMAgentLabService._set_cached_structure_preview("overflow_b", {"x": 2})

    assert "key_0" in _PREVIEW_CACHE
    assert "key_1" not in _PREVIEW_CACHE


def test_overwrite_existing_key_does_not_grow_cache():
    """Re-inserting a key that already exists must not add a duplicate."""
    PKMAgentLabService._set_cached_structure_preview("k1", {"v": 1})
    PKMAgentLabService._set_cached_structure_preview("k1", {"v": 2})
    assert len(_PREVIEW_CACHE) == 1
    assert PKMAgentLabService._get_cached_structure_preview("k1") == {"v": 2}


def test_single_entry_cache_evicts_on_overflow(monkeypatch):
    """Edge case: max_size=1 — inserting a second key evicts the first."""
    monkeypatch.setattr(svc, "_PREVIEW_CACHE_MAX_SIZE", 1)
    PKMAgentLabService._set_cached_structure_preview("first", {"a": 1})
    PKMAgentLabService._set_cached_structure_preview("second", {"b": 2})
    assert len(_PREVIEW_CACHE) == 1
    assert "second" in _PREVIEW_CACHE
    assert "first" not in _PREVIEW_CACHE
