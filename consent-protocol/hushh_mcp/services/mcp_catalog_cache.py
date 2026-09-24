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

    def put(self, token: str | None, catalog: list[dict[str, Any]]) -> None:
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
