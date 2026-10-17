"""Files objects in the owner's Azure container; ciphertext and opaque names only."""

from __future__ import annotations

import asyncio
import json
import re
import time
from typing import Any

from defusedxml.ElementTree import fromstring

from hushh_mcp.services.pod_azure_blob_store import (
    AzureBlobObjectStore,
    PodBlobStorageError,
    _etag,
)
from hushh_mcp.services.pod_bounded_object import read_bounded_response
from hushh_mcp.services.pod_commit_log import object_key_segments
from hushh_mcp.services.pod_object_version import ABSENT, ObjectVersion

from .contracts import CHUNK_BYTES, FilesRefused

_ARM = "https://management.azure.com"
_ACCOUNT_ID = re.compile(
    r"/subscriptions/[0-9a-fA-F-]{36}/resourceGroups/[A-Za-z0-9_.()-]{1,90}"
    r"/providers/Microsoft.Storage/storageAccounts/([a-z0-9]{3,24})"
)


class FilesAzureStore(AzureBlobObjectStore):
    """Use the existing Blob CAS adapter and verify current custody before access."""

    def __init__(self, container_url: str, *, account_id: str, **kwargs: Any):
        super().__init__(container_url, **kwargs)
        match = _ACCOUNT_ID.fullmatch(account_id)
        if not match or self._location.account_url != (
            f"https://{match.group(1)}.blob.core.windows.net"
        ):
            raise FilesRefused("FILES_BUCKET_CUSTODY_UNVERIFIED", 503)
        self._account_id = account_id
        self._security_checked_at = 0.0
        self._retention: dict[str, Any] | None = None

    def get_with_generation_blocking(self, key: str) -> tuple[bytes | None, ObjectVersion]:
        response = self._send("get", self._url(key), {"Accept-Encoding": "identity"}, stream=True)
        if response.status_code == 404:
            # Do not materialize an unbounded error body to classify absence.
            absent = response.headers.get("x-ms-error-code") == "BlobNotFound"
            response.close()
            if absent:
                return None, ABSENT
            raise PodBlobStorageError("pod storage content unavailable")
        try:
            generation = _etag(response)
        except Exception:
            response.close()
            raise
        return read_bounded_response(response, max_bytes=CHUNK_BYTES + 4096), generation

    def _properties(self, path: str) -> dict[str, Any]:
        """A pod-only metadata reader; never a hub credential or storage account key."""
        try:
            response = self._session.get(
                _ARM + path,
                params={"api-version": "2023-05-01"},
                headers={
                    "Authorization": f"Bearer {self._token_provider(_ARM + '/')}",
                    "Accept-Encoding": "identity",
                },
                timeout=20,
                allow_redirects=False,
                stream=True,
            )
            raw = read_bounded_response(response, max_bytes=256 * 1024)
            value = json.loads(raw or b"null")
            if not isinstance(value, dict) or str(value.get("id", "")).lower() != path.lower():
                raise ValueError("wrong resource")
            properties = value.get("properties")
            if not isinstance(properties, dict):
                raise ValueError("missing properties")
            return properties
        except Exception:
            raise FilesRefused("FILES_BUCKET_CUSTODY_UNVERIFIED", 503) from None

    async def verify_bucket(self, key_vault_key: str) -> dict[str, Any]:
        """Keep the library's custody port; the existing Key Vault resolver unwraps its key."""
        if not key_vault_key:
            raise FilesRefused("FILES_BUCKET_CUSTODY_UNVERIFIED", 503)
        if self._retention is not None and time.monotonic() - self._security_checked_at < 60:
            return self._retention
        account, service, container = await asyncio.gather(
            asyncio.to_thread(self._properties, self._account_id),
            asyncio.to_thread(self._properties, self._account_id + "/blobServices/default"),
            asyncio.to_thread(
                self._properties,
                self._account_id + "/blobServices/default/containers/" + self._location.container,
            ),
        )
        if (
            account.get("allowBlobPublicAccess") is not False
            or account.get("allowSharedKeyAccess") is not False
            or account.get("supportsHttpsTrafficOnly") is not True
            or account.get("minimumTlsVersion") not in {"TLS1_2", "TLS1_3"}
            or container.get("publicAccess") != "None"
            or (account.get("encryption", {}).get("services", {}).get("blob", {}).get("enabled"))
            is not True
        ):
            raise FilesRefused("FILES_BUCKET_CUSTODY_UNVERIFIED", 503)
        deletion = service.get("deleteRetentionPolicy") or {}
        self._retention = {
            "retentionLocked": bool(
                container.get("hasImmutabilityPolicy") or container.get("hasLegalHold")
            ),
            "softDeleteSeconds": int(deletion.get("days", 0)) * 86400
            if deletion.get("enabled")
            else 0,
            "versioning": service.get("isVersioningEnabled") is True,
            "physicalDeletion": "not_requested_by_trash",
        }
        self._security_checked_at = time.monotonic()
        return self._retention

    async def list_page(
        self, prefix: str, cursor: str = "", limit: int = 100
    ) -> tuple[list[str], str]:
        if not 1 <= limit <= 100 or len(cursor) > 4096:
            raise ValueError("invalid page request")
        root = "/".join(self._prefix_segments + object_key_segments(prefix)) + "/"

        def read() -> tuple[list[str], str]:
            response = self._send(
                "get",
                f"{self._location.account_url}/{self._location.container}",
                {"Accept-Encoding": "identity"},
                params={
                    "restype": "container",
                    "comp": "list",
                    "prefix": root,
                    "marker": cursor,
                    "maxresults": str(limit),
                },
                stream=True,
            )
            raw = read_bounded_response(response, max_bytes=1024 * 1024)
            if raw is None:
                raise PodBlobStorageError("Files listing unavailable")
            tree = fromstring(raw)
            following = tree.findtext("NextMarker") or ""
            if tree.tag != "EnumerationResults" or len(following) > 4096:
                raise PodBlobStorageError("Files listing response invalid")
            names: list[str] = []
            for blob in tree.findall("./Blobs/Blob"):
                name = blob.findtext("Name") or ""
                if not name.startswith(root) or len(names) >= limit:
                    raise PodBlobStorageError("Files listing escaped prefix or page bound")
                relative = name[len(self._location.prefix) + 1 :] if self._location.prefix else name
                object_key_segments(relative)
                names.append(relative)
            return names, following

        return await asyncio.to_thread(read)
