"""The pod's object store on Azure Blob: raw REST, keyless, as the pod's own identity.

The same :class:`~hushh_mcp.services.pod_commit_log.ObjectStore` contract the GCS
store keeps, so the sealed commit log, the identity key, the incarnation fence and
the wrapped log key behave identically on both clouds. The bearer comes from the
pod's user-assigned managed identity (``get_workload_token``); Hussh holds no
Storage role in the person's subscription and no key for it.

Status mapping, as MEASURED against a real account (byoc-azure.md, 2026-10-02):

* create-only (``If-None-Match: *``) on an existing blob answers **409
  BlobAlreadyExists**, where GCS answers 412. Both mean "lost the race".
* compare-and-swap (``If-Match: <ETag>``) mismatch answers **412 ConditionNotMet**.
* an absent blob answers **404 BlobNotFound**. That error code, and only that one,
  is absence: a missing container is a misconfiguration, never an empty history.
* **403 is refused, never absent.** Misreading a denied read as absence, or a
  denied write as a lost race, is how a second key gets minted and the agent's
  history forks into two that both claim to be it.
"""

from __future__ import annotations

import asyncio
import email.utils
import re
import urllib.parse
from collections.abc import Callable
from dataclasses import dataclass
from typing import Any, Optional

from hushh_mcp.services.pod_commit_log import (
    object_key_is_within,
    object_key_segments,
    object_prefix_segments,
)
from hushh_mcp.services.pod_object_version import (
    ABSENT,
    ObjectVersion,
    run_write_to_completion,
)
from hushh_mcp.services.pod_workload_identity import forget_workload_token, get_workload_token

STORAGE_RESOURCE = "https://storage.azure.com"
_API_VERSION = "2023-11-03"
_TIMEOUT_SECONDS = 60
# Commercial and US Government clouds; a sovereign cloud is a settings change.
_HOST_SUFFIXES = (".blob.core.windows.net", ".blob.core.usgovcloudapi.net")
_ACCOUNT = re.compile(r"[a-z0-9]{3,24}")
_CONTAINER = re.compile(r"[a-z0-9](?:[a-z0-9]|-(?=[a-z0-9])){2,62}")
# A strong entity tag, exactly as Blob states it; quoted, so never a decimal.
_ETAG = re.compile(r'"[\x21\x23-\x7e]{1,254}"')
_ERROR_CODE = re.compile(r"<Code>([A-Za-z]{1,64})</Code>")
_CREDENTIAL_REFUSED = (401, 403)


class PodBlobStorageError(RuntimeError):
    """The blob store did not confirm an operation. Never carries provider bodies."""


class PodBlobStorageForbidden(PodBlobStorageError):
    """The pod's identity was refused. Never absence, never a lost race."""


@dataclass(frozen=True)
class AzureBlobLocation:
    account_url: str
    container: str
    prefix: str


def parse_blob_container_url(url: str) -> AzureBlobLocation:
    """``https://<account>.blob.core.windows.net/<container>[/<prefix>]``, validated."""
    parsed = urllib.parse.urlsplit(str(url or "").strip())
    host = (parsed.hostname or "").lower()
    suffix = next((s for s in _HOST_SUFFIXES if host.endswith(s)), "")
    if (
        parsed.scheme != "https"
        or not suffix
        or parsed.username
        or parsed.password
        or parsed.query
        or parsed.fragment
        or ":" in parsed.netloc
        or not _ACCOUNT.fullmatch(host[: -len(suffix)])
    ):
        raise ValueError("POD_STORAGE_AZURE_BLOB_URL is not an Azure Blob container URL")
    container, _, prefix = parsed.path.strip("/").partition("/")
    if not _CONTAINER.fullmatch(container):
        raise ValueError("POD_STORAGE_AZURE_BLOB_URL names no valid container")
    return AzureBlobLocation(
        account_url=f"https://{host}",
        container=container,
        prefix="/".join(object_prefix_segments(prefix)),
    )


def _error_code(response: Any) -> str:
    headers = getattr(response, "headers", None) or {}
    for name, value in headers.items():
        if isinstance(name, str) and name.lower() == "x-ms-error-code":
            return str(value or "")
    match = _ERROR_CODE.search(str(getattr(response, "text", "") or "")[:4096])
    return match.group(1) if match else ""


def _etag(response: Any) -> ObjectVersion:
    headers = getattr(response, "headers", None) or {}
    for name, value in headers.items():
        if isinstance(name, str) and name.lower() == "etag" and isinstance(value, str):
            if _ETAG.fullmatch(value):
                return value
    raise PodBlobStorageError("pod storage version unverified")


