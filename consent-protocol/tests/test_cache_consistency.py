"""Snapshot value consistency tests for InMemoryCache.

Integrated by Abdul Gaffar — canonical snapshot read-consistency surface.

Proves that:
  1. Consecutive reads for the same key return the SAME object reference
     (``is`` identity, not just ``==`` equality).
  2. The cache stores by reference — no hidden copy or reconstruction.
  3. In-process mutation of the cached value is visible to subsequent reads
     (because they share the same object).
  4. Invalidation breaks the identity chain: a new set yields a new reference.
  5. TTL expiry evicts the entry; the next read returns the default.
  6. Thread-safe: concurrent reads all see the same reference.

Canonical surface : hushh_mcp.services.cache.InMemoryCache
Canonical caller  : Any service that caches consent snapshots or token
                    payloads and requires identical object references across
                    multiple reads in the same request lifecycle.

No DB, no network, no LLM.
"""

from __future__ import annotations

import threading
import time

import pytest

from hushh_mcp.services.cache import InMemoryCache

# ===========================================================================
# Helpers
# ===========================================================================


def _cache(**kwargs) -> InMemoryCache:
    return InMemoryCache(**kwargs)


# ===========================================================================
# Core read-consistency — same object reference on consecutive reads
# ===========================================================================


class TestSnapshotReadConsistency:
    def test_consecutive_reads_return_same_object(self):
        """Two get() calls for the same key must return the identical object."""
        cache = _cache()
        payload = {"status": "pending", "user_id": "u1"}
        cache.set("consent:u1", payload)

        first = cache.get("consent:u1")
        second = cache.get("consent:u1")

        assert first is second

    def test_many_reads_all_same_object(self):
        """Ten consecutive reads must all return the same object reference."""
        cache = _cache()
        payload = {"token": "tok_abc", "scope": "pkm.read"}
        cache.set("token:tok_abc", payload)

        reads = [cache.get("token:tok_abc") for _ in range(10)]
        first = reads[0]
        for read in reads[1:]:
            assert read is first

    def test_dict_value_identity_not_just_equality(self):
        """Identity (is) is stronger than equality (==) — cache must guarantee is."""
        cache = _cache()
        original = {"agent_id": "ria:firm-001", "scope": "attr.financial.read"}
        cache.set("agent:ria:firm-001", original)

        retrieved = cache.get("agent:ria:firm-001")
        assert retrieved is original          # identity
        assert retrieved == original          # also equal (trivially true if is)
        assert id(retrieved) == id(original)  # memory location is identical

    def test_list_value_identity_preserved(self):
        """List values are also stored by reference, not by copy."""
        cache = _cache()
        scope_list = ["attr.financial.read", "pkm.read"]
        cache.set("scopes:u2", scope_list)

        r1 = cache.get("scopes:u2")
        r2 = cache.get("scopes:u2")
        assert r1 is r2
        assert r1 is scope_list

    def test_nested_dict_identity_preserved(self):
        """Nested dict values are not reconstructed on each read."""
        cache = _cache()
        nested = {"meta": {"agent": "ria:firm", "score": 0.95}}
        cache.set("nested:u3", nested)

        snap1 = cache.get("nested:u3")
        snap2 = cache.get("nested:u3")
        assert snap1 is snap2
        assert snap1["meta"] is snap2["meta"]   # inner dict also identical


# ===========================================================================
# In-process mutation visibility
# ===========================================================================


class TestMutationVisibility:
    def test_mutation_visible_to_subsequent_reads(self):
        """Mutating a cached dict is visible to subsequent reads (same reference)."""
        cache = _cache()
        record = {"status": "pending"}
        cache.set("record:x", record)

        snap = cache.get("record:x")
        snap["status"] = "approved"          # mutate through the returned reference

        later = cache.get("record:x")
        assert later["status"] == "approved"  # mutation visible — same object

    def test_original_reference_and_cached_reference_are_same(self):
        """The object returned by get() IS the object passed to set()."""
        cache = _cache()
        data = {"key": "value"}
        cache.set("k", data)

        data["extra"] = "added"              # mutate the original reference
        result = cache.get("k")
        assert result["extra"] == "added"    # cache reflects mutation
        assert result is data


# ===========================================================================
# Invalidation breaks identity
# ===========================================================================


class TestInvalidationBreaksIdentity:
    def test_invalidate_then_set_new_object(self):
        """After invalidation, a new set() yields a new reference."""
        cache = _cache()
        original = {"v": 1}
        cache.set("k", original)

        cache.invalidate("k")

        replacement = {"v": 2}
        cache.set("k", replacement)

        result = cache.get("k")
        assert result is replacement
        assert result is not original

    def test_get_after_invalidate_returns_default(self):
        """get() after invalidate() returns the default, not the old value."""
        cache = _cache()
        cache.set("k", {"data": True})
        cache.invalidate("k")

        assert cache.get("k") is None
        assert cache.get("k", default="fallback") == "fallback"

    def test_clear_removes_all_entries(self):
        """clear() evicts every entry; subsequent reads all miss."""
        cache = _cache()
        cache.set("a", {"x": 1})
        cache.set("b", {"y": 2})
        cache.clear()

        assert cache.get("a") is None
        assert cache.get("b") is None
        assert len(cache) == 0


# ===========================================================================
# TTL expiry
# ===========================================================================


