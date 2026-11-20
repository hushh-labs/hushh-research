"""Paginated object adapters for the Files prefix, using existing pod credentials."""

from __future__ import annotations

import asyncio
import os
import time
from typing import Any

from hushh_mcp.services.pod_commit_log import GcsObjectStore, LocalObjectStore, object_key_segments
from hushh_mcp.services.pod_emulator_endpoints import resolve_gcp_storage_origin
from hushh_mcp.services.pod_s3_object_store import (
    PREFIX_TOKEN_URL_ENV,
    PodMultiCloudStorageError,
    PrefixTokenObjectStore,
)


class FilesGcsStore(GcsObjectStore):
    _security_checked_at = 0.0
    _retention: dict[str, Any] | None = None

    async def verify_bucket(self, kms_key: str) -> dict[str, Any]:
        """Fail closed on custody changes; never edit lifecycle or recovery prefixes."""
        from hushh_mcp.services.pod_files.library import FilesRefused

        if not kms_key:
            raise FilesRefused("FILES_BUCKET_CUSTODY_UNVERIFIED", 503)
        if self._retention is not None and time.monotonic() - self._security_checked_at < 60:
            return self._retention
        origin, _ = resolve_gcp_storage_origin()
        response = await asyncio.to_thread(
            self._object_get, f"{origin}/storage/v1/b/{self._bucket}", {}, 30
        )
        if response.status_code != 200:
            raise FilesRefused("FILES_BUCKET_CUSTODY_UNVERIFIED", 503)
        value = response.json()
        from hushh_mcp.services.pod_files.provisioning import bucket_matches

        if not bucket_matches(value, bucket=self._bucket, kms_key=kms_key):
            raise FilesRefused("FILES_BUCKET_CUSTODY_UNVERIFIED", 503)
        # The owning bootstrap proves project membership. This check establishes
        # current encryption and access settings, not an erasure receipt.
        self._retention = {
            "retentionSeconds": int((value.get("retentionPolicy") or {}).get("retentionPeriod", 0)),
            "retentionLocked": bool((value.get("retentionPolicy") or {}).get("isLocked")),
            "softDeleteSeconds": int(
                (value.get("softDeletePolicy") or {}).get("retentionDurationSeconds", 0)
            ),
            "versioning": bool((value.get("versioning") or {}).get("enabled")),
            "physicalDeletion": "not_requested_by_trash",
        }
        self._security_checked_at = time.monotonic()
        return self._retention

    async def list_page(
        self, prefix: str, cursor: str = "", limit: int = 100
    ) -> tuple[list[str], str]:
        if not 1 <= limit <= 100:
            raise ValueError("invalid page size")
        root = self._key(prefix) + "/"
        params = {"prefix": root, "maxResults": str(limit), "fields": "items(name),nextPageToken"}
        if cursor:
            params["pageToken"] = cursor
        origin, _ = resolve_gcp_storage_origin()
        response = await asyncio.to_thread(
            self._object_get,
            f"{origin}/storage/v1/b/{self._bucket}/o",
            params,
            30,
        )
        if response.status_code != 200:
            raise RuntimeError("Files listing unavailable")
        body: dict[str, Any] = response.json()
        names = []
        for entry in body.get("items", []):
            name = entry.get("name", "")
            if not name.startswith(root):
                raise RuntimeError("Files listing escaped prefix")
            relative = name[len(self._prefix) + 1 :] if self._prefix else name
            object_key_segments(relative)
            names.append(relative)
        return names, str(body.get("nextPageToken") or "")


class FilesLocalStore(LocalObjectStore):
    """Local durable test/development adapter; generation sidecars are not entries."""

    async def list_page(
        self, prefix: str, cursor: str = "", limit: int = 100
    ) -> tuple[list[str], str]:
        object_key_segments(prefix)
        if not 1 <= limit <= 100:
            raise ValueError("invalid page size")
        directory = self._root.joinpath(*object_key_segments(prefix))

        def read() -> tuple[list[str], str]:
            names = sorted(
                str(p.relative_to(self._root)) for p in directory.glob("*.bin") if p.is_file()
            )
            page = [name for name in names if name > cursor][: limit + 1]
            return page[:limit], page[limit - 1] if len(page) > limit else ""

        return await asyncio.to_thread(read)


