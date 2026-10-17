"""Bounded provider deletion; retained objects keep owner erasure incomplete."""

from __future__ import annotations

import asyncio
from typing import Any
from urllib.parse import quote

from hushh_mcp.services.pod_commit_log import GcsObjectStore
from hushh_mcp.services.pod_files.contracts import FilesRefused

from . import bucket_admission


async def erase_objects(
    store: GcsObjectStore, bucket: str, prefix: str, row: dict[str, Any]
) -> dict[str, str]:
    url = f"https://storage.googleapis.com/storage/v1/b/{quote(bucket, safe='')}/o"
    before = await bucket_admission.observe(store, bucket)
    retained = bucket_admission.verify(row, before)

    async def listing(*, soft_deleted: bool = False) -> list[dict[str, Any]]:
        params = {
            "prefix": prefix,
            "maxResults": "12",
            "fields": "items(name,generation),nextPageToken",
        }
        params["softDeleted" if soft_deleted else "versions"] = "true"
        response = await asyncio.to_thread(store._object_get, url, params, 20)
        if response.status_code != 200:
            raise FilesRefused("FILES_ERASURE_LIST_UNCONFIRMED", 409)
        body = response.json()
        items = body.get("items", [])
        if body.get("nextPageToken") and not items:
            raise FilesRefused("FILES_ERASURE_LIST_UNCONFIRMED", 409)
        if not isinstance(items, list) or len(items) > 12:
            raise FilesRefused("FILES_ERASURE_LIST_INVALID", 409)
        for item in items:
            if (
                not str(item.get("name", "")).startswith(prefix)
                or not str(item.get("generation", "")).isdigit()
            ):
                raise FilesRefused("FILES_ERASURE_OBJECT_INVALID", 409)
        return items

    page = await listing()
    limiter = asyncio.Semaphore(4)

    async def remove(item: dict[str, Any]) -> None:
        async with limiter:
            generation = str(item["generation"])
            target = url + "/" + quote(item["name"], safe="")

            def execute(headers: dict[str, str]) -> Any:
                return store._session.delete(
                    target,
                    headers=headers,
                    params={"generation": generation, "ifGenerationMatch": generation},
                    timeout=20,
                    allow_redirects=False,
                )

            response = await asyncio.to_thread(store._authorized, execute)
            if response.status_code not in {204, 404}:
                raise FilesRefused("FILES_ERASURE_DELETE_UNCONFIRMED", 409)

    await asyncio.gather(*(remove(item) for item in page))
    if await listing():
        raise FilesRefused("FILES_ERASURE_IN_PROGRESS", 409)
    qualified_disabled = retained["noSoftDeleteHistory"] and bucket_admission.no_history(before)
    if not qualified_disabled and await listing(soft_deleted=True):
        raise FilesRefused("FILES_ERASURE_RETENTION_PENDING", 409)
    after = await bucket_admission.observe(store, bucket)
    bucket_admission.verify(row, after)
    if qualified_disabled and not bucket_admission.no_history(after):
        raise FilesRefused("FILES_ERASURE_RETENTION_UNCONFIRMED", 409)
    return dict(retained["identity"])