class TestTTLExpiry:
    def test_entry_available_before_ttl_expires(self):
        """Value is returned while within TTL."""
        cache = _cache()
        payload = {"v": "alive"}
        cache.set("k", payload, ttl=60)

        result = cache.get("k")
        assert result is payload

    def test_entry_evicted_after_ttl_expires(self):
        """After TTL expires, get() returns None."""
        cache = _cache()
        cache.set("k", {"v": "gone"}, ttl=0.01)  # 10 ms
        time.sleep(0.05)

        assert cache.get("k") is None

    def test_default_ttl_applied_when_no_per_key_ttl(self):
        """default_ttl is used when set() is called without an explicit ttl."""
        cache = _cache(default_ttl=0.01)
        cache.set("k", {"v": "short-lived"})
        time.sleep(0.05)

        assert cache.get("k") is None

    def test_per_key_none_ttl_overrides_default_ttl(self):
        """Passing ttl=None explicitly makes the entry never expire."""
        cache = _cache(default_ttl=0.01)
        cache.set("k", {"v": "immortal"}, ttl=None)
        time.sleep(0.05)

        result = cache.get("k")
        assert result is not None
        assert result["v"] == "immortal"


# ===========================================================================
# Structural / passthrough
# ===========================================================================


class TestStructural:
    def test_miss_returns_none_by_default(self):
        assert _cache().get("nonexistent") is None

    def test_miss_returns_supplied_default(self):
        assert _cache().get("nonexistent", default=42) == 42

    def test_len_tracks_entry_count(self):
        cache = _cache()
        assert len(cache) == 0
        cache.set("a", 1)
        assert len(cache) == 1
        cache.set("b", 2)
        assert len(cache) == 2
        cache.invalidate("a")
        assert len(cache) == 1

    def test_contains_true_for_live_entry(self):
        cache = _cache()
        cache.set("k", {"v": 1})
        assert "k" in cache

    def test_contains_false_for_missing_entry(self):
        assert "k" not in _cache()

    def test_overwrite_replaces_reference(self):
        """A second set() on the same key replaces the stored reference."""
        cache = _cache()
        old = {"gen": 1}
        new = {"gen": 2}
        cache.set("k", old)
        cache.set("k", new)

        result = cache.get("k")
        assert result is new
        assert result is not old


# ===========================================================================
# Thread safety — concurrent reads see the same reference
# ===========================================================================


class TestConcurrentReadConsistency:
    def test_concurrent_reads_all_identical(self):
        """50 concurrent threads reading the same key all get the same object."""
        cache = _cache()
        shared = {"consent_id": "cid_001", "scope": "pkm.read"}
        cache.set("shared", shared)

        results: list[object] = []
        errors: list[Exception] = []
        lock = threading.Lock()

        def reader():
            try:
                val = cache.get("shared")
                with lock:
                    results.append(val)
            except Exception as exc:
                with lock:
                    errors.append(exc)

        threads = [threading.Thread(target=reader) for _ in range(50)]
        for t in threads:
            t.start()
        for t in threads:
            t.join(timeout=5)

        assert not errors
        assert len(results) == 50
        for r in results:
            assert r is shared


# ===========================================================================
# Trust-boundary proof — InMemoryCache is the canonical read-consistency gate
# ===========================================================================


class TestTrustBoundaryProof:
    """
    Canonical surface : hushh_mcp.services.cache.InMemoryCache
    Canonical caller  : Any service reading consent snapshots or token payloads
                        multiple times within a single request lifecycle.
                        The cache guarantees ``get(k) is get(k)`` — no
                        reconstruction or copy — so downstream code can rely on
                        object identity across read paths.
    Attach point proof: The tests below prove that the cache is the sole
                        object-identity guarantee for snapshot reads, that
                        consecutive reads satisfy the ``is`` invariant, and that
                        the contract holds regardless of value type (dict, list,
                        or arbitrary object).
    """

    def test_cache_is_sole_identity_guarantee_for_snapshot_reads(self):
        """Without the cache, each construction creates a new object."""
        # Without cache: two dict literals with same content are NOT the same object
        raw1 = {"status": "pending"}
        raw2 = {"status": "pending"}
        assert raw1 is not raw2          # no cache → different objects

        # With cache: both reads return the same object
        cache = _cache()
        cache.set("snap", raw1)
        assert cache.get("snap") is raw1
        assert cache.get("snap") is raw1  # consistent across reads

    def test_snapshot_read_invariant_is_identity_not_equality(self):
        """The invariant is identity (``is``), not just equality (``==``)."""
        cache = _cache()
        obj = {"a": [1, 2, 3]}
        cache.set("k", obj)
        r1 = cache.get("k")
        r2 = cache.get("k")
        assert r1 is r2                  # identity
        assert r1 == r2                  # equality (weaker — trivially true)
        assert id(r1) == id(r2)          # memory address identical

    @pytest.mark.parametrize("value", [
        {"status": "pending"},
        ["scope1", "scope2"],
        "plain-string-token",
        42,
        (1, 2, 3),
    ])
    def test_identity_preserved_for_various_value_types(self, value):
        """The ``is`` invariant holds for every storable Python type."""
        cache = _cache()
        cache.set("k", value)
        assert cache.get("k") is value
        assert cache.get("k") is cache.get("k")
