# SPDX-License-Identifier: Apache-2.0
# SPDX-FileCopyrightText: 2026 Hushh
"""Zero-role Hub ciphertext storage gateway (``PrefixTokenObjectStore`` wire server, #9744).

Admits pooled single-use sandboxes bearing Hub-minted ``hpst1`` prefix bearer
tokens (via ``POST /api/one/pod/custody/storage-token``) and translates scoped
HTTP CAS operations into GCS JSON API or local-disk CAS operations using ONLY
the Hub's storage authority. Sandboxes hold zero cloud storage IAM roles.
"""

from __future__ import annotations

import asyncio
import logging
import time
import urllib.parse
from pathlib import Path
from typing import Any, Callable

from fastapi import APIRouter, Header, Query, Request, Response

from hushh_mcp.runtime_settings import (
    personal_agent_enabled,
    pod_storage_gateway_gcs_bucket,
    pod_storage_gateway_gcs_prefix,
    pod_storage_gateway_local_root,
)
from hushh_mcp.services.personal_agent_registry_repo import PersonalAgentRegistryRepo
from hushh_mcp.services.pod_capability_broker import (
    PodCapabilityBrokerForbidden,
    PodCapabilityBrokerUnauthorized,
    validated_pod_prefix,
    verify_prefix_gateway_token,
)
from hushh_mcp.services.pod_commit_log import (
    GcsObjectStore,
    LocalObjectStore,
    object_key_segments,
    object_prefix_segments,
)
from hushh_mcp.services.pod_object_version import ABSENT, ObjectVersion, is_object_version

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/one/pod/storage-gateway", tags=["personal-agent"])

_MAX_OBJECT_BYTES = 16 * 1024 * 1024
_DEFAULT_STORE_FACTORY: Callable[[], Any] | None = None
_DEFAULT_REGISTRY_FACTORY: Callable[[], Any] | None = None
_READ_ADMISSION_TTL_S = 5.0
_READ_ADMISSION_CACHE: dict[tuple[str, str, int], float] = {}


def set_storage_gateway_overrides_for_tests(
    *,
    store_factory: Callable[[], Any] | None = None,
    registry_factory: Callable[[], Any] | None = None,
) -> None:
    """Inject mock backing store / registry cleanly in unit tests."""
    global _DEFAULT_STORE_FACTORY, _DEFAULT_REGISTRY_FACTORY
    _DEFAULT_STORE_FACTORY = store_factory
    _DEFAULT_REGISTRY_FACTORY = registry_factory
    _READ_ADMISSION_CACHE.clear()


def _resolve_store() -> Any | None:
    if _DEFAULT_STORE_FACTORY is not None:
        return _DEFAULT_STORE_FACTORY()
    bucket = pod_storage_gateway_gcs_bucket()
    if bucket:
        prefix = pod_storage_gateway_gcs_prefix()
        return GcsObjectStore(bucket, prefix=prefix)
    local_root = pod_storage_gateway_local_root()
    if local_root:
        return LocalObjectStore(Path(local_root))
    return None


def _resolve_registry() -> Any:
    if _DEFAULT_REGISTRY_FACTORY is not None:
        return _DEFAULT_REGISTRY_FACTORY()
    return PersonalAgentRegistryRepo()


def _format_etag(version: ObjectVersion) -> str:
    cleaned = str(version or "").strip().strip('"')
    return f'"{cleaned}"'


def _parse_if_match(raw: str | None) -> ObjectVersion | None:
    if raw is None:
        return None
    cleaned = str(raw).strip().strip('"')
    if not is_object_version(cleaned):
        return None
    return cleaned


