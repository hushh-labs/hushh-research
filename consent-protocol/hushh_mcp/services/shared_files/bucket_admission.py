"""Bind Shared ciphertext to one observed bucket incarnation before any write.

An unchanged creation-time disabled policy can establish no soft-delete history
only for that retained incarnation. A same-name replacement is never evidence.
"""

from __future__ import annotations

import asyncio
import json
from typing import Any
from urllib.parse import quote

from hushh_mcp.services.byoc_substrate import _bucket_creation_identity
from hushh_mcp.services.pod_commit_log import GcsObjectStore
from hushh_mcp.services.pod_files.contracts import FilesRefused


async def observe(store: GcsObjectStore, bucket: str) -> dict[str, Any]:
    response = await asyncio.to_thread(
        store._object_get,
        f"https://storage.googleapis.com/storage/v1/b/{quote(bucket, safe='')}",
        {},
        20,
    )
    if response.status_code != 200:
        raise FilesRefused("FILES_STORAGE_IDENTITY_UNVERIFIED", 503)
    value = response.json()
    if not isinstance(value, dict):
        raise FilesRefused("FILES_STORAGE_IDENTITY_UNVERIFIED", 503)
    identity = _bucket_creation_identity(value, bucket)
    iam = value.get("iamConfiguration")
    if not isinstance(iam, dict):
        raise FilesRefused("FILES_STORAGE_IDENTITY_UNVERIFIED", 503)
    uniform = iam.get("uniformBucketLevelAccess")
    if (
        identity is None
        or iam.get("publicAccessPrevention") != "enforced"
        or not isinstance(uniform, dict)
        or uniform.get("enabled") is not True
    ):
        raise FilesRefused("FILES_STORAGE_IDENTITY_UNVERIFIED", 503)
    return value


def admission(value: dict[str, Any], bucket: str) -> dict[str, Any]:
    identity = _bucket_creation_identity(value, bucket)
    if identity is None:
        raise FilesRefused("FILES_STORAGE_IDENTITY_UNVERIFIED", 503)
    return {"identity": identity, "noSoftDeleteHistory": no_history(value)}


def no_history(value: dict[str, Any]) -> bool:
    policy = value.get("softDeletePolicy")
    disabled = policy is None or (
        isinstance(policy, dict) and policy.get("retentionDurationSeconds") == "0"
    )
    return value.get("metageneration") == "1" and disabled


def verify(row: dict[str, Any], value: dict[str, Any]) -> dict[str, Any]:
    identity = _bucket_creation_identity(value, row["bucket"])
    retained = row.get("bucket_admission")
    if isinstance(retained, str):
        retained = json.loads(retained)
    if (
        identity is None
        or not isinstance(retained, dict)
        or set(retained) != {"identity", "noSoftDeleteHistory"}
        or not isinstance(retained["noSoftDeleteHistory"], bool)
        or retained["identity"] != identity
    ):
        raise FilesRefused("FILES_STORAGE_IDENTITY_CHANGED", 409)
    return retained
