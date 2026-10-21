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
        if written is not None:
            # A validated terminal provider response settles this exact permit
            # even if access changes next. This is recovery bookkeeping, not
            # authorization to return information or to issue another upload.
            # The CAS cannot erase a competing recovery claim.
            if not await asyncio.shield(
                write_receipts.transition(row, operation, receipt, None, mode="recovery")
            ):
                raise FilesRefused("FILES_UPLOAD_OPERATION_CHANGED", 409)
        await check()
        if written is None:
            raise FilesRefused("FILES_REVISION_CONFLICT", 409)
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
        stopped = claimed.get("providerTerminal") in {"cancelled", "invalidated"}
        status = "uncertain" if stopped else await store.status(uri, claimed["path"], size)
        # An inconclusive status probe may still identify a cancellable session.
        # JSON HTTP 499 confirms cancellation; an exact session's HTTP 410
        # confirms invalidation. Generic 404/412 and lost replies prove neither.
        if status != "complete" and not stopped:
            outcome = "invalidated" if status == "invalidated" else None
            if outcome is None and await store.cancel(uri, claimed["path"]):
                outcome = "cancelled"
            if outcome:
                previous = claimed
                claimed = {**claimed, "providerTerminal": outcome}
                # Carry the new predecessor into finally before awaiting its
                # shielded save. Cancellation cannot overwrite a saved proof
                # with the older claim while the save is still settling.
                if not await asyncio.shield(
                    write_receipts.transition(row, operation, previous, claimed, mode="recovery")
                ):
                    return
                stopped = True
        if status != "complete" and not stopped:
            return
        if stopped and row["state"] == "erasing":
            # The exact session can no longer deliver bytes. Erasure owns the
            # remaining prefix inventory, including a different object revision.
            # Never release a nonterminal write or bypass bucket incarnation.
            bucket_admission.verify(row, await bucket_admission.observe(store, row["bucket"]))
            await write_receipts.transition(row, operation, claimed, None, mode="recovery")
            return
        data, version = await store.get_bounded_with_generation(
            claimed["path"],
            max_bytes=MAX_CIPHERTEXT_BYTES,
        )
        terminal = (
            (status == "complete" or stopped)
            and data is not None
            and len(data) == size
            and hashlib.sha256(data).hexdigest() == claimed["digest"]
        ) or (stopped and (data is None or version == claimed["expectedGeneration"]))
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