class AzureBlobObjectStore:
    """One container (and optional prefix) in the person's own storage account."""

    def __init__(
        self,
        container_url: str,
        *,
        session: Any = None,
        token_provider: Optional[Callable[[str], str]] = None,
        forget_token: Callable[[str], None] = forget_workload_token,
    ) -> None:
        self._location = parse_blob_container_url(container_url)
        self._prefix_segments = tuple(s for s in self._location.prefix.split("/") if s)
        if session is None:
            import requests  # type: ignore[import-untyped]  # noqa: PLC0415

            session = requests
        self._session = session
        # The pod's own identity, minted over the same egress session as the data.
        self._token_provider = token_provider or (
            lambda resource: get_workload_token(resource, session=self._session)
        )
        self._forget_token = forget_token

    def _url(self, key: str) -> str:
        composed = "/".join(self._prefix_segments + object_key_segments(key))
        if not object_key_is_within(self._location.prefix, composed):
            raise ValueError("object key escapes the store prefix")
        quoted = urllib.parse.quote(composed, safe="/")
        return f"{self._location.account_url}/{self._location.container}/{quoted}"

    def _headers(self, extra: dict[str, str]) -> dict[str, str]:
        return {
            "Authorization": f"Bearer {self._token_provider(STORAGE_RESOURCE)}",
            "x-ms-version": _API_VERSION,
            "x-ms-date": email.utils.formatdate(usegmt=True),
            **extra,
        }

    def _send(self, method: str, url: str, extra: dict[str, str], **kwargs: Any) -> Any:
        """One request, re-minting the bearer ONCE if it is refused.

        Every request here is safe to repeat: reads are reads, every write
        carries a precondition a refused attempt cannot have consumed, and a
        refused delete removed nothing.
        """

        def attempt() -> Any:
            headers = self._headers(extra)  # an identity failure surfaces as itself
            try:
                return getattr(self._session, method)(
                    url,
                    headers=headers,
                    timeout=_TIMEOUT_SECONDS,
                    allow_redirects=False,
                    **kwargs,
                )
            except Exception:  # noqa: BLE001 - transport errors can echo URLs and headers
                raise PodBlobStorageError("pod storage unreachable") from None

        response = attempt()
        if getattr(response, "status_code", 0) in _CREDENTIAL_REFUSED:
            self._forget_token(STORAGE_RESOURCE)
            response = attempt()
        if getattr(response, "status_code", 0) in _CREDENTIAL_REFUSED:
            raise PodBlobStorageForbidden("pod storage refused this pod's identity")
        return response

    def get_with_generation_blocking(self, key: str) -> tuple[Optional[bytes], ObjectVersion]:
        response = self._send("get", self._url(key), {})
        status = getattr(response, "status_code", 0)
        if status == 404 and _error_code(response) == "BlobNotFound":
            return None, ABSENT
        if status != 200:
            raise PodBlobStorageError("pod storage content unavailable")
        return bytes(response.content), _etag(response)

    def put_if_generation_blocking(
        self, key: str, data: bytes, expected: ObjectVersion
    ) -> Optional[ObjectVersion]:
        if expected == ABSENT:
            condition = {"If-None-Match": "*"}
        elif isinstance(expected, str) and _ETAG.fullmatch(expected):
            condition = {"If-Match": expected}
        else:
            raise ValueError("object version was not issued by this store")
        extra = {
            "x-ms-blob-type": "BlockBlob",
            "Content-Type": "application/octet-stream",
            **condition,
        }
        response = self._send("put", self._url(key), extra, data=data)
        status, code = getattr(response, "status_code", 0), _error_code(response)
        if status == 201:
            return _etag(response)
        if expected == ABSENT and status == 409 and code == "BlobAlreadyExists":
            return None  # lost the create race; the caller adopts the winner
        if status == 412 and code == "ConditionNotMet":
            return None  # lost the swap; the caller retries from a fresh read
        if expected != ABSENT and status == 404 and code == "BlobNotFound":
            return None  # the version we expected is gone: also a lost swap
        raise PodBlobStorageError("pod storage write unconfirmed")

    def delete_blocking(self, key: str) -> bool:
        """202 removed it; only 404 ``BlobNotFound`` is already gone; 403 raised in _send."""
        response = self._send("delete", self._url(key), {"x-ms-delete-snapshots": "include"})
        status = getattr(response, "status_code", 0)
        if status == 202:
            return True
        if status == 404 and _error_code(response) == "BlobNotFound":
            return False
        raise PodBlobStorageError("pod storage delete unconfirmed")

    async def get(self, key: str) -> Optional[bytes]:
        data, _ = await self.get_with_generation(key)
        return data

    async def get_with_generation(self, key: str) -> tuple[Optional[bytes], ObjectVersion]:
        return await asyncio.to_thread(self.get_with_generation_blocking, key)

    async def put(self, key: str, data: bytes) -> None:
        if await self.put_if_generation(key, data, ABSENT) is None:
            raise FileExistsError(f"record object already exists: {key}")

    async def put_if_generation(
        self, key: str, data: bytes, expected: ObjectVersion
    ) -> Optional[ObjectVersion]:
        return await run_write_to_completion(self.put_if_generation_blocking, key, data, expected)

    async def delete(self, key: str) -> bool:
        return await asyncio.to_thread(self.delete_blocking, key)


__all__ = [
    "STORAGE_RESOURCE",
    "AzureBlobLocation",
    "AzureBlobObjectStore",
    "PodBlobStorageError",
    "PodBlobStorageForbidden",
    "parse_blob_container_url",
]
