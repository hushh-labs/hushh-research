"""Server-only, revision-pinned Drive blob download for an authenticated owner.

Callers supply the owner from verified ingress, never from model arguments. This
service does not expose a tool, route, credential, or model-facing byte payload.
"""

from __future__ import annotations

import asyncio
import hashlib
import hmac
import json
import re
from dataclasses import dataclass, field
from typing import Any

import httpx

from hushh_mcp.hushh_adk.context import HushhContext
from hushh_mcp.runtime_settings import get_core_security_settings
from hushh_mcp.services.google_connection_service import (
    GoogleConnectionError,
    GoogleConnectionService,
    get_google_connection_service,
)

_DRIVE_FILES = "https://www.googleapis.com/drive/v3/files"
MAX_BLOB_BYTES = 5 * 1024 * 1024
_MAX_METADATA_BYTES = 8 * 1024
_FILE_ID = re.compile(r"[A-Za-z0-9_-]{1,256}\Z")
_REVISION = re.compile(r"[A-Za-z0-9_-]{1,256}\Z")
_FILENAME = re.compile(r"[A-Za-z0-9][A-Za-z0-9._ -]{0,127}\Z")
_SHA256 = re.compile(r"[0-9a-f]{64}\Z")
_MIME_EXTENSIONS = {
    "application/pdf": frozenset({".pdf"}),
    "image/jpeg": frozenset({".jpg", ".jpeg"}),
    "image/png": frozenset({".png"}),
    "text/plain": frozenset({".txt"}),
    "text/csv": frozenset({".csv"}),
}
_METADATA_FIELDS = (
    "id,name,mimeType,size,version,headRevisionId,sha256Checksum,capabilities(canDownload),trashed"
)


@dataclass(frozen=True)
class DriveBlobDescriptor:
    file_id: str
    filename: str
    mime_type: str
    size: int
    revision: str
    sha256: str


@dataclass(frozen=True)
class ResolvedDriveBlob:
    descriptor: DriveBlobDescriptor
    content: bytes = field(repr=False)


@dataclass(frozen=True)
class DriveGrantIdentity:
    binding: str
    account_label: str


def _invalid(message: str, status_code: int = 422) -> GoogleConnectionError:
    return GoogleConnectionError(message, status_code=status_code)


def _metadata_descriptor(raw: Any, *, file_id: str) -> tuple[DriveBlobDescriptor, str]:
    if not isinstance(raw, dict) or raw.get("id") != file_id:
        raise _invalid("Drive file identity could not be verified", 409)
    if raw.get("trashed") is not False:
        raise _invalid("Drive file is unavailable", 403)
    capabilities = raw.get("capabilities")
    if not isinstance(capabilities, dict) or capabilities.get("canDownload") is not True:
        raise _invalid("Drive file download is not permitted", 403)
    name = raw.get("name")
    mime = raw.get("mimeType")
    if not isinstance(mime, str) or mime not in _MIME_EXTENSIONS:
        raise _invalid("Drive file type is unsupported")
    if (
        not isinstance(name, str)
        or not _FILENAME.fullmatch(name)
        or ".." in name
        or name.endswith((".", " "))
        or not any(name.lower().endswith(ext) for ext in _MIME_EXTENSIONS[mime])
    ):
        raise _invalid("Drive filename is unsafe")
    size_raw = raw.get("size")
    if (
        not isinstance(size_raw, str)
        or not size_raw.isascii()
        or not size_raw.isdecimal()
        or len(size_raw) > 7
    ):
        raise _invalid("Drive file size is unavailable")
    size = int(size_raw)
    if not 0 < size <= MAX_BLOB_BYTES:
        raise _invalid("Drive file exceeds the attachment limit")
    revision = raw.get("headRevisionId")
    version = raw.get("version")
    if (
        not isinstance(revision, str)
        or not _REVISION.fullmatch(revision)
        or not isinstance(version, str)
        or not version.isascii()
        or not version.isdecimal()
        or len(version) > 20
        or int(version) < 1
    ):
        raise _invalid("Drive file revision is unavailable", 409)
    checksum = raw.get("sha256Checksum")
    if not isinstance(checksum, str) or not _SHA256.fullmatch(checksum):
        raise _invalid("Drive file checksum is unavailable", 409)
    return DriveBlobDescriptor(file_id, name, mime, size, revision, checksum), version


def _verify_content_type(content: bytes | bytearray, mime_type: str) -> None:
    if mime_type == "application/pdf":
        valid = content.startswith(b"%PDF-")
    elif mime_type == "image/png":
        valid = content.startswith(b"\x89PNG\r\n\x1a\n")
    elif mime_type == "image/jpeg":
        valid = content.startswith(b"\xff\xd8\xff")
    else:
        try:
            decoded = content.decode("utf-8-sig")
            valid = not any(ord(char) < 32 and char not in "\t\n\r" for char in decoded)
        except UnicodeDecodeError:
            valid = False
    if not valid:
        raise _invalid("Drive content does not match its file type", 409)


