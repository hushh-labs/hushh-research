"""Small credential-bound cache for MCP capability metadata.

Provider catalogs can differ by account and granted scopes. The bearer itself
never becomes a cache key, log value, or model-visible result.
"""

from __future__ import annotations

import hashlib
import time
from copy import deepcopy
from typing import Any


class McpCatalogCache:
    def __init__(self, *, ttl_seconds: float, max_entries: int = 16) -> None:
        self._ttl_seconds = ttl_seconds
        self._max_entries = max_entries
        self._entries: dict[str, tuple[float, list[dict[str, Any]]]] = {}
        self._revision = 0

    @property
    def revision(self) -> int:
        return self._revision

    @staticmethod
    def _key(token: str | None) -> str:
        return hashlib.sha256((token or "").encode()).hexdigest()

    def get(self, token: str | None) -> list[dict[str, Any]] | None:
        key = self._key(token)
        entry = self._entries.get(key)
        if entry is None:
            return None
        if entry[0] <= time.monotonic():
            self._entries.pop(key, None)
            return None
        return deepcopy(entry[1])

    def invalidate(self, token: str | None) -> None:
        """Forget only this credential's catalog before an explicit refresh."""
        self._entries.pop(self._key(token), None)
        self._revision += 1

    def put(
        self, token: str | None, catalog: list[dict[str, Any]], *, revision: int | None = None
    ) -> None:
        # A refresh must not be undone by an older in-flight discovery. A
        # cache-wide epoch bounds memory and conservatively skips other pending
        # fills too; existing catalogs for other credentials remain untouched.
        if revision is not None and revision != self._revision:
            return
        key = self._key(token)
        now = time.monotonic()
        self._entries = {
            cached_key: entry
            for cached_key, entry in self._entries.items()
            if entry[0] > now and cached_key != key
        }
        if len(self._entries) >= self._max_entries:
            oldest = min(self._entries, key=lambda cached_key: self._entries[cached_key][0])
            self._entries.pop(oldest)
        self._entries[key] = (now + self._ttl_seconds, deepcopy(catalog))