async def _authorize_gateway_request(
    *,
    object_path: str,
    authorization: str | None,
    allow_cached_admission: bool = False,
) -> tuple[str, dict[str, Any]] | Response:
    if not personal_agent_enabled():
        return Response(status_code=404, content=b"not found")
    clean_path = urllib.parse.unquote(object_path).strip("/")
    if not clean_path:
        return Response(status_code=403, content=b"forbidden prefix")

    auth = str(authorization or "")
    if not auth.startswith("Bearer ") or not auth[7:].strip():
        return Response(status_code=401, content=b"missing bearer")
    token = auth[7:].strip()

    try:
        claims = verify_prefix_gateway_token(token, object_path=clean_path)
    except PodCapabilityBrokerUnauthorized:
        return Response(status_code=401, content=b"unauthorized token")
    except PodCapabilityBrokerForbidden:
        return Response(status_code=403, content=b"forbidden prefix")

    hushh_id = str(claims.get("hushh_id") or "")
    owner_id = str(claims.get("owner_id") or "")
    try:
        token_epoch = int(claims.get("epoch", -1))
    except (TypeError, ValueError):
        return Response(status_code=403, content=b"invalid token epoch")

    cache_key = (owner_id, hushh_id, token_epoch)
    now_mono = time.monotonic()
    if allow_cached_admission and _DEFAULT_REGISTRY_FACTORY is None:
        cached_until = _READ_ADMISSION_CACHE.get(cache_key, 0.0)
        if cached_until > now_mono:
            return clean_path, claims

    registry = _resolve_registry()
    tombstone_fn = getattr(registry, "tombstone_exists", None)
    if callable(tombstone_fn) and await tombstone_fn(owner_id):
        _READ_ADMISSION_CACHE.pop(cache_key, None)
        return Response(status_code=403, content=b"owner tombstoned")

    row = await registry.get_by_hushh_id(hushh_id)
    if not isinstance(row, dict) or str(row.get("user_id") or "") != owner_id:
        _READ_ADMISSION_CACHE.pop(cache_key, None)
        return Response(status_code=403, content=b"unknown pod")

    raw_meta = row.get("backend_metadata")
    meta: dict[str, Any] = raw_meta if isinstance(raw_meta, dict) else {}
    if "erasure" in meta:
        _READ_ADMISSION_CACHE.pop(cache_key, None)
        return Response(status_code=403, content=b"pod fenced for erasure")

    live_epoch = int(row.get("placement_epoch") or 0)
    if live_epoch != token_epoch:
        _READ_ADMISSION_CACHE.pop(cache_key, None)
        return Response(status_code=403, content=b"stale placement epoch")

    if _DEFAULT_REGISTRY_FACTORY is None:
        if len(_READ_ADMISSION_CACHE) > 2048:
            _READ_ADMISSION_CACHE.clear()
        _READ_ADMISSION_CACHE[cache_key] = now_mono + _READ_ADMISSION_TTL_S

    return clean_path, claims


async def _list_prefix_items(
    store: Any,
    *,
    pod_prefix: str,
    target_prefix: str,
    cursor: str,
    limit: int,
) -> tuple[list[str], str]:
    base_prefix_with_slash = pod_prefix.rstrip("/") + "/"
    rel_prefix = (
        target_prefix[len(base_prefix_with_slash) :]
        if target_prefix.startswith(base_prefix_with_slash)
        else ""
    )
    rel_filter_prefix = (rel_prefix.rstrip("/") + "/") if rel_prefix.rstrip("/") else ""

    if isinstance(store, LocalObjectStore):
        target_dir = store._root.joinpath(*object_key_segments(target_prefix)).resolve()
        root_resolved = store._root.resolve()
        if root_resolved not in target_dir.parents and target_dir != root_resolved:
            raise ValueError("list prefix escapes root")
        pod_dir = root_resolved.joinpath(*object_prefix_segments(pod_prefix)).resolve()
        all_rel: list[str] = []
        if target_dir.is_dir():
            for item in target_dir.rglob("*"):
                if not item.is_file():
                    continue
                if (
                    item.name in {".lock", store._JOURNAL}
                    or item.name.endswith(".gen")
                    or item.name.startswith(".object-write-")
                ):
                    continue
                rel = item.resolve().relative_to(pod_dir).as_posix()
                if not rel_filter_prefix or rel.startswith(rel_filter_prefix):
                    all_rel.append(rel)
        all_rel.sort()
        filtered = [r for r in all_rel if not cursor or r > cursor]
        sliced = filtered[:limit]
        next_cursor = sliced[-1] if len(filtered) > limit and sliced else ""
        return sliced, next_cursor

    if isinstance(store, GcsObjectStore):

        def _gcs_list() -> tuple[list[str], str]:
            store_prefix = f"{store._prefix}/" if store._prefix else ""
            gcs_prefix = f"{store_prefix}{target_prefix.rstrip('/')}/"
            collected: list[str] = []
            page_token = ""
            while True:
                params: dict[str, str] = {"prefix": gcs_prefix, "maxResults": "1000"}
                if page_token:
                    params["pageToken"] = page_token
                resp = store._object_get(
                    f"{store._storage_origin}/storage/v1/b/{store._bucket}/o",
                    params,
                    30,
                )
                status = getattr(resp, "status_code", 0)
                if status == 404:
                    break
                if status != 200:
                    raise RuntimeError("gcs prefix listing failed")
                body = resp.json()
                for entry in body.get("items") or []:
                    full_name = str((entry or {}).get("name") or "")
                    if store_prefix:
                        if not full_name.startswith(store_prefix):
                            continue
                        full_name = full_name[len(store_prefix) :]
                    if not full_name.startswith(base_prefix_with_slash):
                        continue
                    rel = full_name[len(base_prefix_with_slash) :]
                    if (not rel_filter_prefix or rel.startswith(rel_filter_prefix)) and (
                        not cursor or rel > cursor
                    ):
                        collected.append(rel)
                page_token = str(body.get("nextPageToken") or "")
                if not page_token or len(collected) > limit:
                    break
            collected.sort()
            sliced = collected[:limit]
            next_cursor = sliced[-1] if (len(collected) > limit or page_token) and sliced else ""
            return sliced, next_cursor

        return await asyncio.to_thread(_gcs_list)

    list_fn = getattr(store, "list_keys_under_prefix", None)
    if callable(list_fn):
        keys = sorted(await list_fn(target_prefix.rstrip("/") + "/"))
        rels = [
            k[len(base_prefix_with_slash) :] for k in keys if k.startswith(base_prefix_with_slash)
        ]
        filtered = [
            r
            for r in rels
            if (not rel_filter_prefix or r.startswith(rel_filter_prefix))
            and (not cursor or r > cursor)
        ]
        sliced = filtered[:limit]
        next_cursor = sliced[-1] if len(filtered) > limit and sliced else ""
        return sliced, next_cursor

    return [], ""


