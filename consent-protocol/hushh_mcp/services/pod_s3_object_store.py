# SPDX-License-Identifier: Apache-2.0
# SPDX-FileCopyrightText: 2026 Hushh
"""S3 and prefix-scoped HTTPS bearer ObjectStore adapters for multi-cloud pods.

Implements the exact `ObjectStore` CAS contract (`ABSENT` -> `If-None-Match: *`,
`<ETag>` -> `If-Match: <ETag>`) required by `PodCommitLog`, `KeyCustodyPort`, and
pod crypto-erasure across:
- `S3ObjectStore` (`POD_STORAGE_S3_URI = s3://<bucket>[/<prefix>]`) for `user_aws`;
- `PrefixTokenObjectStore` (`POD_STORAGE_PREFIX_TOKEN_URL` +
  `POD_STORAGE_PREFIX_BEARER_TOKEN`) for zero-per-user-IAM-SA Hussh-hosted cells
  and Google Agent Compute Engine (`ace`) sandboxes.
"""

from __future__ import annotations

import asyncio
import os
import re
import urllib.parse
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

S3_URI_ENV = "POD_STORAGE_S3_URI"
PREFIX_TOKEN_URL_ENV = "POD_STORAGE_PREFIX_TOKEN_URL"  # noqa: S105 - env var name
PREFIX_BEARER_TOKEN_ENV = "POD_STORAGE_PREFIX_BEARER_TOKEN"  # noqa: S105 - env var name

_S3_BUCKET_RE = re.compile(r"^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$")
_ETAG_RE = re.compile(r'^"?[A-Za-z0-9._:-]{1,254}"?$')
_TIMEOUT_SECONDS = 60


class PodMultiCloudStorageError(RuntimeError):
    """Object store operation failed without confirming outcome."""


class PodMultiCloudStorageForbidden(PodMultiCloudStorageError):
    """Caller identity was refused (401/403/AccessDenied). Never treated as absence."""


@dataclass(frozen=True)
class S3Location:
    bucket: str
    prefix: str


def parse_s3_uri(uri: str) -> S3Location:
    parsed = urllib.parse.urlsplit(str(uri or "").strip())
    bucket = (parsed.netloc or "").strip()
    if (
        parsed.scheme != "s3"
        or not _S3_BUCKET_RE.fullmatch(bucket)
        or ".." in bucket
        or parsed.query
        or parsed.fragment
    ):
        raise ValueError("POD_STORAGE_S3_URI must be a valid s3://<bucket>[/<prefix>] URI")
    prefix = "/".join(object_prefix_segments(parsed.path.strip("/")))
    return S3Location(bucket=bucket, prefix=prefix)


def _normalize_etag(raw: object) -> str:
    value = str(raw or "").strip()
    if not value or not _ETAG_RE.fullmatch(value):
        raise PodMultiCloudStorageError("pod storage version unverified")
    return value if value.startswith('"') else f'"{value}"'


