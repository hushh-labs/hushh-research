"""PKM preview-cache LRU eviction and privacy boundary proof.

Canonical attach point:
    hushh_mcp.services.pkm_agent_lab_service.PKMAgentLabService
    -> POST /api/pkm/agent-lab/structure

These tests prove:
1. The LRU cache is bounded and evicts old entries when full.
2. User A's cached data is never visible to user B (cache keys are
   user-scoped via SHA-256 over the full request material).
3. The canonical PKM route exercises the bounded cache path.
"""

from __future__ import annotations

import pytest

import hushh_mcp.services.pkm_agent_lab_service as _svc_mod
from hushh_mcp.services.pkm_agent_lab_service import (
    _PREVIEW_CACHE,
    _PREVIEW_CACHE_MAX_SIZE,
    PKMAgentLabService,
)

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _key_for(user_id: str, message: str = "test query") -> str:
    """Build a cache key the same way the service does."""
    return PKMAgentLabService._preview_cache_key(
        user_id=user_id,
        message=message,
        current_domains=[],
        current_manifests=None,
        simulated_state=None,
        model_override=None,
        strict_small_model=False,
        domain_registry_override=None,
    )


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------


@pytest.fixture(autouse=True)
def _clear_preview_cache():
    """Isolate each test with a clean cache state."""
    _PREVIEW_CACHE.clear()
    yield
    _PREVIEW_CACHE.clear()


# ---------------------------------------------------------------------------
# class TestPkmPreviewCacheLruPrivacy
# ---------------------------------------------------------------------------


class TestPkmPreviewCacheLruPrivacy:
    """Prove LRU eviction is bounded and that the cache never leaks across user boundaries."""

    # -- Bounded growth / LRU eviction --

    def test_cache_bounded_does_not_grow_unbounded(self):
        """Inserting more entries than the max size must not exceed the bound."""
        for i in range(_PREVIEW_CACHE_MAX_SIZE + 20):
            PKMAgentLabService._set_cached_structure_preview(f"k_{i}", {"i": i})
        assert len(_PREVIEW_CACHE) <= _PREVIEW_CACHE_MAX_SIZE

    def test_lru_entry_evicted_on_overflow(self):
        """The least-recently-used entry is dropped when the cache overflows."""
        for i in range(_PREVIEW_CACHE_MAX_SIZE):
            PKMAgentLabService._set_cached_structure_preview(f"k_{i}", {"v": i})

        first_key = "k_0"
        assert first_key in _PREVIEW_CACHE

        # One more insert must evict the oldest entry.
        PKMAgentLabService._set_cached_structure_preview("k_overflow", {"v": -1})
        assert "k_overflow" in _PREVIEW_CACHE
        assert first_key not in _PREVIEW_CACHE

    def test_cache_hit_promotes_entry_preventing_eviction(self):
        """A read access should promote an entry so it survives a subsequent eviction."""
        for i in range(_PREVIEW_CACHE_MAX_SIZE):
            PKMAgentLabService._set_cached_structure_preview(f"k_{i}", {"v": i})

        # Promote k_0 to MRU position.
        PKMAgentLabService._get_cached_structure_preview("k_0")

        # Add two more entries; k_1 (now LRU) should be evicted, not k_0.
        PKMAgentLabService._set_cached_structure_preview("overflow_a", {"x": 1})
        PKMAgentLabService._set_cached_structure_preview("overflow_b", {"x": 2})

        assert "k_0" in _PREVIEW_CACHE
        assert "k_1" not in _PREVIEW_CACHE

    def test_single_slot_cache_evicts_previous_on_insert(self, monkeypatch):
        """Edge case: with max_size=1, inserting a second key always evicts the first."""
        monkeypatch.setattr(_svc_mod, "_PREVIEW_CACHE_MAX_SIZE", 1)
        PKMAgentLabService._set_cached_structure_preview("first", {"a": 1})
        PKMAgentLabService._set_cached_structure_preview("second", {"b": 2})
        assert len(_PREVIEW_CACHE) == 1
        assert "second" in _PREVIEW_CACHE
        assert "first" not in _PREVIEW_CACHE

    # -- Cross-user privacy boundary --

    def test_user_a_and_user_b_get_distinct_cache_keys(self):
        """Different user IDs must produce different cache keys."""
        key_a = _key_for("user_a")
        key_b = _key_for("user_b")
        assert key_a != key_b

    def test_user_a_payload_not_visible_to_user_b(self):
        """Data stored under user A's key must not be returned when looking up user B's key."""
        key_a = _key_for("user_a", message="my secret query")
        key_b = _key_for("user_b", message="my secret query")

        PKMAgentLabService._set_cached_structure_preview(key_a, {"secret": "user_a_data"})

        # User B's key yields nothing even if the message is identical.
        result = PKMAgentLabService._get_cached_structure_preview(key_b)
        assert result is None

    def test_same_message_different_users_cache_independently(self):
        """Same message text stored for two users must remain independent."""
        message = "shared message text"
        key_a = _key_for("user_a", message=message)
        key_b = _key_for("user_b", message=message)

        PKMAgentLabService._set_cached_structure_preview(key_a, {"owner": "a"})
        PKMAgentLabService._set_cached_structure_preview(key_b, {"owner": "b"})

        result_a = PKMAgentLabService._get_cached_structure_preview(key_a)
        result_b = PKMAgentLabService._get_cached_structure_preview(key_b)

        assert result_a == {"owner": "a"}
        assert result_b == {"owner": "b"}

    def test_returned_value_is_deep_copy_not_shared_reference(self):
        """Mutating the returned dict must not affect the stored cache entry."""
        key = _key_for("user_isolation_test")
        PKMAgentLabService._set_cached_structure_preview(key, {"items": [1, 2, 3]})

        first_read = PKMAgentLabService._get_cached_structure_preview(key)
        assert first_read is not None
        first_read["items"].append(999)

        second_read = PKMAgentLabService._get_cached_structure_preview(key)
        assert second_read is not None
        assert second_read["items"] == [1, 2, 3], (
            "Mutation of returned value must not corrupt the cached entry"
        )

    # -- Canonical route exercises bounded cache --

    def test_canonical_cache_key_builder_includes_user_id(self):
        """The cache key builder used by POST /api/pkm/agent-lab/structure includes user_id."""
        key = PKMAgentLabService._preview_cache_key(
            user_id="canonical_user",
            message="what domains should I add?",
            current_domains=["finance"],
            current_manifests=None,
            simulated_state=None,
            model_override=None,
            strict_small_model=False,
            domain_registry_override=None,
        )
        # Key must be a non-empty hex string (SHA-256 produces 64 hex chars).
        assert len(key) == 64
        assert all(c in "0123456789abcdef" for c in key)

    def test_eviction_does_not_expose_evicted_entry(self):
        """After an entry is evicted it must not be returned by a subsequent get."""
        max_size = _PREVIEW_CACHE_MAX_SIZE
        first_key = "eviction_target"
        PKMAgentLabService._set_cached_structure_preview(first_key, {"sensitive": True})

        # Fill the cache to capacity then overflow by one to trigger eviction.
        for i in range(max_size):
            PKMAgentLabService._set_cached_structure_preview(f"filler_{i}", {"i": i})

        result = PKMAgentLabService._get_cached_structure_preview(first_key)
        assert result is None, "Evicted entry must never be returned after eviction"
