"""Reconcile bounded opaque write receipts after a lost provider response."""

from __future__ import annotations

import hashlib
import json
import re
from typing import Any

from hushh_mcp.services.pod_commit_log import GcsObjectStore

from . import bucket_admission, registry
from .uploads import SharedCipherStore


async def reconcile(row: dict[str, Any], *, maximum: int = 4) -> None:
    writes = row["writes"]
    writes = json.loads(writes) if isinstance(writes, str) else writes
    if not writes:
        return
    store = GcsObjectStore(row["bucket"], row["prefix"] + "/" + str(row["library_id"]))
    bucket_admission.verify(row, await bucket_admission.observe(store, row["bucket"]))
    eligible = [
        (op, value)
        for op, value in writes.items()
        if isinstance(value, dict)
        and (value.get("protocol") == 2 or value.get("state") == "uncertain")
    ]
    for operation, receipt in eligible[:maximum]:
        path = receipt.get("path", "")
        if not re.fullmatch(r"[a-f0-9]{64}/[a-f0-9]{64}", path):
            continue
        if receipt.get("protocol") == 2:
            from .writes import reconcile as reconcile_session  # noqa: PLC0415

            await reconcile_session(
                SharedCipherStore(row["bucket"], row["prefix"] + "/" + str(row["library_id"])),
                row,
                operation,
                receipt,
            )
            continue
        data, version = await store.get_bounded_with_generation(
            path, max_bytes=4 * 1024 * 1024 + 128 * 1024
        )
        # Exact ciphertext proves the dispatched effect. A different generation
        # defeats the old conditional write even if its network call finishes late.
        # Create-only requests can become valid again after deletion. Object
        # presence cannot prove no late duplicate remains; retain their fence
        # until an independent provider-completion receipt establishes absence.
        if not receipt.get("expectedGeneration"):
            continue
        exact = data is not None and hashlib.sha256(data).hexdigest() == receipt.get("digest")
        superseded = data is not None and version != receipt.get("expectedGeneration")
        if exact or superseded:
            await registry.settle_write(row["user_id"], str(row["library_id"]), operation)
