"""Durable resource inventory and exclusive metadata lease for Shared Files.

A lease may expire only after every provider write has settled. Unknown outcomes
remain fenced; elapsed time does not prove a provider stopped writing.
"""

from __future__ import annotations

import hashlib
import json
import os
import time
from contextlib import asynccontextmanager
from typing import Any
from uuid import UUID, uuid4

from db.connection import get_pool
from hushh_mcp.services.pod_files.contracts import FilesRefused


def owner_prefix(owner: str) -> str:
    return (
        "shared-files/v1/" + hashlib.sha256(("hussh/shared-files/v1/" + owner).encode()).hexdigest()
    )


async def _placement_lock(connection: Any, owner: str) -> None:
    # One transaction boundary for library enrollment and placement writes,
    # including owners who have not created vault_keys yet.
    await connection.execute(
        "SELECT pg_advisory_xact_lock(hashtextextended($1,0))",
        "hussh/shared-files/placement/v1/" + owner,
    )


@asynccontextmanager
async def protect_placement_change(owner: str):
    enabled = os.getenv("HUSSH_SHARED_FILES_ENABLED", "").lower() in {"1", "true"}
    from asyncpg import UndefinedTableError  # noqa: PLC0415

    try:
        pool = await get_pool()
    except Exception:
        raise FilesRefused("FILES_STORAGE_UNAVAILABLE", 503) from None
    async with pool.acquire() as connection, connection.transaction():
        await _placement_lock(connection, owner)
        present = await connection.fetchval("SELECT to_regclass('public.shared_files_storage')")
        if present is None:
            if enabled:
                raise FilesRefused("FILES_STORAGE_SCHEMA_UNAVAILABLE", 503)
            yield
            return
        try:
            row = await connection.fetchrow(
                "SELECT state FROM shared_files_storage WHERE user_id=$1", owner
            )
        except UndefinedTableError:
            raise FilesRefused("FILES_STORAGE_SCHEMA_UNAVAILABLE", 503) from None
        if row and row["state"] != "erased":
            raise FilesRefused("FILES_TRANSFER_REQUIRED", 409)
        yield


async def resource(
    owner: str, *, bucket: str | None = None, admission: dict[str, Any] | None = None
) -> dict[str, Any] | None:
    pool = await get_pool()
    if not bucket:
        row = await pool.fetchrow("SELECT * FROM shared_files_storage WHERE user_id=$1", owner)
        return dict(row) if row else None
    if admission is None:
        raise FilesRefused("FILES_STORAGE_IDENTITY_UNVERIFIED", 503)
    from hushh_mcp.services.owner_placement_guard import admit_hub_content  # noqa: PLC0415

    async with pool.acquire() as connection, connection.transaction():
        await _placement_lock(connection, owner)
        await admit_hub_content(owner, "shared_files_enrollment")
        await connection.execute(
            """INSERT INTO shared_files_storage(user_id,bucket,prefix,bucket_admission)
               SELECT user_id,$2,$3,$4::jsonb FROM vault_keys WHERE user_id=$1
               ON CONFLICT(user_id) DO NOTHING""",
            owner,
            bucket,
            owner_prefix(owner),
            json.dumps(admission),
        )
        row = await connection.fetchrow(
            "SELECT * FROM shared_files_storage WHERE user_id=$1", owner
        )
        return dict(row) if row else None


def _epoch(value: Any) -> str:
    try:
        return str(UUID(str(value)))
    except ValueError:
        raise FilesRefused("FILES_LIBRARY_CHANGED", 409) from None


async def active(owner: str, library_id: str) -> dict[str, Any]:
    row = await resource(owner)
    if not row or row["state"] != "active" or str(row["library_id"]) != _epoch(library_id):
        raise FilesRefused("FILES_LIBRARY_CHANGED", 409)
    return row


async def acquire(owner: str, library_id: str, lease_id: str) -> None:
    pool = await get_pool()
    result = await pool.fetchrow(
        """UPDATE shared_files_storage SET lease_id=$3::uuid,
             lease_until=now()+interval '30 seconds',updated_at=now()
           WHERE user_id=$1 AND library_id=$2::uuid AND state='active'
             AND ((lease_id=$3::uuid AND lease_until>now()) OR lease_id IS NULL OR
                  (lease_until<now() AND writes='{}'::jsonb)) RETURNING user_id""",
        owner,
        _epoch(library_id),
        _epoch(lease_id),
    )
    if not result:
        raise FilesRefused("FILES_MUTATION_BUSY", 409)


