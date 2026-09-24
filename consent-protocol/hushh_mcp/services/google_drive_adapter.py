"""Fixed, bounded REST reads for explicitly selected Drive files.

Internal transport only: callers must validate owner/selection/generation before
and after I/O. No listing, caller-selected URLs/queries, mutations or MCP path.
Provider identifiers and bytes must never enter model arguments or telemetry.
"""

from __future__ import annotations

import asyncio
import hashlib
import json
import re
from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field
from typing import Any

import httpx
from opentelemetry.instrumentation.utils import suppress_instrumentation

DRIVE_FILE_SCOPE = "https://www.googleapis.com/auth/drive.file"
DRIVE_BASE = "https://www.googleapis.com/drive/v3"
METADATA_LIMIT = 256 * 1024
CONTENT_LIMIT = 4 * 1024 * 1024
DEADLINE_SECONDS = 20
MAX_SELECTION = 25
SELECTED_POLICY = {
    "version": 1,
    "access": "selected_files",
    "mutations": False,
    "requireGenAiEligibility": True,
    "maxSelection": MAX_SELECTION,
}
POLICY_HASH = hashlib.sha256(json.dumps(SELECTED_POLICY, sort_keys=True).encode()).hexdigest()
LIVE_POLICY = {
    "version": 1,
    "access": "live_drive",
    "readTransport": "google_drive_mcp",
    "share": "exact_file_viewer",
    "backgroundPreparation": "separate_owner_consent",
}
LIVE_POLICY_HASH = hashlib.sha256(json.dumps(LIVE_POLICY, sort_keys=True).encode()).hexdigest()
DRIVE_POLICY = {"version": 2, "profiles": {"selected": SELECTED_POLICY, "live": LIVE_POLICY}}


def supports_selected_policy(value: object) -> bool:
    return value == SELECTED_POLICY or value == DRIVE_POLICY


FILE_ID = re.compile(r"[A-Za-z0-9_-]{1,200}\Z")
METADATA_FIELDS = (
    "id,name,mimeType,version,modifiedTime,size,md5Checksum,trashed,isAppAuthorized,"
    "capabilities(canDownload,canAccessViaGenAi),clientEncryptionDetails(encryptionState)"
)
EXPORTS = {
    "application/vnd.google-apps.document": "text/plain",
    "application/vnd.google-apps.presentation": "text/plain",
}
BINARY_TYPES = frozenset(
    {
        "text/plain",
        "text/markdown",
        "application/pdf",
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    }
)
SUPPORTED_TYPES = frozenset(EXPORTS) | BINARY_TYPES
# Text extraction for live reads belongs to Google's MCP server, not our index.
LIVE_SUPPORTED_TYPES = SUPPORTED_TYPES | frozenset(
    {
        "application/vnd.google-apps.spreadsheet",
        "application/msword",
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "application/vnd.openxmlformats-officedocument.presentationml.presentation",
        "application/vnd.oasis.opendocument.spreadsheet",
        "application/vnd.oasis.opendocument.presentation",
        "application/x-vnd.oasis.opendocument.text",
        "image/png",
        "image/jpeg",
        "image/jpg",
    }
)


class DriveReadError(RuntimeError):
    """Only authored safe codes cross the transport boundary."""

    def __init__(self, code: str, *, retryable: bool = False):
        super().__init__(code)
        self.retryable = retryable


@dataclass(frozen=True)
class DriveMetadata:
    file_id: str = field(repr=False)
    name: str = field(repr=False)
    mime_type: str
    version: str
    modified_time: str
    size: int | None
    checksum: str | None = field(repr=False)


@dataclass(frozen=True)
class DriveContent:
    metadata: DriveMetadata
    mime_type: str
    content: bytes = field(repr=False)


def selected_file_ids(value: Any) -> tuple[str, ...]:
    if (
        not isinstance(value, (tuple, list))
        or not 1 <= len(value) <= MAX_SELECTION
        or any(not isinstance(item, str) or not FILE_ID.fullmatch(item) for item in value)
        or len(set(value)) != len(value)
    ):
        raise DriveReadError("invalid_selection")
    return tuple(value)


