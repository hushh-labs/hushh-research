"""Shared-only resumable ciphertext writes; session credentials never leave custody."""

from __future__ import annotations

import asyncio
import json
from typing import Any
from urllib.parse import parse_qs, quote, urlsplit

from opentelemetry.instrumentation.utils import suppress_instrumentation

from hushh_mcp.services.pod_files.contracts import FilesRefused
from hushh_mcp.services.pod_files.storage import FilesGcsStore

MAX_CIPHERTEXT_BYTES = 4 * 1024 * 1024 + 128 * 1024


class SharedCipherStore(FilesGcsStore):
    """GCS session completion/cancellation is independent of process lifetime."""

    def _session_uri(self, uri: str, path: str) -> str:
        try:
            parsed = urlsplit(uri)
            query = parse_qs(parsed.query, strict_parsing=True)
            valid = (
                0 < len(uri) <= 8192
                and parsed.scheme == "https"
                and parsed.netloc == "storage.googleapis.com"
                and not parsed.fragment
                and parsed.path == f"/upload/storage/v1/b/{quote(self._bucket, safe='')}/o"
                and set(query) <= {"uploadType", "upload_id", "name", "ifGenerationMatch"}
                and query.get("uploadType") == ["resumable"]
                and len(query.get("upload_id", [])) == 1
                and bool(query["upload_id"][0])
                and ("name" not in query or query["name"] == [self._key(path)])
            )
        except (ValueError, KeyError):
            valid = False
        if not valid:
            raise FilesRefused("FILES_UPLOAD_SESSION_INVALID", 503)
        return uri

    @staticmethod
    def _metadata(response: Any) -> dict[str, Any]:
        value = bytearray()
        for chunk in response.iter_content(chunk_size=8192):
            if len(value) + len(chunk) > 32768:
                raise FilesRefused("FILES_UPLOAD_RESPONSE_INVALID", 503)
            value.extend(chunk)
        try:
            body = json.loads(value)
        except (ValueError, UnicodeError):
            raise FilesRefused("FILES_UPLOAD_RESPONSE_INVALID", 503) from None
        if not isinstance(body, dict):
            raise FilesRefused("FILES_UPLOAD_RESPONSE_INVALID", 503)
        return body

    def _request(self, method: str, url: str, **kwargs: Any) -> Any:
        # Session URI is itself a bearer credential. Never propagate HTTP errors
        # containing it, redirects, or an unbounded provider response.
        try:
            send = getattr(self._session, method)
            extra_headers = kwargs.pop("extra_headers", {})
            with suppress_instrumentation():
                return self._authorized(
                    lambda headers: send(
                        url,
                        headers={**headers, **extra_headers},
                        timeout=60,
                        allow_redirects=False,
                        stream=True,
                        **kwargs,
                    )
                )
        except Exception:
            raise FilesRefused("FILES_UPLOAD_PROVIDER_UNAVAILABLE", 503) from None

    async def initiate(self, path: str, size: int, expected: str) -> str | None:
        if not 28 <= size <= MAX_CIPHERTEXT_BYTES:
            raise FilesRefused("FILES_OBJECT_INVALID", 400)

        def start() -> str | None:
            response = self._request(
                "post",
                f"https://storage.googleapis.com/upload/storage/v1/b/{self._bucket}/o",
                params={
                    "uploadType": "resumable",
                    "name": self._key(path),
                    "ifGenerationMatch": expected or "0",
                },
                data=b"",
                extra_headers={
                    "X-Upload-Content-Length": str(size),
                    "X-Upload-Content-Type": "application/octet-stream",
                },
            )
            try:
                if response.status_code == 412:
                    return None
                if response.status_code != 200:
                    raise FilesRefused("FILES_UPLOAD_PROVIDER_UNAVAILABLE", 503)
                return self._session_uri(self._header(response, "location") or "", path)
            finally:
                response.close()

        return await asyncio.to_thread(start)

    async def send(self, uri: str, path: str, data: bytes) -> str | None:
        uri = self._session_uri(uri, path)

        def upload() -> str | None:
            response = self._request(
                "put",
                uri,
                data=data,
                extra_headers={
                    "Content-Length": str(len(data)),
                    "Content-Type": "application/octet-stream",
                },
            )
            try:
                if response.status_code == 412:
                    return None
                if response.status_code not in {200, 201}:
                    raise FilesRefused("FILES_UPLOAD_OUTCOME_UNCERTAIN", 503)
                body = self._metadata(response)
                if body.get("name") != self._key(path) or str(body.get("size")) != str(len(data)):
                    raise FilesRefused("FILES_UPLOAD_RESPONSE_INVALID", 503)
                return str(self._generation(body))
            finally:
                response.close()

        return await asyncio.to_thread(upload)

    async def status(self, uri: str, path: str, size: int) -> str:
        uri = self._session_uri(uri, path)

        def probe() -> str:
            response = self._request(
                "put",
                uri,
                data=b"",
                extra_headers={"Content-Length": "0", "Content-Range": f"bytes */{size}"},
            )
            try:
                if response.status_code in {200, 201}:
                    return "complete"
                if response.status_code == 410:
                    return "invalidated"
                if response.status_code == 404:
                    # Missing alone is not terminal: the receipt owner must
                    # additionally qualify the exact session's expiry bound.
                    return "missing"
                return "incomplete" if response.status_code == 308 else "uncertain"
            finally:
                response.close()

        return await asyncio.to_thread(probe)

    async def cancel(self, uri: str, path: str) -> bool:
        uri = self._session_uri(uri, path)

        def stop() -> bool:
            response = self._request("delete", uri)
            try:
                return bool(response.status_code == 499)
            finally:
                response.close()

        return await asyncio.to_thread(stop)
