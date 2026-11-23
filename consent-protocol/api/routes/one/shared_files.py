"""Shared Files ciphertext transport. No library key or plaintext tool runtime.

Owner authentication and explicit Shared placement are independent of encryption.
Object names contain only opaque identifiers; bounded index reads do not hydrate a
whole library. The existing object-store adapter supplies generation CAS.
"""

from __future__ import annotations

import asyncio
import base64
import json
import os
import re
from datetime import datetime, timezone
from functools import lru_cache
from typing import Any

from asyncpg import UndefinedTableError
from fastapi import APIRouter, Depends, HTTPException, Query, Request
from fastapi.responses import JSONResponse
from pydantic import BaseModel, ConfigDict, Field

from api.middleware import require_firebase_auth, require_vault_owner_token
from db.connection import get_pool
from hushh_mcp.runtime_settings import pod_mode
from hushh_mcp.services.owner_placement_guard import admit_hub_content, hub_content_owner
from hushh_mcp.services.personal_agent_hosting import get_owner_hosting_mode
from hushh_mcp.services.pod_commit_log import object_key_segments
from hushh_mcp.services.pod_emulator_endpoints import resolve_gcp_storage_origin
from hushh_mcp.services.pod_files.contracts import FilesRefused
from hushh_mcp.services.pod_object_version import decimal_generation
from hushh_mcp.services.shared_files import bucket_admission, registry, writes
from hushh_mcp.services.shared_files.uploads import SharedCipherStore