async def release(owner: str, library_id: str, lease_id: str) -> None:
    pool = await get_pool()
    await pool.execute(
        """UPDATE shared_files_storage SET lease_id=NULL,lease_until=NULL,updated_at=now()
           WHERE user_id=$1 AND library_id=$2::uuid AND lease_id=$3::uuid
             AND writes='{}'::jsonb""",
        owner,
        _epoch(library_id),
        _epoch(lease_id),
    )


async def reserve_write(
    owner: str,
    library_id: str,
    lease_id: str,
    *,
    path: str,
    digest: str,
    expected_generation: str,
    byte_count: int | None = None,
) -> str:
    if byte_count is not None and not 28 <= byte_count <= 4 * 1024 * 1024 + 128 * 1024:
        raise FilesRefused("FILES_OBJECT_INVALID", 400)
    pool = await get_pool()
    operation = uuid4().hex
    result = await pool.fetchrow(
        """UPDATE shared_files_storage SET
             writes=writes || jsonb_build_object($4::text,$5::jsonb),
             lease_until=now()+interval '30 seconds',updated_at=now()
           WHERE user_id=$1 AND library_id=$2::uuid AND state='active'
             AND lease_id=$3::uuid AND lease_until>now()
             AND bucket_admission IS NOT NULL
             AND (SELECT count(*) FROM jsonb_object_keys(writes))<64 RETURNING user_id""",
        owner,
        _epoch(library_id),
        _epoch(lease_id),
        operation,
        json.dumps(
            {
                "path": path,
                "digest": digest,
                "expectedGeneration": expected_generation,
                "startedAt": time.time(),
                "state": "reserved" if byte_count is not None else "inflight",
                **({"protocol": 2, "byteCount": byte_count} if byte_count is not None else {}),
            }
        ),
    )
    if not result:
        raise FilesRefused("FILES_LEASE_CHANGED", 409)
    return operation


async def settle_write(
    owner: str, library_id: str, operation: str, *, uncertain: bool = False
) -> None:
    pool = await get_pool()
    if uncertain:
        await pool.execute(
            """UPDATE shared_files_storage SET writes=jsonb_set(writes,ARRAY[$3::text,'state'],'\"uncertain\"'::jsonb),updated_at=now()
               WHERE user_id=$1 AND library_id=$2::uuid AND writes ? $3 AND writes->$3->>'protocol' IS DISTINCT FROM '2'""",
            owner,
            _epoch(library_id),
            operation,
        )
    else:
        await pool.execute(
            "UPDATE shared_files_storage SET writes=writes-$3::text,updated_at=now() WHERE user_id=$1 AND library_id=$2::uuid AND writes->$3->>'protocol' IS DISTINCT FROM '2'",
            owner,
            _epoch(library_id),
            operation,
        )


async def fence(owner: str) -> dict[str, Any] | None:
    pool = await get_pool()
    row = await pool.fetchrow(
        """UPDATE shared_files_storage SET state=CASE WHEN state='erased' THEN state ELSE 'erasing' END,
             updated_at=now() WHERE user_id=$1 RETURNING *""",
        owner,
    )
    if not row:
        return None
    result = dict(row)
    writes = result["writes"]
    if json.loads(writes) if isinstance(writes, str) else writes:
        raise FilesRefused("FILES_ERASURE_WAITING_FOR_WRITES", 409)
    return result


async def erased(owner: str, library_id: str, receipt: dict[str, Any]) -> None:
    pool = await get_pool()
    row = await pool.fetchrow(
        """UPDATE shared_files_storage SET state='erased',receipt=$3::jsonb,
             lease_id=NULL,lease_until=NULL,updated_at=now()
           WHERE user_id=$1 AND library_id=$2::uuid AND state='erasing' AND writes='{}'::jsonb
           RETURNING user_id""",
        owner,
        _epoch(library_id),
        json.dumps(receipt),
    )
    if not row:
        raise FilesRefused("FILES_ERASURE_UNCONFIRMED", 409)