@router.get("/{object_path:path}")
async def gateway_get_or_list(
    object_path: str,
    authorization: str | None = Header(default=None),
    list_flag: str | None = Query(default=None, alias="list"),
    cursor: str = Query(default="", max_length=4096),
    limit: int = Query(default=100, ge=1, le=100),
) -> Response:
    auth_res = await _authorize_gateway_request(
        object_path=object_path,
        authorization=authorization,
        allow_cached_admission=True,
    )
    if isinstance(auth_res, Response):
        return auth_res
    clean_path, claims = auth_res
    store = _resolve_store()
    if store is None:
        return Response(status_code=503, content=b"storage gateway unconfigured")

    pod_prefix = validated_pod_prefix(claims["hushh_id"])
    if list_flag == "1":
        try:
            items, next_cursor = await _list_prefix_items(
                store,
                pod_prefix=pod_prefix,
                target_prefix=clean_path,
                cursor=cursor,
                limit=limit,
            )
        except ValueError:
            return Response(status_code=403, content=b"invalid list prefix")
        import json  # noqa: PLC0415

        return Response(
            content=json.dumps({"items": items, "cursor": next_cursor}).encode("utf-8"),
            status_code=200,
            media_type="application/json",
        )

    try:
        object_key_segments(clean_path)
    except ValueError:
        return Response(status_code=400, content=b"invalid object key")

    data, version = await store.get_with_generation(clean_path)
    if data is None or version == ABSENT:
        return Response(status_code=404, content=b"")
    return Response(
        content=data,
        status_code=200,
        media_type="application/octet-stream",
        headers={"ETag": _format_etag(version)},
    )


@router.put("/{object_path:path}")
async def gateway_put(
    object_path: str,
    request: Request,
    authorization: str | None = Header(default=None),
    if_none_match: str | None = Header(default=None, alias="If-None-Match"),
    if_match: str | None = Header(default=None, alias="If-Match"),
) -> Response:
    auth_res = await _authorize_gateway_request(
        object_path=object_path, authorization=authorization
    )
    if isinstance(auth_res, Response):
        return auth_res
    clean_path, _claims = auth_res
    store = _resolve_store()
    if store is None:
        return Response(status_code=503, content=b"storage gateway unconfigured")

    try:
        object_key_segments(clean_path)
    except ValueError:
        return Response(status_code=400, content=b"invalid object key")

    body = await request.body()
    if len(body) > _MAX_OBJECT_BYTES:
        return Response(status_code=413, content=b"object too large")

    if if_none_match == "*":
        new_version = await store.put_if_generation(clean_path, body, ABSENT)
        if new_version is None:
            return Response(status_code=409, content=b"conflict")
        return Response(status_code=201, content=b"", headers={"ETag": _format_etag(new_version)})

    if if_match is not None:
        expected = _parse_if_match(if_match)
        if expected is None:
            return Response(status_code=400, content=b"malformed If-Match")
        current, cur_version = await store.get_with_generation(clean_path)
        if current is None or cur_version == ABSENT:
            return Response(status_code=404, content=b"absent")
        if cur_version.strip('"') != expected.strip('"'):
            return Response(status_code=412, content=b"precondition failed")
        new_version = await store.put_if_generation(clean_path, body, cur_version)
        if new_version is None:
            return Response(status_code=412, content=b"precondition failed")
        return Response(status_code=201, content=b"", headers={"ETag": _format_etag(new_version)})

    for _attempt in range(3):
        _, cur_version = await store.get_with_generation(clean_path)
        new_version = await store.put_if_generation(clean_path, body, cur_version)
        if new_version is not None:
            return Response(
                status_code=201, content=b"", headers={"ETag": _format_etag(new_version)}
            )
    return Response(status_code=409, content=b"concurrent write conflict")


@router.delete("/{object_path:path}")
async def gateway_delete(
    object_path: str,
    authorization: str | None = Header(default=None),
) -> Response:
    auth_res = await _authorize_gateway_request(
        object_path=object_path, authorization=authorization
    )
    if isinstance(auth_res, Response):
        return auth_res
    clean_path, _claims = auth_res
    store = _resolve_store()
    if store is None:
        return Response(status_code=503, content=b"storage gateway unconfigured")

    try:
        object_key_segments(clean_path)
    except ValueError:
        return Response(status_code=400, content=b"invalid object key")

    existed = await store.delete(clean_path)
    return Response(status_code=204 if existed else 404, content=b"")
