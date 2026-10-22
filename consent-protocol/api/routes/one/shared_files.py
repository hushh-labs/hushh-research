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
from functools import lru_cache
from typing import Any

from asyncpg import UndefinedTableError
from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import JSONResponse

from hushh_mcp.services.owner_placement_guard import admit_hub_content, hub_content_owner
from hushh_mcp.services.pod_files.contracts import FilesRefused
from hushh_mcp.services.pod_object_version import decimal_generation
from hushh_mcp.services.shared_files import bucket_admission, registry, writes
from hushh_mcp.services.shared_files.uploads import SharedCipherStore

router = APIRouter(prefix="/api/one/files", tags=["Files ciphertext"])
MAX_CIPHERTEXT_BYTES = 4 * 1024 * 1024 + 128 * 1024
MAX_REQUEST_BYTES = (MAX_CIPHERTEXT_BYTES * 4 // 3) + 1024
_OPAQUE = re.compile(r"^[a-f0-9]{64}$")


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
    from api.middleware import require_vault_owner_token  # noqa: PLC0415

    current = await require_vault_owner_token(
        authorization=request.headers.get("authorization"),
        hushh_consent=request.headers.get("x-hushh-consent"),
    )
    if current["user_id"] != owner:
        raise _refuse("FILES_OWNER_CHANGED", 403)
    await admit_hub_content(owner, "shared_files")


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
async def configuration(request: Request, token: dict = Depends(hub_content_owner)) -> JSONResponse:
    store, row = await _store(token["user_id"], request.headers.get("x-files-library-id"))
    from hushh_mcp.services.shared_files.reconciliation import reconcile  # noqa: PLC0415

    await reconcile(row)
    retention = await _security(store, row)
    await _fresh_owner(request, token["user_id"])
    await _active(token["user_id"], str(row["library_id"]))
    await _fresh_owner(request, token["user_id"])
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
    namespace: str, request: Request, cursor: str = "", token: dict = Depends(hub_content_owner)
) -> JSONResponse:
    if len(cursor) > 2048:
        raise _refuse("FILES_CURSOR_INVALID", 400)
    store, row = await _store(token["user_id"], request.headers.get("x-files-library-id"))
    await _security(store, row)
    paths, next_cursor = await store.list_page(_identifier(namespace), cursor, 100)
    keys = [_identifier(path.rsplit("/", 1)[-1]) for path in paths]
    await _fresh_owner(request, token["user_id"])
    await _active(token["user_id"], str(row["library_id"]))
    return _response({"keys": keys, "cursor": next_cursor})


@router.get("/objects/{namespace}/{object_id}")
async def read_object(
    namespace: str, object_id: str, request: Request, token: dict = Depends(hub_content_owner)
) -> JSONResponse:
    store, row = await _store(token["user_id"], request.headers.get("x-files-library-id"))
    await _security(store, row)
    data, generation = await store.get_bounded_with_generation(
        _identifier(namespace) + "/" + _identifier(object_id), max_bytes=MAX_CIPHERTEXT_BYTES
    )
    await _fresh_owner(request, token["user_id"])
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
