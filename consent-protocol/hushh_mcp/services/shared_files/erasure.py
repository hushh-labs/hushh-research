"""Bounded owner-prefix cleanup. Never delete the shared bucket or another owner.

The SQL fence blocks new writes before provider cleanup. Retained versions and
uncertain writes remain outstanding; a no-op rollback is never recovery.
"""

from __future__ import annotations

import json
from collections.abc import Callable
from contextlib import AbstractContextManager
from typing import Any

from sqlalchemy import text
from sqlalchemy.engine import Connection

from hushh_mcp.services.pod_commit_log import GcsObjectStore
from hushh_mcp.services.pod_files.contracts import FilesRefused

from . import bucket_admission, registry
from .erasure_objects import erase_objects


async def erase(owner: str) -> dict[str, Any] | None:
    from .reconciliation import reconcile  # noqa: PLC0415

    observed = await registry.resource(owner)
    if observed:
        await reconcile(observed)
    row = await registry.fence(owner)
    if row is None:
        return None
    if row["user_id"] != owner or row["prefix"] != registry.owner_prefix(owner):
        raise FilesRefused("FILES_ERASURE_INVENTORY_INVALID", 409)
    if row["state"] == "erased":
        receipt = row["receipt"]
        receipt = json.loads(receipt) if isinstance(receipt, str) else receipt
        if (
            not isinstance(receipt, dict)
            or receipt.get("complete") is not True
            or receipt.get("bucketIdentityVerified") is not True
            or receipt.get("libraryId") != str(row["library_id"])
            or receipt.get("bucket") != row["bucket"]
            or receipt.get("prefix") != row["prefix"] + "/" + str(row["library_id"]) + "/"
        ):
            raise FilesRefused("FILES_ERASURE_RECEIPT_INVALID", 409)
        try:
            bucket_admission.verify(row, receipt.get("bucketIdentity", {}))
        except FilesRefused:
            raise FilesRefused("FILES_ERASURE_RECEIPT_INVALID", 409) from None
        return receipt
    prefix = row["prefix"] + "/" + str(row["library_id"]) + "/"
    if not prefix.startswith("shared-files/v1/") or ".." in prefix:
        raise FilesRefused("FILES_ERASURE_INVENTORY_INVALID", 409)
    store = GcsObjectStore(row["bucket"])

    identity = await erase_objects(store, row["bucket"], prefix, row)
    receipt = {
        "version": 1,
        "libraryId": str(row["library_id"]),
        "bucket": row["bucket"],
        "prefix": prefix,
        "complete": True,
        "writesFenced": True,
        "activeAndRetainedObjectsAbsent": True,
        "bucketIdentityVerified": True,
        "bucketIdentity": identity,
    }
    await registry.erased(owner, str(row["library_id"]), receipt)
    return receipt


async def erase_if_present(
    user_id: str,
    *,
    backend_only: bool,
    table_exists: Callable[[Connection, str], bool],
    connection_factory: Callable[[], AbstractContextManager[Connection]],
) -> dict[str, Any] | None:
    """Fail closed before account keys can be removed; keep errors content-free."""
    try:
        with connection_factory() as conn:
            if not table_exists(conn, "shared_files_storage"):
                return None
            present = conn.execute(
                text("SELECT 1 FROM shared_files_storage WHERE user_id=:user_id"),
                {"user_id": user_id},
            ).first()
    except Exception:
        return {
            "success": False,
            "error_code": "SHARED_FILES_CLEANUP_UNCONFIRMED",
            "account_deleted": False,
        }
    if not present:
        return None
    if backend_only:
        return {
            "success": False,
            "error_code": "SHARED_FILES_EXTERNAL_CLEANUP_REQUIRED",
            "account_deleted": False,
        }
    try:
        await erase(user_id)
    except FilesRefused as exc:
        return {
            "success": False,
            "error_code": exc.code,
            "account_deleted": False,
            "message": (
                "Files deletion is pending. Access is fenced; retry to continue cleanup."
                if exc.code == "FILES_ERASURE_IN_PROGRESS"
                else "Files deletion could not be verified. Your account has not been deleted."
            ),
        }
    except Exception:
        return {
            "success": False,
            "error_code": "SHARED_FILES_CLEANUP_UNCONFIRMED",
            "account_deleted": False,
        }
    return None
