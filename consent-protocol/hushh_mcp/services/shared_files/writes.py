"""Durable dispatch and bounded recovery; a process exit is never a drain receipt."""

from __future__ import annotations

import asyncio
import hashlib
import time
from collections.abc import Awaitable, Callable
from typing import Any
from uuid import uuid4

from hushh_mcp.services.pod_files.contracts import FilesRefused

from . import bucket_admission, registry, write_receipts
from .uploads import MAX_CIPHERTEXT_BYTES, SharedCipherStore


async def write(
    store: SharedCipherStore,
    row: dict[str, Any],
    lease: str,
    path: str,
    data: bytes,
    expected: str,
    check: Callable[[], Awaitable[None]],
) -> str:
    operation = await registry.reserve_write(
        row["user_id"],
        str(row["library_id"]),
        lease,
        path=path,
        digest=hashlib.sha256(data).hexdigest(),
        expected_generation=expected,
        byte_count=len(data),
    )
    receipt = await write_receipts.current(row["user_id"], str(row["library_id"]), operation)
    try:
        uri = await store.initiate(path, len(data), expected)
        if uri is None:
            if not await write_receipts.transition(
                row, operation, receipt, None, mode="live", lease=lease
            ):
                raise FilesRefused("FILES_UPLOAD_OPERATION_CHANGED", 409)
            raise FilesRefused("FILES_REVISION_CONFLICT", 409)
        ready = {
            **receipt,
            "state": "session_ready",
            "session": write_receipts.seal(row, operation, receipt, uri),
        }
        await check()
        if not await write_receipts.transition(
            row, operation, receipt, ready, mode="dispatch", lease=lease
        ):
            # No payload can have been sent. The late initializer is fenced.
            await store.cancel(uri, path)
            raise FilesRefused("FILES_UPLOAD_OPERATION_CHANGED", 409)
        receipt = ready
        sending = {**receipt, "state": "sending"}
        if not await write_receipts.transition(
            row, operation, receipt, sending, mode="dispatch", lease=lease
        ):
            raise FilesRefused("FILES_UPLOAD_OPERATION_CHANGED", 409)
        receipt = sending
        written = await store.send(uri, path, data)
        await check()
        if written is None:
            raise FilesRefused("FILES_REVISION_CONFLICT", 409)
        if not await write_receipts.transition(
            row, operation, receipt, None, mode="live", lease=lease
        ):
            raise FilesRefused("FILES_UPLOAD_OPERATION_CHANGED", 409)
        return written
    except BaseException:
        # A stale exception cannot overwrite a recovery claim or resurrect an
        # operation that already settled. Interrupted thread I/O stays fenced.
        await asyncio.shield(
            write_receipts.transition(
                row,
                operation,
                receipt,
                {**receipt, "state": "uncertain"},
                mode="recovery",
            )
        )
        raise


async def reconcile(
    store: SharedCipherStore,
    row: dict[str, Any],
    operation: str,
    receipt: dict[str, Any],
) -> None:
    if receipt.get("state") == "reserved" or (
        receipt.get("state") == "uncertain" and "session" not in receipt
    ):
        # Initiation has zero payload. Removing its permit prevents every late
        # initializer from attaching a session or dispatching bytes.
        await write_receipts.transition(row, operation, receipt, None, mode="abandon")
        return
    claimed = {
        **receipt,
        "state": "reconciling",
        "reconciliation": uuid4().hex,
        "claimUntil": time.time() + 600,
    }
    if not await write_receipts.transition(row, operation, receipt, claimed, mode="claim"):
        return
    try:
        size = claimed["byteCount"]
        if not isinstance(size, int) or not 28 <= size <= MAX_CIPHERTEXT_BYTES:
            raise FilesRefused("FILES_UPLOAD_CUSTODY_UNVERIFIED", 503)
        uri = write_receipts.restore(row, operation, claimed)
        status = await store.status(uri, claimed["path"], size)
        cancelled = status == "incomplete" and await store.cancel(uri, claimed["path"])
        if status != "complete" and not cancelled:
            return
        data, version = await store.get_bounded_with_generation(
            claimed["path"],
            max_bytes=MAX_CIPHERTEXT_BYTES,
        )
        terminal = (
            (status == "complete" or cancelled)
            and data is not None
            and len(data) == size
            and hashlib.sha256(data).hexdigest() == claimed["digest"]
        ) or (cancelled and (data is None or version == claimed["expectedGeneration"]))
        bucket_admission.verify(row, await bucket_admission.observe(store, row["bucket"]))
        if terminal:
            await write_receipts.transition(row, operation, claimed, None, mode="recovery")
    finally:
        # Includes unknown/missing provider status and lost cancellation reply;
        # retain encrypted session custody for a later bounded recovery attempt.
        await asyncio.shield(
            write_receipts.transition(
                row,
                operation,
                claimed,
                {**claimed, "state": "uncertain"},
                mode="recovery",
            )
        )