class FilesPrefixStore(PrefixTokenObjectStore):
    """Prefix-scoped Hub gateway storage adapter for Files/Wiki/Workspaces on pooled ACE pods."""

    def __init__(self, prefix_url: str, *, subprefix: str = "", **kwargs: Any) -> None:
        super().__init__(prefix_url, **kwargs)
        cleaned = subprefix.strip("/")
        self._subprefix = "/".join(object_key_segments(cleaned)) if cleaned else ""
        self._security_checked_at = 0.0
        self._retention: dict[str, Any] | None = None

    def _scoped_key(self, key: str) -> str:
        clean_key = str(key or "").lstrip("/")
        if not self._subprefix:
            return clean_key
        return f"{self._subprefix}/{clean_key}" if clean_key else self._subprefix

    def _strip_subprefix(self, rel: str) -> str:
        if not self._subprefix:
            return rel
        marker = f"{self._subprefix}/"
        if rel.startswith(marker):
            return rel[len(marker) :]
        return rel

    def _url(self, key: str) -> str:
        return super()._url(self._scoped_key(key))

    async def verify_bucket(self, kms_key: str) -> dict[str, Any]:
        """Confirm Hub-brokered prefix storage and custody mode before workspace/Files access."""
        from hushh_mcp.services.pod_files.library import FilesRefused

        custody = (os.getenv("HUSSH_POD_CUSTODY_MODE") or "").strip().lower()
        prefix_url = (os.getenv(PREFIX_TOKEN_URL_ENV) or "").strip()
        if custody != "hub_broker" or kms_key != "hub_broker" or not prefix_url:
            raise FilesRefused("FILES_BUCKET_CUSTODY_UNVERIFIED", 503)
        if self._retention is not None and time.monotonic() - self._security_checked_at < 60:
            return self._retention
        try:
            await asyncio.to_thread(self._current_token)
        except PodMultiCloudStorageError as exc:
            raise FilesRefused("FILES_BUCKET_CUSTODY_UNVERIFIED", 503) from exc
        self._retention = {
            "custodyMode": "hub_broker",
            "physicalDeletion": "prefix_gateway",
            "versioning": True,
        }
        self._security_checked_at = time.monotonic()
        return self._retention

    def list_page_blocking(
        self, prefix: str, cursor: str = "", limit: int = 100
    ) -> tuple[list[str], str]:
        scoped_prefix = self._scoped_key(prefix)
        scoped_cursor = self._scoped_key(cursor) if cursor and self._subprefix else cursor
        url = super()._url(scoped_prefix)
        if not 1 <= limit <= 100 or len(scoped_cursor) > 4096:
            raise ValueError("invalid page request")
        response = self._request(
            "get",
            url,
            {},
            params={"list": "1", "cursor": scoped_cursor, "limit": str(limit)},
        )
        try:
            status = getattr(response, "status_code", 0)
            if status == 404:
                return [], ""
            if status != 200:
                raise PodMultiCloudStorageError("prefix object store listing failed")
            payload = response.json()
            if not isinstance(payload, dict):
                raise PodMultiCloudStorageError("prefix object store listing malformed")
            root_rel = "/".join(object_key_segments(scoped_prefix)) + "/"
            names: list[str] = []
            for raw_item in payload.get("items") or []:
                rel = str(raw_item or "")
                if not rel.startswith(root_rel) or len(names) >= limit:
                    raise PodMultiCloudStorageError("prefix listing escaped prefix or page bound")
                object_key_segments(rel)
                names.append(self._strip_subprefix(rel))
            next_cursor = self._strip_subprefix(str(payload.get("cursor") or ""))
            if len(next_cursor) > 4096:
                raise PodMultiCloudStorageError("prefix listing cursor invalid")
            return names, next_cursor
        finally:
            response.close()