class S3ObjectStore:
    """Conditional S3 object store (`IfNoneMatch='*'` / `IfMatch=<ETag>`)."""

    def __init__(self, s3_uri: str, *, s3_client: Any = None) -> None:
        self._location = parse_s3_uri(s3_uri)
        self._prefix_segments = tuple(s for s in self._location.prefix.split("/") if s)
        self._client = s3_client

    def _s3(self) -> Any:
        if self._client is not None:
            return self._client
        try:
            import boto3  # type: ignore[import-not-found]
        except ImportError as exc:
            raise PodMultiCloudStorageError(
                "boto3 is required for live S3 pod object storage"
            ) from exc
        self._client = boto3.client("s3")
        return self._client

    def _key(self, key: str) -> str:
        composed = "/".join(self._prefix_segments + object_key_segments(key))
        if not object_key_is_within(self._location.prefix, composed):
            raise ValueError("object key escapes the store prefix")
        return composed

    @staticmethod
    def _error_code(exc: BaseException) -> tuple[str, int]:
        response = getattr(exc, "response", None)
        if not isinstance(response, dict):
            return "", 0
        error = response.get("Error") or {}
        meta = response.get("ResponseMetadata") or {}
        return str(error.get("Code") or ""), int(meta.get("HTTPStatusCode") or 0)

    def get_with_generation_blocking(self, key: str) -> tuple[Optional[bytes], ObjectVersion]:
        full_key = self._key(key)
        try:
            resp = self._s3().get_object(Bucket=self._location.bucket, Key=full_key)
        except Exception as exc:  # noqa: BLE001
            code, status = self._error_code(exc)
            if status in {401, 403} or code in {"AccessDenied", "InvalidAccessKeyId"}:
                raise PodMultiCloudStorageForbidden("S3 refused this pod's identity") from None
            if status == 404 or code in {"NoSuchKey", "404"}:
                return None, ABSENT
            raise PodMultiCloudStorageError("S3 object read failed") from None
        body = resp["Body"].read()
        return bytes(body), _normalize_etag(resp.get("ETag"))

    def put_if_generation_blocking(
        self, key: str, data: bytes, expected: ObjectVersion
    ) -> Optional[ObjectVersion]:
        full_key = self._key(key)
        kwargs: dict[str, Any] = {
            "Bucket": self._location.bucket,
            "Key": full_key,
            "Body": data,
            "ContentType": "application/octet-stream",
        }
        if expected == ABSENT:
            kwargs["IfNoneMatch"] = "*"
        elif isinstance(expected, str) and _ETAG_RE.fullmatch(expected):
            kwargs["IfMatch"] = expected
        else:
            raise ValueError("object version was not issued by this store")
        try:
            resp = self._s3().put_object(**kwargs)
        except Exception as exc:  # noqa: BLE001
            code, status = self._error_code(exc)
            if status in {401, 403} or code in {"AccessDenied", "InvalidAccessKeyId"}:
                raise PodMultiCloudStorageForbidden("S3 refused this pod's identity") from None
            if status in {409, 412} or code in {
                "PreconditionFailed",
                "ConditionalRequestConflict",
            }:
                return None
            if expected != ABSENT and (status == 404 or code == "NoSuchKey"):
                return None
            raise PodMultiCloudStorageError("S3 conditional write unconfirmed") from None
        return _normalize_etag(resp.get("ETag"))

    def delete_blocking(self, key: str) -> bool:
        full_key = self._key(key)
        existing, _ = self.get_with_generation_blocking(key)
        if existing is None:
            return False
        try:
            self._s3().delete_object(Bucket=self._location.bucket, Key=full_key)
        except Exception as exc:  # noqa: BLE001
            code, status = self._error_code(exc)
            if status in {401, 403} or code == "AccessDenied":
                raise PodMultiCloudStorageForbidden("S3 refused this pod's identity") from None
            raise PodMultiCloudStorageError("S3 delete unconfirmed") from None
        return True

    async def get(self, key: str) -> Optional[bytes]:
        data, _ = await self.get_with_generation(key)
        return data

    async def get_with_generation(self, key: str) -> tuple[Optional[bytes], ObjectVersion]:
        return await asyncio.to_thread(self.get_with_generation_blocking, key)

    async def get_bounded_with_generation(
        self, key: str, *, max_bytes: int
    ) -> tuple[Optional[bytes], ObjectVersion]:
        data, version = await self.get_with_generation(key)
        if data is not None and len(data) > max_bytes:
            raise ValueError("pod object exceeds max_bytes")
        return data, version

    async def get_bounded(self, key: str, *, max_bytes: int) -> Optional[bytes]:
        data, _ = await self.get_bounded_with_generation(key, max_bytes=max_bytes)
        return data

    async def put(self, key: str, data: bytes) -> None:
        if await self.put_if_generation(key, data, ABSENT) is None:
            raise FileExistsError(f"record object already exists: {key}")

    async def put_if_generation(
        self, key: str, data: bytes, expected: ObjectVersion
    ) -> Optional[ObjectVersion]:
        return await run_write_to_completion(self.put_if_generation_blocking, key, data, expected)

    async def delete(self, key: str) -> bool:
        return await asyncio.to_thread(self.delete_blocking, key)