def _file_path(file_id: str) -> str:
    if not isinstance(file_id, str) or not FILE_ID.fullmatch(file_id):
        raise DriveReadError("invalid_selection")
    return f"/files/{file_id}"


def _decode_json(payload: bytes) -> dict[str, Any]:
    try:
        result = json.loads(payload)
    except (ValueError, UnicodeError):
        raise DriveReadError("provider_response_invalid") from None
    if not isinstance(result, dict):
        raise DriveReadError("provider_response_invalid")
    return result


class GoogleDriveAdapter:
    async def _get(
        self, path: str, *, access_token: str, params: dict[str, str], limit: int
    ) -> bytes:
        # Provider identifiers must not reach the global HTTPX trace exporter.
        with suppress_instrumentation():
            return await self._get_private(
                path, access_token=access_token, params=params, limit=limit
            )

    async def _get_private(
        self, path: str, *, access_token: str, params: dict[str, str], limit: int
    ) -> bytes:
        # This is not a general HTTP executor. Even internal callers cannot
        # supply an origin, arbitrary query, mutation, or unbounded response.
        if path == "/about":
            allowed = params == {"fields": "user(permissionId,emailAddress,me)"}
        elif re.fullmatch(r"/files/[A-Za-z0-9_-]{1,200}(?:/export)?", path):
            allowed = (
                not path.endswith("/export")
                and params
                in (
                    {"fields": METADATA_FIELDS, "supportsAllDrives": "true"},
                    {"alt": "media", "supportsAllDrives": "true"},
                )
            ) or (
                path.endswith("/export")
                and len(params) == 1
                and params.get("mimeType") in EXPORTS.values()
            )
        else:
            allowed = False
        if not allowed or limit not in {METADATA_LIMIT, CONTENT_LIMIT}:
            raise DriveReadError("operation_not_allowed")
        if not isinstance(access_token, str) or not 1 <= len(access_token) <= 16384:
            raise DriveReadError("reconnect_required")
        try:
            async with (
                asyncio.timeout(DEADLINE_SECONDS),
                httpx.AsyncClient(timeout=15, follow_redirects=False) as client,
                client.stream(
                    "GET",
                    DRIVE_BASE + path,
                    params=params,
                    headers={
                        "Authorization": f"Bearer {access_token}",
                        "Accept-Encoding": "identity",
                    },
                ) as response,
            ):
                if response.status_code == 401:
                    raise DriveReadError("reconnect_required")
                if response.status_code in {403, 404, 410}:
                    raise DriveReadError("source_unavailable")
                if response.status_code == 429 or response.status_code >= 500:
                    raise DriveReadError("provider_unavailable", retryable=True)
                if response.status_code != 200:
                    raise DriveReadError("provider_response_invalid")
                # HTTPX's decompressor can allocate beyond our budget before
                # aiter_bytes yields. Request identity and refuse compression;
                # never trust Content-Length or transparently inflate content.
                if response.headers.get("Content-Encoding", "identity").lower() != "identity":
                    raise DriveReadError("provider_response_invalid")
                body = bytearray()
                async for chunk in response.aiter_raw():
                    if len(body) + len(chunk) > limit:
                        raise DriveReadError("file_too_large")
                    body.extend(chunk)
                return bytes(body)
        except (httpx.HTTPError, TimeoutError):
            raise DriveReadError("provider_unavailable", retryable=True) from None

    async def account(self, *, access_token: str) -> dict[str, str]:
        result = _decode_json(
            await self._get(
                "/about",
                access_token=access_token,
                params={"fields": "user(permissionId,emailAddress,me)"},
                limit=METADATA_LIMIT,
            )
        )
        user = result.get("user")
        if not isinstance(user, dict) or user.get("me") is not True:
            raise DriveReadError("identity_not_verified")
        subject = user.get("permissionId")
        if not isinstance(subject, str) or not 1 <= len(subject) <= 255:
            raise DriveReadError("identity_not_verified")
        email = user.get("emailAddress")
        # Provider label only. Never substitute an email for principal identity.
        label = email if isinstance(email, str) and 1 <= len(email) <= 254 else "Google account"
        return {"identityKind": "drive_permission_id", "subject": subject, "accountLabel": label}

    async def get_metadata(
        self,
        *,
        file_id: str,
        access_token: str,
        require_app_authorized: bool = True,
        require_genai_eligibility: bool = True,
    ) -> DriveMetadata:
        result = _decode_json(
            await self._get(
                _file_path(file_id),
                access_token=access_token,
                params={"fields": METADATA_FIELDS, "supportsAllDrives": "true"},
                limit=METADATA_LIMIT,
            )
        )
        capabilities = result.get("capabilities")
        encryption = result.get("clientEncryptionDetails")
        if (
            result.get("id") != file_id
            or result.get("trashed") is not False
            or require_app_authorized
            and result.get("isAppAuthorized") is not True
            or not isinstance(capabilities, dict)
            or require_genai_eligibility
            and capabilities.get("canAccessViaGenAi") is not True
            or capabilities.get("canDownload") is not True
            or (
                encryption is not None
                and (
                    not isinstance(encryption, dict)
                    or encryption.get("encryptionState") != "unencrypted"
                )
            )
        ):
            raise DriveReadError("source_unavailable")
        mime = result.get("mimeType")
        # Shortcuts are not followed: owner must explicitly select the target.
        # Folders, Sheets, archives, binaries requiring new parsers also fail.
        if not isinstance(mime, str) or mime not in (
            SUPPORTED_TYPES if require_app_authorized else LIVE_SUPPORTED_TYPES
        ):
            raise DriveReadError("unsupported_format")
        name, version, modified = (result.get(key) for key in ("name", "version", "modifiedTime"))
        if (
            not isinstance(name, str)
            or not 1 <= len(name) <= 1024
            or not isinstance(version, str)
            or not re.fullmatch(r"[0-9]{1,30}", version)
            or not isinstance(modified, str)
            or not 1 <= len(modified) <= 64
        ):
            raise DriveReadError("provider_response_invalid")
        size = result.get("size")
        if size is not None:
            if not isinstance(size, str) or not re.fullmatch(r"[0-9]{1,20}", size):
                raise DriveReadError("provider_response_invalid")
            size = int(size)
            if require_app_authorized and size > CONTENT_LIMIT:
                raise DriveReadError("file_too_large")
        elif require_app_authorized and mime in BINARY_TYPES:
            raise DriveReadError("provider_response_invalid")
        checksum = result.get("md5Checksum")
        if checksum is not None and (
            not isinstance(checksum, str) or not re.fullmatch(r"[0-9a-fA-F]{32}", checksum)
        ):
            raise DriveReadError("provider_response_invalid")
        return DriveMetadata(file_id, name, mime, version, modified, size, checksum)

    async def fetch_content(
        self,
        *,
        file_id: str,
        access_token: str,
        require_current: Callable[[], Awaitable[object]] | None = None,
    ) -> DriveContent:
        try:
            async with asyncio.timeout(DEADLINE_SECONDS):
                if require_current:
                    await require_current()
                before = await self.get_metadata(file_id=file_id, access_token=access_token)
                export_mime = EXPORTS.get(before.mime_type)
                if require_current:
                    await require_current()
                content = await self._get(
                    _file_path(file_id) + ("/export" if export_mime else ""),
                    access_token=access_token,
                    params={"mimeType": export_mime}
                    if export_mime
                    else {"alt": "media", "supportsAllDrives": "true"},
                    limit=CONTENT_LIMIT,
                )
                # Permission and version recheck is mandatory even for empty bytes.
                if require_current:
                    await require_current()
                after = await self.get_metadata(file_id=file_id, access_token=access_token)
                if require_current:
                    await require_current()
                if before != after:
                    raise DriveReadError("source_changed", retryable=True)
                return DriveContent(before, export_mime or before.mime_type, content)
        except TimeoutError:
            raise DriveReadError("provider_unavailable", retryable=True) from None
