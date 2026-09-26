"""Paginated object adapters for the Files prefix, using existing pod credentials."""

from __future__ import annotations

import asyncio
import time
from typing import Any

from hushh_mcp.services.pod_commit_log import GcsObjectStore, LocalObjectStore, object_key_segments


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
        response = await asyncio.to_thread(
            self._object_get, f"https://storage.googleapis.com/storage/v1/b/{self._bucket}", {}, 30
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
        response = await asyncio.to_thread(
            self._object_get,
            f"https://storage.googleapis.com/storage/v1/b/{self._bucket}/o",
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
