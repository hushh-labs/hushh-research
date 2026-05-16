"""In-memory snapshot cache with strict read consistency.

Canonical surface: hushh_mcp.services.cache
Canonical caller : Any service that reads a logical entity (consent record,
                   token payload, agent context) multiple times within a single
                   request lifecycle and must guarantee that each read returns
                   the SAME object reference — not a freshly constructed copy.

Design
------
``InMemoryCache`` stores values keyed by a string cache key.  A ``get`` that
hits an existing entry always returns the *same Python object* that was
originally stored via ``set``.  The cache never reconstructs or copies the
stored value — so callers can rely on ``is`` identity, not just ``==``
equality, across consecutive reads.

This matters for consent snapshots: if two code paths read the same pending
request entry, they must see an identical reference so that any in-process
mutation (e.g., marking a field as processed) is visible to both paths
without a round-trip to the database.

Thread-safety: a single ``threading.RLock`` guards all mutations.  Reads are
lock-protected to prevent torn reads during a concurrent ``invalidate``.

Integrated by Abdul Gaffar — canonical snapshot read-consistency surface.
"""

from __future__ import annotations

import threading
import time
from typing import Any

# Sentinel for detecting "no ttl argument supplied" in InMemoryCache.set().
_UNSET: object = object()


class InMemoryCache:
    """Thread-safe in-memory cache that guarantees snapshot value identity.

    Consecutive ``get`` calls for the same key return the exact same object
    (verified by ``is``), never a reconstructed copy.  Values are evicted only
    via explicit ``invalidate`` / ``clear`` calls or when a TTL (seconds)
    expires.

    Usage::

        cache = InMemoryCache(default_ttl=300)
        cache.set("consent:user123", {"status": "pending"})

        snap1 = cache.get("consent:user123")
        snap2 = cache.get("consent:user123")
        assert snap1 is snap2   # same object — no copy made
    """

    def __init__(self, default_ttl: float | None = None) -> None:
        # Maps key → (stored_value, monotonic_expiry_or_None)
        self._store: dict[str, tuple[Any, float | None]] = {}
        self._lock = threading.RLock()
        self._default_ttl = default_ttl

    # ------------------------------------------------------------------
    # Public API
    # ------------------------------------------------------------------

    def set(self, key: str, value: Any, ttl: Any = _UNSET) -> None:
        """Store ``value`` under ``key``.

        Parameters
        ----------
        key   : Cache key string.
        value : Any Python object.  Stored by reference — no copy is made.
        ttl   : Seconds until expiry.  ``None`` means no expiry.
                Omit to fall back to the ``default_ttl`` given at construction.
        """
        effective_ttl: float | None = self._default_ttl if ttl is _UNSET else ttl
        expires_at = (
            time.monotonic() + effective_ttl if effective_ttl is not None else None
        )
        with self._lock:
            self._store[key] = (value, expires_at)

    def get(self, key: str, default: Any = None) -> Any:
        """Return the stored value for ``key``, or ``default`` on miss/expiry.

        The returned object is the exact reference stored by ``set`` — no copy
        is ever made, so consecutive calls for the same unexpired key satisfy
        ``get(k) is get(k)``.
        """
        with self._lock:
            entry = self._store.get(key)
            if entry is None:
                return default
            value, expires_at = entry
            if expires_at is not None and time.monotonic() >= expires_at:
                del self._store[key]
                return default
            return value

    def invalidate(self, key: str) -> None:
        """Remove ``key`` from the cache (no-op if absent)."""
        with self._lock:
            self._store.pop(key, None)

    def clear(self) -> None:
        """Evict all entries."""
        with self._lock:
            self._store.clear()

    def __len__(self) -> int:
        with self._lock:
            return len(self._store)

    def __contains__(self, key: str) -> bool:
        return self.get(key) is not None