router = APIRouter(prefix="/api/one/files", tags=["Files ciphertext"])
MAX_CIPHERTEXT_BYTES = 4 * 1024 * 1024 + 128 * 1024
MAX_REQUEST_BYTES = (MAX_CIPHERTEXT_BYTES * 4 // 3) + 1024
_OPAQUE = re.compile(r"^[a-f0-9]{64}$")
_MIGRATION_ID = re.compile(r"^[A-Za-z0-9_-]{1,128}$")
_ZERO_ENVELOPE = "0" * 64 + "/" + "0" * 64


def _refuse(code: str, status: int = 409) -> HTTPException:
    return HTTPException(status_code=status, detail={"code": code})


def _identifier(value: str) -> str:
    if not _OPAQUE.fullmatch(value):
        raise _refuse("FILES_OBJECT_INVALID", 400)
    return value


@lru_cache(maxsize=128)
def _configured_store(bucket: str, prefix: str) -> SharedCipherStore:
    return SharedCipherStore(bucket, prefix)


async def _store(
    owner: str, library_id: str | None = None
) -> tuple[SharedCipherStore, dict[str, Any]]:
    if os.getenv("HUSSH_SHARED_FILES_ENABLED", "").lower() not in {"1", "true"}:
        raise _refuse("FILES_NOT_ENABLED", 503)
    bucket = os.getenv("HUSSH_SHARED_FILES_BUCKET", "").strip()
    if not re.fullmatch(r"[a-z0-9][a-z0-9._-]{1,220}[a-z0-9]", bucket):
        raise _refuse("FILES_STORAGE_UNAVAILABLE", 503)
    try:
        if library_id is None:
            metadata_store = _configured_store(bucket, registry.owner_prefix(owner))
            observed = await bucket_admission.observe(metadata_store, bucket)
            row = await registry.resource(
                owner, bucket=bucket, admission=bucket_admission.admission(observed, bucket)
            )
        else:
            row = await registry.active(owner, library_id)
        if not row or row["state"] != "active":
            raise _refuse("FILES_LIBRARY_CHANGED")
        if row["bucket"] != bucket:
            raise _refuse("FILES_STORAGE_CONFIGURATION_CHANGED", 503)
        return _configured_store(bucket, row["prefix"] + "/" + str(row["library_id"])), row
    except FilesRefused as exc:
        raise _refuse(exc.code, exc.status) from None
    except UndefinedTableError:
        raise _refuse("FILES_STORAGE_SCHEMA_UNAVAILABLE", 503) from None


async def _active(owner: str, library_id: str) -> dict[str, Any]:
    try:
        row = await registry.active(owner, library_id)
        if not isinstance(row, dict):
            raise _refuse("FILES_STORAGE_UNAVAILABLE", 503)
        return row
    except FilesRefused as exc:
        raise _refuse(exc.code, exc.status) from None


async def _fresh_owner(request: Request, owner: str) -> None:
    current = await require_vault_owner_token(
        authorization=request.headers.get("authorization"),
        hushh_consent=request.headers.get("x-hushh-consent"),
    )
    if current["user_id"] != owner:
        raise _refuse("FILES_OWNER_CHANGED", 403)
    await admit_hub_content(owner, "shared_files")


async def _admit_ciphertext_read(owner: str) -> str:
    if pod_mode():
        return "pod_process"
    from api.utils.firebase_auth import _assert_account_not_deleted  # noqa: PLC0415
    from hushh_mcp.services.account_deletion_lifecycle_service import (  # noqa: PLC0415
        settle_cleanup_database_call,
    )

    await settle_cleanup_database_call(_assert_account_not_deleted, owner)
    mode = await get_owner_hosting_mode(owner)
    if mode in {"shared", "hussh_pods", "byoc"}:
        return str(mode)
    if mode in {"pending", "unplaced"}:
        raise _refuse("AGENT_PRIVATE_RUNTIME_REQUIRED", 409)
    raise _refuse("AGENT_HOSTING_UNAVAILABLE", 503)


async def _fresh_read_owner(request: Request, owner: str) -> None:
    current = await require_vault_owner_token(
        authorization=request.headers.get("authorization"),
        hushh_consent=request.headers.get("x-hushh-consent"),
    )
    if current["user_id"] != owner:
        raise _refuse("FILES_OWNER_CHANGED", 403)
    await _admit_ciphertext_read(owner)


async def _store_for_read(
    owner: str, library_id: str | None = None
) -> tuple[SharedCipherStore, dict[str, Any]]:
    mode = await _admit_ciphertext_read(owner)
    if mode == "shared":
        return await _store(owner, library_id)
    if os.getenv("HUSSH_SHARED_FILES_ENABLED", "").lower() not in {"1", "true"}:
        raise _refuse("FILES_NOT_ENABLED", 503)
    bucket = os.getenv("HUSSH_SHARED_FILES_BUCKET", "").strip()
    if not re.fullmatch(r"[a-z0-9][a-z0-9._-]{1,220}[a-z0-9]", bucket):
        raise _refuse("FILES_STORAGE_UNAVAILABLE", 503)
    try:
        row = (
            await registry.resource(owner)
            if library_id is None
            else await registry.active(owner, library_id)
        )
        if not row or row["state"] != "active":
            raise _refuse("FILES_LIBRARY_CHANGED")
        if row["bucket"] != bucket:
            raise _refuse("FILES_STORAGE_CONFIGURATION_CHANGED", 503)
        return _configured_store(bucket, row["prefix"] + "/" + str(row["library_id"])), row
    except FilesRefused as exc:
        raise _refuse(exc.code, exc.status) from None
    except UndefinedTableError:
        raise _refuse("FILES_STORAGE_SCHEMA_UNAVAILABLE", 503) from None


async def _body(request: Request, maximum: int) -> bytes:
    value = bytearray()
    try:
        async with asyncio.timeout(15):
            async for chunk in request.stream():
                if len(value) + len(chunk) > maximum:
                    raise _refuse("FILES_OBJECT_TOO_LARGE", 413)
                value.extend(chunk)
    except TimeoutError:
        raise _refuse("FILES_REQUEST_TIMEOUT", 408) from None
    return bytes(value)


async def _security(store: SharedCipherStore, row: dict[str, Any]) -> dict[str, Any]:
    try:
        value = await bucket_admission.observe(store, row["bucket"])
        bucket_admission.verify(row, value)
    except FilesRefused as exc:
        raise _refuse(exc.code, exc.status) from None
    return {
        "retentionSeconds": int((value.get("retentionPolicy") or {}).get("retentionPeriod", 0)),
        "retentionLocked": bool((value.get("retentionPolicy") or {}).get("isLocked")),
        "softDeleteSeconds": int(
            (value.get("softDeletePolicy") or {}).get("retentionDurationSeconds", 0)
        ),
        "versioning": bool((value.get("versioning") or {}).get("enabled")),
        "physicalDeletion": "not_requested_by_trash",
    }


def _response(body: Any, status: int = 200) -> JSONResponse:
    return JSONResponse(body, status_code=status, headers={"Cache-Control": "no-store"})


@router.get("/storage")
async def configuration(
    request: Request, token: dict = Depends(require_vault_owner_token)
) -> JSONResponse:
    store, row = await _store_for_read(token["user_id"], request.headers.get("x-files-library-id"))
    from hushh_mcp.services.shared_files.reconciliation import reconcile  # noqa: PLC0415

    await reconcile(row)
    retention = await _security(store, row)
    await _fresh_read_owner(request, token["user_id"])
    await _active(token["user_id"], str(row["library_id"]))
    await _fresh_read_owner(request, token["user_id"])
    return _response(
        {
            "version": 1,
            "libraryId": str(row["library_id"]),
            "retention": retention,
            "backgroundAvailable": False,
        }
    )


@router.get("/objects/{namespace}")
async def list_objects(
    namespace: str,
    request: Request,
    cursor: str = "",
    token: dict = Depends(require_vault_owner_token),
) -> JSONResponse:
    if len(cursor) > 2048:
        raise _refuse("FILES_CURSOR_INVALID", 400)
    store, row = await _store_for_read(token["user_id"], request.headers.get("x-files-library-id"))
    await _security(store, row)
    paths, next_cursor = await store.list_page(_identifier(namespace), cursor, 100)
    keys = [_identifier(path.rsplit("/", 1)[-1]) for path in paths]
    await _fresh_read_owner(request, token["user_id"])
    await _active(token["user_id"], str(row["library_id"]))
    return _response({"keys": keys, "cursor": next_cursor})


@router.get("/objects/{namespace}/{object_id}")
async def read_object(
    namespace: str,
    object_id: str,
    request: Request,
    token: dict = Depends(require_vault_owner_token),
) -> JSONResponse:
    store, row = await _store_for_read(token["user_id"], request.headers.get("x-files-library-id"))
    await _security(store, row)
    data, generation = await store.get_bounded_with_generation(
        _identifier(namespace) + "/" + _identifier(object_id), max_bytes=MAX_CIPHERTEXT_BYTES
    )
    await _fresh_read_owner(request, token["user_id"])
    await _active(token["user_id"], str(row["library_id"]))
    return _response(
        {
            "ciphertext": base64.b64encode(data).decode() if data is not None else None,
            "generation": generation,
        }
    )


@router.put("/objects/{namespace}/{object_id}")
async def write_object(
    namespace: str, object_id: str, request: Request, token: dict = Depends(hub_content_owner)
) -> JSONResponse:
    body = await _body(request, MAX_REQUEST_BYTES)
    try:
        value = json.loads(body)
        if not isinstance(value, dict) or set(value) != {"ciphertext", "expectedGeneration"}:
            raise ValueError
        data = base64.b64decode(value["ciphertext"], validate=True)
        generation = value["expectedGeneration"]
        decimal_generation(generation)
        if not 28 <= len(data) <= MAX_CIPHERTEXT_BYTES:
            raise ValueError
    except (ValueError, TypeError, KeyError):
        raise _refuse("FILES_OBJECT_INVALID", 400) from None
    store, row = await _store(token["user_id"], request.headers.get("x-files-library-id"))
    await _security(store, row)
    await _fresh_owner(request, token["user_id"])
    await _active(token["user_id"], str(row["library_id"]))
    path = _identifier(namespace) + "/" + _identifier(object_id)
    lease = request.headers.get("x-files-mutation-lease", "")

    async def check() -> None:
        await _security(store, row)
        await _fresh_owner(request, token["user_id"])
        await _active(token["user_id"], str(row["library_id"]))

    try:
        written = await writes.write(store, row, lease, path, data, generation, check)
    except FilesRefused as exc:
        raise _refuse(exc.code, exc.status) from None
    await _fresh_owner(request, token["user_id"])
    await _active(token["user_id"], str(row["library_id"]))
    return _response({"generation": written})


@router.post("/analyze")
async def analyze(request: Request, token: dict = Depends(hub_content_owner)) -> JSONResponse:
    if os.getenv("HUSSH_SHARED_FILES_ENABLED", "").lower() not in {"1", "true"}:
        raise _refuse("FILES_NOT_ENABLED", 503)
    from api.middleware import require_vault_owner_token  # noqa: PLC0415
    from hushh_mcp.one_adk.agent_tree import _load_product_agent_manifest  # noqa: PLC0415
    from hushh_mcp.one_adk.files_tools import foreground_tools  # noqa: PLC0415
    from hushh_mcp.runtime_providers import build_managed_gemini_adk_model  # noqa: PLC0415
    from hushh_mcp.runtime_providers.gemini_config import resolve_fleet_model_name  # noqa: PLC0415
    from hushh_mcp.services.pod_files.contracts import FilesRefused  # noqa: PLC0415
    from hushh_mcp.services.pod_files.foreground import (  # noqa: PLC0415
        ForegroundProjection,
        ForegroundRequest,
    )
    from hushh_mcp.services.pod_files.jobs import _organize  # noqa: PLC0415

    store, row = await _store(token["user_id"], request.headers.get("x-files-library-id"))
    await _security(store, row)
    body = await _body(request, 384 * 1024)
    try:
        projection_request = ForegroundRequest.model_validate_json(body)
    except ValueError:
        raise _refuse("FILES_PROJECTION_INVALID", 400) from None

    async def check() -> None:
        if await request.is_disconnected():
            raise FilesRefused("FILES_FOREGROUND_DISCONNECTED", 409)
        current = await require_vault_owner_token(
            authorization=request.headers.get("authorization"),
            hushh_consent=request.headers.get("x-hushh-consent"),
        )
        if current["user_id"] != token["user_id"]:
            raise FilesRefused("FILES_OWNER_CHANGED", 403)
        await admit_hub_content(token["user_id"], "files_foreground")
        await _active(token["user_id"], str(row["library_id"]))

    try:
        port = ForegroundProjection(projection_request, check)
        manifest = _load_product_agent_manifest("agent_files")
        model = build_managed_gemini_adk_model(
            resolve_fleet_model_name(manifest.model_config_for_runtime().name)
        )
        with foreground_tools(port):
            await check()
            result = await _organize(port.file["id"], model=model)
            await check()
        return _response(
            {
                "fileId": projection_request.file.id,
                "revision": projection_request.file.revision,
                "consentRevision": projection_request.consent_revision,
                "provider": "gemini",
                "changes": port.changes,
                "result": result.model_dump(),
            }
        )
    except FilesRefused as exc:
        raise _refuse(exc.code, exc.status) from None
    except Exception:
        raise _refuse("FILES_MODEL_UNAVAILABLE", 503) from None


@router.post("/storage")
async def mutation_lease(
    request: Request, token: dict = Depends(hub_content_owner)
) -> JSONResponse:
    body = await _body(request, 512)
    try:
        value = json.loads(body)
        if set(value) != {"operation", "leaseId"} or value["operation"] not in {
            "acquire",
            "release",
        }:
            raise ValueError
        _store_value, row = await _store(
            token["user_id"], request.headers.get("x-files-library-id")
        )
        await _fresh_owner(request, token["user_id"])
        action = registry.acquire if value["operation"] == "acquire" else registry.release
        await action(token["user_id"], str(row["library_id"]), value["leaseId"])
    except (ValueError, TypeError, KeyError):
        raise _refuse("FILES_LEASE_INVALID", 400) from None
    except FilesRefused as exc:
        raise _refuse(exc.code, exc.status) from None
    return _response({"status": "accepted"})


class FilesMigrationCompleteRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    migrated_files: int = Field(default=0, ge=0, le=100_000)
    migrated_wiki_pages: int = Field(default=0, ge=0, le=100_000)


def _migration_receipt(row: dict[str, Any]) -> dict[str, Any]:
    raw = row.get("receipt")
    if isinstance(raw, str):
        try:
            raw = json.loads(raw)
        except ValueError:
            raw = {}
    return dict(raw) if isinstance(raw, dict) else {}


async def _migration_row(owner: str) -> tuple[SharedCipherStore, dict[str, Any]] | None:
    if os.getenv("HUSSH_SHARED_FILES_ENABLED", "").lower() not in {"1", "true"}:
        return None
    bucket = os.getenv("HUSSH_SHARED_FILES_BUCKET", "").strip()
    if not re.fullmatch(r"[a-z0-9][a-z0-9._-]{1,220}[a-z0-9]", bucket):
        return None
    try:
        row = await registry.resource(owner)
    except (FilesRefused, UndefinedTableError):
        return None
    if not row or row.get("state") != "active" or row.get("bucket") != bucket:
        return None
    store = _configured_store(bucket, str(row["prefix"]) + "/" + str(row["library_id"]))
    return store, row


async def _list_library_objects(store: SharedCipherStore) -> list[str]:
    origin, _ = resolve_gcp_storage_origin()
    root = store._prefix + "/" if store._prefix else ""
    objects: list[str] = []
    cursor = ""
    for _ in range(10):
        params: dict[str, str] = {
            "prefix": root,
            "maxResults": "100",
            "fields": "items(name),nextPageToken",
        }
        if cursor:
            params["pageToken"] = cursor
        response = await asyncio.to_thread(
            store._object_get,
            f"{origin}/storage/v1/b/{store._bucket}/o",
            params,
            30,
        )
        if response.status_code != 200:
            raise _refuse("FILES_STORAGE_UNAVAILABLE", 503)
        body = response.json()
        for entry in body.get("items", []):
            name = str(entry.get("name") or "")
            if not name.startswith(root):
                continue
            rel = name[len(root) :]
            if not rel:
                continue
            object_key_segments(rel)
            objects.append(rel)
            if len(objects) >= 1000:
                return objects
        cursor = str(body.get("nextPageToken") or "")
        if not cursor:
            break
    return objects


async def _read_bounded_migration_object(
    store: SharedCipherStore, candidates: tuple[str, ...]
) -> tuple[bytes | None, str]:
    for rel in candidates:
        object_key_segments(rel)
        data, generation = await store.get_bounded_with_generation(
            rel, max_bytes=MAX_CIPHERTEXT_BYTES
        )
        if data is not None:
            return data, str(generation or "")
    return None, ""


async def _mark_ace_migration_complete(
    owner: str, *, migrated_files: int, migrated_wiki_pages: int
) -> None:
    marker = {
        "status": "migrated",
        "migrated_files": migrated_files,
        "migrated_wiki_pages": migrated_wiki_pages,
        "migrated_at": datetime.now(timezone.utc).isoformat(),
    }
    try:
        pool = await get_pool()
    except Exception:
        return
    try:
        await pool.execute(
            """UPDATE shared_files_storage
               SET receipt = COALESCE(receipt, '{}'::jsonb) || jsonb_build_object('ace_migration', $2::jsonb),
                   updated_at = now()
               WHERE user_id = $1""",
            owner,
            json.dumps(marker),
        )
    except UndefinedTableError:
        return


@router.get("/migration/manifest")
async def export_files_migration_manifest(
    user_id: str = Depends(require_firebase_auth),
) -> JSONResponse:
    """Export sealed Shared Files & Wiki manifest for browser-side ACE migration."""
    resolved = await _migration_row(user_id)
    if resolved is None:
        return _response({"status": "empty", "folders": [], "files": [], "wiki_pages": []})
    store, row = resolved
    receipt = _migration_receipt(row)
    ace_migration = receipt.get("ace_migration")
    if isinstance(ace_migration, dict) and ace_migration.get("status") == "migrated":
        return _response(
            {
                "status": "migrated",
                "libraryId": str(row["library_id"]),
                "folders": [],
                "files": [],
                "wiki_pages": [],
            }
        )
    await _security(store, row)
    objects = await _list_library_objects(store)
    envelope_bytes, envelope_gen = await store.get_bounded_with_generation(
        _ZERO_ENVELOPE, max_bytes=MAX_CIPHERTEXT_BYTES
    )
    if not objects and envelope_bytes is None:
        return _response(
            {
                "status": "empty",
                "libraryId": str(row["library_id"]),
                "folders": [],
                "files": [],
                "wiki_pages": [],
            }
        )
    folders: list[dict[str, Any]] = []
    files: list[dict[str, Any]] = []
    wiki_pages: list[dict[str, Any]] = []
    for rel in objects:
        if rel == _ZERO_ENVELOPE:
            continue
        if rel.startswith("folders/"):
            blob, gen = await store.get_bounded_with_generation(rel, max_bytes=MAX_CIPHERTEXT_BYTES)
            if blob is not None:
                folders.append(
                    {
                        "id": rel.removeprefix("folders/").removesuffix(".json"),
                        "path": rel,
                        "ciphertext": base64.b64encode(blob).decode(),
                        "generation": gen,
                    }
                )
        elif rel.startswith("files/"):
            blob, gen = await store.get_bounded_with_generation(rel, max_bytes=MAX_CIPHERTEXT_BYTES)
            if blob is not None:
                files.append(
                    {
                        "id": rel.removeprefix("files/").removesuffix(".json"),
                        "path": rel,
                        "ciphertext": base64.b64encode(blob).decode(),
                        "generation": gen,
                    }
                )
        elif rel.startswith("wiki/"):
            blob, gen = await store.get_bounded_with_generation(rel, max_bytes=MAX_CIPHERTEXT_BYTES)
            if blob is not None:
                wiki_pages.append(
                    {
                        "page_id": rel.removeprefix("wiki/").removesuffix(".json"),
                        "path": rel,
                        "ciphertext": base64.b64encode(blob).decode(),
                        "generation": gen,
                    }
                )
    payload: dict[str, Any] = {
        "status": "ready",
        "libraryId": str(row["library_id"]),
        "folders": folders,
        "files": files,
        "wiki_pages": wiki_pages,
        "objects": objects,
    }
    if envelope_bytes is not None:
        payload["keyEnvelope"] = {
            "ciphertext": base64.b64encode(envelope_bytes).decode(),
            "generation": envelope_gen,
        }
    return _response(payload)


@router.get("/migration/wiki/{page_id}")
async def export_wiki_migration_page(
    page_id: str,
    namespace: str | None = Query(default=None),
    object_id: str | None = Query(default=None),
    user_id: str = Depends(require_firebase_auth),
) -> JSONResponse:
    """Return sealed Shared Wiki page ciphertext for unlocked browser migration."""
    if not _MIGRATION_ID.fullmatch(page_id):
        raise _refuse("FILES_OBJECT_INVALID", 400)
    resolved = await _migration_row(user_id)
    if resolved is None:
        raise _refuse("FILES_NOT_FOUND", 404)
    store, row = resolved
    await _security(store, row)
    if namespace is not None or object_id is not None:
        if namespace is None or object_id is None:
            raise _refuse("FILES_OBJECT_INVALID", 400)
        candidates: tuple[str, ...] = (_identifier(namespace) + "/" + _identifier(object_id),)
    else:
        candidates = (f"wiki/{page_id}", f"wiki/{page_id}.json", f"wiki/pages/{page_id}")
    data, generation = await _read_bounded_migration_object(store, candidates)
    if data is None:
        raise _refuse("FILES_NOT_FOUND", 404)
    return _response(
        {
            "page_id": page_id,
            "ciphertext": base64.b64encode(data).decode(),
            "generation": generation,
        }
    )


@router.get("/migration/file/{file_id}/chunk/{index}")
async def export_file_migration_chunk(
    file_id: str,
    index: int,
    namespace: str | None = Query(default=None),
    object_id: str | None = Query(default=None),
    user_id: str = Depends(require_firebase_auth),
) -> JSONResponse:
    """Return opaque encrypted chunk bytes/JSON from HUSSH_SHARED_FILES_BUCKET."""
    if not _MIGRATION_ID.fullmatch(file_id) or index < 0:
        raise _refuse("FILES_OBJECT_INVALID", 400)
    resolved = await _migration_row(user_id)
    if resolved is None:
        raise _refuse("FILES_NOT_FOUND", 404)
    store, row = resolved
    await _security(store, row)
    if namespace is not None or object_id is not None:
        if namespace is None or object_id is None:
            raise _refuse("FILES_OBJECT_INVALID", 400)
        candidates: tuple[str, ...] = (_identifier(namespace) + "/" + _identifier(object_id),)
    else:
        candidates = (
            f"chunks/{file_id}/{index}",
            f"chunks/{file_id}/{index:012d}.bin",
            f"files/{file_id}/chunks/{index}",
        )
    data, generation = await _read_bounded_migration_object(store, candidates)
    if data is None:
        raise _refuse("FILES_NOT_FOUND", 404)
    return _response(
        {
            "file_id": file_id,
            "index": index,
            "ciphertext": base64.b64encode(data).decode(),
            "generation": generation,
        }
    )


@router.post("/migration/complete")
async def complete_files_migration(
    payload: FilesMigrationCompleteRequest,
    user_id: str = Depends(require_firebase_auth),
) -> JSONResponse:
    """Idempotently record Shared->ACE Files & Wiki migration completion."""
    await _mark_ace_migration_complete(
        user_id,
        migrated_files=payload.migrated_files,
        migrated_wiki_pages=payload.migrated_wiki_pages,
    )
    return _response(
        {
            "status": "migrated",
            "migrated_files": payload.migrated_files,
            "migrated_wiki_pages": payload.migrated_wiki_pages,
        }
    )