class PrefixTokenObjectStore:
    """Prefix-scoped HTTPS bearer ObjectStore for zero-per-user-IAM-SA hosted cells / ACE."""

    def __init__(
        self,
        prefix_url: str,
        *,
        bearer_token: Optional[str] = None,
        session: Any = None,
    ) -> None:
        parsed = urllib.parse.urlsplit(str(prefix_url or "").strip())
        if (
            parsed.scheme != "https"
            or not parsed.hostname
            or parsed.username
            or parsed.password
            or parsed.query
            or parsed.fragment
        ):
            raise ValueError("POD_STORAGE_PREFIX_TOKEN_URL must be an https:// prefix URL")
        base_path = "/".join(object_prefix_segments(parsed.path.strip("/")))
        if not base_path:
            raise ValueError("POD_STORAGE_PREFIX_TOKEN_URL must name a non-root pod prefix")
        token = (
            bearer_token if bearer_token is not None else (os.getenv(PREFIX_BEARER_TOKEN_ENV) or "")
        ).strip()
        if not token:
            raise ValueError(f"PrefixTokenObjectStore requires {PREFIX_BEARER_TOKEN_ENV}")
        self._origin = f"https://{parsed.netloc}"
        self._base_prefix = base_path
        self._prefix_segments = tuple(base_path.split("/"))
        self._token = token
        if session is None:
            from hushh_mcp.services.pod_storage_transport import PodStorageTransport

            session = PodStorageTransport()
        self._session = session

    def _url(self, key: str) -> str:
        composed = "/".join(self._prefix_segments + object_key_segments(key))
        if not object_key_is_within(self._base_prefix, composed):
            raise ValueError("object key escapes the pod prefix")
        quoted = urllib.parse.quote(composed, safe="/")
        return f"{self._origin}/{quoted}"

    def _request(self, method: str, url: str, extra: dict[str, str], **kwargs: Any) -> Any:
        headers = {"Authorization": f"Bearer {self._token}", **extra}
        try:
            response = getattr(self._session, method)(
                url,
                headers=headers,
                timeout=_TIMEOUT_SECONDS,
                allow_redirects=False,
                **kwargs,
            )
        except Exception:  # noqa: BLE001
            raise PodMultiCloudStorageError("prefix object store unreachable") from None
        if getattr(response, "status_code", 0) in {401, 403}:
            response.close()
            raise PodMultiCloudStorageForbidden("prefix object store refused bearer token")
        return response

    def get_with_generation_blocking(self, key: str) -> tuple[Optional[bytes], ObjectVersion]:
        response = self._request("get", self._url(key), {})
        try:
            status = getattr(response, "status_code", 0)
            if status == 404:
                return None, ABSENT
            if status != 200:
                raise PodMultiCloudStorageError("prefix object store read failed")
            headers = getattr(response, "headers", None) or {}
            etag = next(
                (v for k, v in headers.items() if isinstance(k, str) and k.lower() == "etag"),
                None,
            )
            return bytes(response.content), _normalize_etag(etag)
        finally:
            response.close()

    def put_if_generation_blocking(
        self, key: str, data: bytes, expected: ObjectVersion
    ) -> Optional[ObjectVersion]:
        if expected == ABSENT:
            cond = {"If-None-Match": "*"}
        elif isinstance(expected, str) and _ETAG_RE.fullmatch(expected):
            cond = {"If-Match": expected}
        else:
            raise ValueError("object version was not issued by this store")
        response = self._request(
            "put",
            self._url(key),
            {"Content-Type": "application/octet-stream", **cond},
            data=data,
        )
        try:
            status = getattr(response, "status_code", 0)
            if status in {200, 201}:
                headers = getattr(response, "headers", None) or {}
                etag = next(
                    (v for k, v in headers.items() if isinstance(k, str) and k.lower() == "etag"),
                    None,
                )
                return _normalize_etag(etag)
            if status in {409, 412} or (expected != ABSENT and status == 404):
                return None
            raise PodMultiCloudStorageError("prefix object store write unconfirmed")
        finally:
            response.close()

    def delete_blocking(self, key: str) -> bool:
        response = self._request("delete", self._url(key), {})
        try:
            status = getattr(response, "status_code", 0)
            if status in {200, 202, 204}:
                return True
            if status == 404:
                return False
            raise PodMultiCloudStorageError("prefix object store delete unconfirmed")
        finally:
            response.close()

    async def get(self, key: str) -> Optional[bytes]:
        data, _ = await self.get_with_generation(key)
        return data

    async def get_with_generation(self, key: str) -> tuple[Optional[bytes], ObjectVersion]:
        return await asyncio.to_thread(self.get_with_generation_blocking, key)

    async def get_bounded_with_generation(
        self, key: str, *, max_bytes: int
    ) -> tuple[Optional[bytes], ObjectVersion]:
        data, version = await self.get_with_generation(key)
        if data is not None and len(data) > max_bytes:
            raise ValueError("pod object exceeds max_bytes")
        return data, version

    async def get_bounded(self, key: str, *, max_bytes: int) -> Optional[bytes]:
        data, _ = await self.get_bounded_with_generation(key, max_bytes=max_bytes)
        return data

    async def put(self, key: str, data: bytes) -> None:
        if await self.put_if_generation(key, data, ABSENT) is None:
            raise FileExistsError(f"record object already exists: {key}")

    async def put_if_generation(
        self, key: str, data: bytes, expected: ObjectVersion
    ) -> Optional[ObjectVersion]:
        return await run_write_to_completion(self.put_if_generation_blocking, key, data, expected)

    async def delete(self, key: str) -> bool:
        return await asyncio.to_thread(self.delete_blocking, key)