class GoogleDriveBlobAttachmentService:
    def __init__(
        self,
        *,
        connections: GoogleConnectionService | None = None,
        transport: httpx.AsyncBaseTransport | None = None,
    ) -> None:
        self._connections = connections or get_google_connection_service()
        self._transport = transport

    async def grant_identity(self, *, authenticated_owner_user_id: str) -> DriveGrantIdentity:
        """Safe account label and opaque grant generation for an owner review.

        Read one owner-scoped snapshot from the existing Google grant store.
        The provider subject and encrypted refresh envelope never leave here.
        """
        if not authenticated_owner_user_id or len(authenticated_owner_user_id) > 256:
            raise _invalid("Authenticated Drive owner is required", 403)
        context = HushhContext.current()
        if context is not None and context.user_id != authenticated_owner_user_id:
            raise _invalid("Authenticated Drive owner does not match this invocation", 403)
        try:
            result = await self._connections._execute_raw_async(
                """SELECT c.provider_subject, c.provider_email, c.refresh_token_ciphertext,
                          c.status AS connection_status, g.status AS grant_status,
                          g.scope_csv, g.updated_at AS grant_updated_at
                   FROM google_provider_connections c
                   JOIN google_service_grants g
                     ON g.user_id = c.user_id AND g.provider = c.provider
                    AND g.service = 'drive'
                   WHERE c.user_id = :user_id AND c.provider = 'google'""",
                {"user_id": authenticated_owner_user_id},
            )
        except Exception:
            raise _invalid("Drive grant could not be verified", 503) from None
        row = result.data[0] if result.data else None
        if (
            not row
            or row.get("connection_status") != "connected"
            or row.get("grant_status") != "connected"
            or not isinstance(row.get("provider_subject"), str)
            or not row["provider_subject"]
            or not isinstance(row.get("provider_email"), str)
            or not re.fullmatch(r"[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+", row["provider_email"])
            or len(row["provider_email"]) > 320
            or not isinstance(row.get("refresh_token_ciphertext"), str)
            or not row["refresh_token_ciphertext"]
            or not row.get("grant_updated_at")
            or not set(GoogleConnectionService.scopes("drive", "read")).issubset(
                str(row.get("scope_csv") or "").split()
            )
        ):
            raise _invalid("Drive grant is no longer active", 403)
        try:
            key = get_core_security_settings().app_signing_key.encode()
            material = json.dumps(
                [
                    authenticated_owner_user_id,
                    row["provider_subject"],
                    row["refresh_token_ciphertext"],
                    row["scope_csv"],
                    str(row["grant_updated_at"]),
                ],
                separators=(",", ":"),
            ).encode()
            binding = hmac.new(
                key, b"drive-attachment-grant-v1:" + material, hashlib.sha256
            ).hexdigest()
            return DriveGrantIdentity(binding=binding, account_label=row["provider_email"].lower())
        except Exception:
            raise _invalid("Drive grant could not be verified", 503) from None

    async def grant_binding(self, *, authenticated_owner_user_id: str) -> str:
        return (
            await self.grant_identity(authenticated_owner_user_id=authenticated_owner_user_id)
        ).binding

    async def _metadata(
        self, client: httpx.AsyncClient, *, file_id: str, headers: dict[str, str]
    ) -> tuple[DriveBlobDescriptor, str]:
        async with client.stream(
            "GET",
            f"{_DRIVE_FILES}/{file_id}",
            params={"fields": _METADATA_FIELDS, "supportsAllDrives": "true"},
            headers={**headers, "Accept": "application/json"},
        ) as response:
            self._check_status(response)
            length = response.headers.get("content-length")
            if length is not None and (not length.isdecimal() or int(length) > _MAX_METADATA_BYTES):
                raise _invalid("Drive metadata is unavailable", 502)
            body = bytearray()
            async for chunk in response.aiter_raw():
                body.extend(chunk)
                if len(body) > _MAX_METADATA_BYTES:
                    raise _invalid("Drive metadata is unavailable", 502)
            try:
                raw = json.loads(body)
            except (ValueError, UnicodeDecodeError):
                raise _invalid("Drive metadata is unavailable", 502) from None
            return _metadata_descriptor(raw, file_id=file_id)

    @staticmethod
    def _check_status(response: httpx.Response) -> None:
        if response.status_code == 401:
            raise _invalid("Google Drive connection needs reauthorization", 401)
        if response.status_code in {403, 404}:
            raise _invalid("Drive file is not available to this owner", 403)
        if response.status_code != 200:
            raise _invalid("Drive request could not be completed", 502)

    async def _download(
        self,
        client: httpx.AsyncClient,
        *,
        descriptor: DriveBlobDescriptor,
        headers: dict[str, str],
    ) -> bytes:
        async with client.stream(
            "GET",
            f"{_DRIVE_FILES}/{descriptor.file_id}",
            params={"alt": "media", "supportsAllDrives": "true"},
            headers={**headers, "Accept": descriptor.mime_type, "Accept-Encoding": "identity"},
        ) as response:
            self._check_status(response)
            if response.headers.get("content-encoding", "identity").lower() != "identity":
                raise _invalid("Drive content encoding is unsupported", 502)
            if "content-range" in response.headers:
                raise _invalid("Drive returned a partial download", 502)
            response_mime = response.headers.get("content-type", "").split(";", 1)[0].lower()
            if response_mime not in {descriptor.mime_type, "application/octet-stream"}:
                raise _invalid("Drive content type changed", 409)
            length = response.headers.get("content-length")
            if length is not None and (not length.isdecimal() or int(length) != descriptor.size):
                raise _invalid("Drive download size changed", 409)
            body = bytearray()
            digest = hashlib.sha256()
            async for chunk in response.aiter_raw():
                if (
                    len(body) + len(chunk) > descriptor.size
                    or len(body) + len(chunk) > MAX_BLOB_BYTES
                ):
                    raise _invalid("Drive download size changed", 409)
                body.extend(chunk)
                digest.update(chunk)
            if len(body) != descriptor.size:
                raise _invalid("Drive download was truncated", 502)
            if digest.hexdigest() != descriptor.sha256:
                raise _invalid("Drive file checksum changed", 409)
            _verify_content_type(body, descriptor.mime_type)
            return bytes(body)

    async def resolve(
        self,
        *,
        file_id: str,
        authenticated_owner_user_id: str,
        expected_revision: str | None = None,
        expected_sha256: str | None = None,
    ) -> ResolvedDriveBlob:
        """Resolve one exact blob for a server caller with verified owner identity.

        The caller must pass its authenticated principal and previously reviewed
        head revision. No provider credentials or bytes belong in agent state.
        """
        if (
            not isinstance(authenticated_owner_user_id, str)
            or not authenticated_owner_user_id
            or authenticated_owner_user_id != authenticated_owner_user_id.strip()
            or len(authenticated_owner_user_id) > 256
        ):
            raise _invalid("Authenticated Drive owner is required", 403)
        context = HushhContext.current()
        if context is not None and context.user_id != authenticated_owner_user_id:
            raise _invalid("Authenticated Drive owner does not match this invocation", 403)
        if not isinstance(file_id, str) or not _FILE_ID.fullmatch(file_id):
            raise _invalid("Drive file ID is invalid")
        if expected_revision is not None and (
            not isinstance(expected_revision, str) or not _REVISION.fullmatch(expected_revision)
        ):
            raise _invalid("Expected Drive revision is required")
        if expected_sha256 is not None and (
            not isinstance(expected_sha256, str) or not _SHA256.fullmatch(expected_sha256)
        ):
            raise _invalid("Expected Drive checksum is invalid")
        token = await self._connections.access_token(
            user_id=authenticated_owner_user_id, service="drive", access_level="read"
        )
        headers = {"Authorization": f"Bearer {token}"}
        try:
            async with asyncio.timeout(30):
                async with httpx.AsyncClient(
                    transport=self._transport,
                    timeout=httpx.Timeout(20, connect=5),
                    follow_redirects=False,
                ) as client:
                    before, version = await self._metadata(client, file_id=file_id, headers=headers)
                    if (expected_revision is not None and before.revision != expected_revision) or (
                        expected_sha256 is not None and before.sha256 != expected_sha256
                    ):
                        raise _invalid("Drive file changed since review", 409)
                    content = await self._download(client, descriptor=before, headers=headers)
                    after, after_version = await self._metadata(
                        client, file_id=file_id, headers=headers
                    )
                    if after != before or after_version != version:
                        raise _invalid("Drive file changed during download", 409)
                    # A disconnect during the read must not release already fetched bytes.
                    await self._connections.access_token(
                        user_id=authenticated_owner_user_id, service="drive", access_level="read"
                    )
                    return ResolvedDriveBlob(descriptor=before, content=content)
        except TimeoutError:
            raise _invalid("Drive request timed out", 502) from None
        except httpx.HTTPError:
            raise _invalid("Drive request could not be completed", 502) from None
