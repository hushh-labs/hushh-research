"""Bounded owner-prefix cleanup. Never delete the shared bucket or another owner.

The SQL fence blocks new writes before provider cleanup. Retained versions and
uncertain writes remain outstanding; a no-op rollback is never recovery.
"""

from __future__ import annotations

import json
from typing import Any

from hushh_mcp.services.pod_commit_log import GcsObjectStore
from hushh_mcp.services.pod_files.contracts import FilesRefused

from . import registry
from .erasure_objects import erase_objects


async def erase(owner: str) -> dict[str, Any] | None:
    from .reconciliation import reconcile  # noqa: PLC0415

    observed = await registry.resource(owner)
    if observed:
        await reconcile(observed)
    row = await registry.fence(owner)
    if row is None:
        return None
    if row["state"] == "erased":
        receipt = row["receipt"]
        return json.loads(receipt) if isinstance(receipt, str) else receipt
    if row["user_id"] != owner or row["prefix"] != registry.owner_prefix(owner):
        raise FilesRefused("FILES_ERASURE_INVENTORY_INVALID", 409)
    prefix = row["prefix"] + "/" + str(row["library_id"]) + "/"
    if not prefix.startswith("shared-files/v1/") or ".." in prefix:
        raise FilesRefused("FILES_ERASURE_INVENTORY_INVALID", 409)
    store = GcsObjectStore(row["bucket"])

    await erase_objects(store, row["bucket"], prefix)
    receipt = {
        "version": 1,
        "libraryId": str(row["library_id"]),
        "bucket": row["bucket"],
        "prefix": prefix,
        "complete": True,
        "writesFenced": True,
        "activeAndRetainedObjectsAbsent": True,
    }
    await registry.erased(owner, str(row["library_id"]), receipt)
    return receipt
