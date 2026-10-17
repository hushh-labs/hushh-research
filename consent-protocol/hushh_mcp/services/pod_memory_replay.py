"""Bounded sealed replay cache for request-local private-agent memory services."""

from __future__ import annotations

import asyncio
import json
from dataclasses import asdict
from typing import Any

from hushh_mcp.services.pod_commit_log import GcsObjectStore, LocalObjectStore, PodLogTampered

MAX_RECORDS = 10_000
MAX_BYTES = 8 * 1024 * 1024
_KIND = "pod.memory.replay.v1"


def _location(log: Any) -> dict[str, Any] | None:
    from hushh_mcp.services.pod_azure_blob_store import AzureBlobObjectStore

    store = log._store
    if isinstance(store, GcsObjectStore):
        return {"provider": "gcs", "bucket": store._bucket, "prefix": store._prefix}
    if isinstance(store, LocalObjectStore):
        return {"provider": "local", "root": str(store._root.resolve())}
    if isinstance(store, AzureBlobObjectStore):
        return {"provider": "azure", **asdict(store._location)}
    return None


class _BudgetExceeded(Exception):
    pass


class PodMemoryReplay:
    """One owner/incarnation cache; fresh custody and verified tails on every use.

    Mutable memory services and their provider diagnostics remain request-local.
    Every original memory record is retained, including tombstones and consent.
    Exceeding the optimization budget falls back to full replay, never truncation.
    """

    def __init__(self, *, owner: str, incarnation: int) -> None:
        self.owner, self.incarnation = owner, incarnation
        self._sealed: bytes | None = None
        self._cursor = None
        self._uncached = False
        self._lock = asyncio.Lock()

    async def replay(self, log: Any) -> list[dict[str, Any]]:
        from hushh_mcp.services.pod_memory_service import MEMORY_RECORD_KINDS

        if log._owner_id != self.owner:
            raise PodLogTampered("memory projection owner mismatch")
        location = _location(log)
        async with self._lock:
            if self._uncached or location is None:
                return await log.replay()
            binding = {
                "kind": _KIND,
                "owner": self.owner,
                "incarnation": self.incarnation,
                "location": location,
            }
            records = []
            if self._sealed is not None:
                cached = log._unseal(self._sealed)  # this request's freshly resolved key
                if any(cached.get(k) != v for k, v in binding.items()):
                    raise PodLogTampered("memory projection binding mismatch")
                records = cached["records"]
            size = len(json.dumps(records, ensure_ascii=False).encode("utf-8"))
            tail: list[dict[str, Any]] = []

            def visit(record: dict[str, Any]) -> None:
                nonlocal size
                if record.get("kind") not in MEMORY_RECORD_KINDS:
                    return
                size += len(json.dumps(record, ensure_ascii=False).encode("utf-8")) + 2
                if len(records) + len(tail) >= MAX_RECORDS or size > MAX_BYTES:
                    raise _BudgetExceeded
                tail.append(record)

            try:
                cursor = await log.fold_since(self._cursor, visit)
            except _BudgetExceeded:
                complete = await log.replay()
                self._uncached, self._sealed, self._cursor = True, None, None
                return complete
            # No cache/cursor mutation before verified ancestry and final erasure.
            records.extend(reversed(tail))
            sealed = log._seal({**binding, "records": records})
            if len(sealed) > MAX_BYTES:
                self._uncached, self._sealed, self._cursor = True, None, None
                return records
            self._sealed = sealed
            self._cursor = cursor
            return records
