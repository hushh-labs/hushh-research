"""Fixed, bounded REST reads for explicitly selected Drive files.

Internal transport only: callers must validate owner/selection/generation before
and after I/O. No listing, caller-selected URLs/queries, mutations or MCP path.
Provider identifiers and bytes must never enter model arguments or telemetry.
"""

from __future__ import annotations

import asyncio
import hashlib
import json
import logging
import re
import time
from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field
from typing import Any

import httpx
from opentelemetry.instrumentation.utils import suppress_instrumentation

logger = logging.getLogger(__name__)

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
SHARE_METADATA_FIELDS = (
    "id,name,mimeType,version,modifiedTime,createdTime,trashed,"
    "capabilities(canShare),clientEncryptionDetails(encryptionState)"
)
# Metadata-only live read for a file with no readable text (a video, an image,
# an archive, a folder): what it is and where to open it, never its bytes.
FACT_FIELDS = "id,name,mimeType,modifiedTime,size,webViewLink,trashed"
# Live search: one bounded files.list shape, never a caller-chosen field set.
LIST_FIELDS = (
    "nextPageToken,incompleteSearch,files(id,name,mimeType,modifiedTime,createdTime,webViewLink)"
)
# Drive sorts each key ascending unless told "desc"; live results are newest
# first by the file time the owner asked about. modifiedTime is the default and
# the time sort Drive optimizes on large collections.
LIST_ORDERS = frozenset({"recency desc", "modifiedTime desc", "createdTime desc"})
LIST_FIXED = {
    "fields": LIST_FIELDS,
    "supportsAllDrives": "true",
    "includeItemsFromAllDrives": "true",
    "corpora": "user",
}
EXPORTS = {
    "application/vnd.google-apps.document": "text/plain",
    "application/vnd.google-apps.presentation": "text/plain",
}
# Live lane only. A Sheets CSV export holds the first sheet only, so every
# Sheets read is partial; the selected lane still refuses Sheets. A Google Doc
# exports as Markdown so headings, lists and tables keep their structure
# (https://developers.google.com/workspace/drive/api/guides/ref-export-formats);
# Slides has no Markdown export and stays plain text.
LIVE_EXPORTS = {
    **EXPORTS,
    "application/vnd.google-apps.document": "text/markdown",
    "application/vnd.google-apps.spreadsheet": "text/csv",
}
# Markdown carries each image inline, so a picture-heavy Doc can pass the
# CONTENT_LIMIT, or Google's 10 MB export limit (a 403), where its plain text
# does not. Such a Doc is read once more as plain text under the same bound.
LIVE_EXPORT_FALLBACKS = {"application/vnd.google-apps.document": "text/plain"}
_LIVE_EXPORT_FALLBACK_CODES = frozenset({"file_too_large", "source_unavailable"})
_LIVE_EXPORT_TYPES = frozenset({*LIVE_EXPORTS.values(), *LIVE_EXPORT_FALLBACKS.values()})
LIVE_PARTIAL_EXPORTS = frozenset({"application/vnd.google-apps.spreadsheet"})
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
        "text/csv",
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
    created_time: str | None = None


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
        # Fixed operation names only. The path can contain a private provider ID
        # and params can contain the owner's search, so neither is logged.
        operation = (
            "list"
            if path == "/files"
            else "list_drives"
            if path == "/drives"
            else "account"
            if path == "/about"
            else "export"
            if path.endswith("/export")
            else "content"
            if params.get("alt") == "media"
            else "metadata"
            if path.startswith("/files/")
            else "invalid"
        )
        started = time.perf_counter()
        outcome = "error"
        # Provider identifiers must not reach the global HTTPX trace exporter.
        try:
            with suppress_instrumentation():
                result = await self._get_private(
                    path, access_token=access_token, params=params, limit=limit
                )
            outcome = "ok"
            return result
        except DriveReadError as error:
            outcome = (
                str(error)
                if str(error)
                in {
                    "reconnect_required",
                    "source_unavailable",
                    "provider_unavailable",
                    "provider_response_invalid",
                    "file_too_large",
                    "operation_not_allowed",
                }
                else "error"
            )
            raise
        except asyncio.CancelledError:
            outcome = "cancelled"
            raise
        finally:
            logger.info(
                "drive_rest.timing operation=%s outcome=%s duration_ms=%.2f",
                operation,
                outcome,
                (time.perf_counter() - started) * 1000,
            )

    async def _get_private(
        self, path: str, *, access_token: str, params: dict[str, str], limit: int
    ) -> bytes:
        # This is not a general HTTP executor. Even internal callers cannot
        # supply an origin, arbitrary query, mutation, or unbounded response.
        if path == "/about":
            allowed = params == {"fields": "user(permissionId,emailAddress,me)"}
        elif path == "/files":
            allowed = (
                all(
                    params.get(key) == value
                    for key, value in LIST_FIXED.items()
                    if key != "corpora"
                )
                and (
                    params.get("corpora") == "user"
                    and "driveId" not in params
                    or params.get("corpora") == "drive"
                    and FILE_ID.fullmatch(params.get("driveId", "")) is not None
                )
                and set(params) <= {*LIST_FIXED, "q", "pageSize", "pageToken", "orderBy", "driveId"}
                and re.fullmatch(r"[1-9]|1\d|2[0-5]", params.get("pageSize", "")) is not None
                and len(params.get("q", "")) <= 4096
                and len(params.get("pageToken", "")) <= 1024
                and params.get("orderBy", "modifiedTime desc") in LIST_ORDERS
            )
        elif path == "/drives":
            allowed = (
                params.get("fields") == "nextPageToken,drives(id,name)"
                and set(params) <= {"fields", "pageSize", "pageToken"}
                and re.fullmatch(r"[1-9]|1\d|2[0-5]", params.get("pageSize", "")) is not None
                and len(params.get("pageToken", "")) <= 1024
            )
        elif re.fullmatch(r"/files/[A-Za-z0-9_-]{1,200}(?:/export)?", path):
            allowed = (
                not path.endswith("/export")
                and params
                in (
                    {"fields": METADATA_FIELDS, "supportsAllDrives": "true"},
                    {"fields": SHARE_METADATA_FIELDS, "supportsAllDrives": "true"},
                    {"fields": FACT_FIELDS, "supportsAllDrives": "true"},
                    {"alt": "media", "supportsAllDrives": "true"},
                )
            ) or (
                path.endswith("/export")
                and len(params) == 1
                and params.get("mimeType") in _LIVE_EXPORT_TYPES
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
                    # No URL, query, token, file ID or provider body reaches logs.
                    logger.warning(
                        "drive_rest.transient_failure operation=%s reason=%s",
                        "list" if path == "/files" else "file",
                        "rate_limited" if response.status_code == 429 else "server_error",
                    )
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
        except (httpx.HTTPError, TimeoutError) as error:
            logger.warning(
                "drive_rest.transient_failure operation=%s reason=%s",
                "list" if path == "/files" else "file",
                "timeout"
                if isinstance(error, (httpx.TimeoutException, TimeoutError))
                else "transport",
            )
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

    async def get_file_facts(self, *, file_id: str, access_token: str) -> dict[str, Any]:
        """Name, type, time, size and opening link of one live file, without content."""
        result = _decode_json(
            await self._get(
                _file_path(file_id),
                access_token=access_token,
                params={"fields": FACT_FIELDS, "supportsAllDrives": "true"},
                limit=METADATA_LIMIT,
            )
        )
        name, mime = result.get("name"), result.get("mimeType")
        if (
            result.get("id") != file_id
            or result.get("trashed") is not False
            or not isinstance(name, str)
            or not isinstance(mime, str)
        ):
            raise DriveReadError("source_unavailable")
        size, modified, link = (result.get(key) for key in ("size", "modifiedTime", "webViewLink"))
        return {
            "id": file_id,
            "title": name[:1024],
            "mimeType": mime[:255],
            "modifiedTime": modified if isinstance(modified, str) and len(modified) <= 64 else None,
            "size": int(size)
            if isinstance(size, str) and re.fullmatch(r"[0-9]{1,20}", size)
            else None,
            "viewUrl": link if isinstance(link, str) and link.startswith("https://") else None,
        }

    async def get_share_metadata(self, *, file_id: str, access_token: str) -> DriveMetadata:
        """Check an exact live file for sharing without requiring content access."""
        result = _decode_json(
            await self._get(
                _file_path(file_id),
                access_token=access_token,
                params={"fields": SHARE_METADATA_FIELDS, "supportsAllDrives": "true"},
                limit=METADATA_LIMIT,
            )
        )
        mime = result.get("mimeType")
        capabilities = result.get("capabilities")
        encryption = result.get("clientEncryptionDetails")
        if (
            result.get("id") != file_id
            or result.get("trashed") is not False
            or not isinstance(mime, str)
            or not mime
            or mime
            in {
                "application/vnd.google-apps.folder",
                "application/vnd.google-apps.shortcut",
            }
            or not isinstance(capabilities, dict)
            or capabilities.get("canShare") is not True
            or encryption is not None
            and (
                not isinstance(encryption, dict)
                or encryption.get("encryptionState") != "unencrypted"
            )
        ):
            raise DriveReadError("source_unavailable")
        name, version, modified = (result.get(key) for key in ("name", "version", "modifiedTime"))
        created = result.get("createdTime")
        if (
            not isinstance(name, str)
            or not 1 <= len(name) <= 1024
            or not isinstance(version, str)
            or not re.fullmatch(r"[0-9]{1,30}", version)
            or not isinstance(modified, str)
            or not 1 <= len(modified) <= 64
            or created is not None
            and (not isinstance(created, str) or not 1 <= len(created) <= 64)
        ):
            raise DriveReadError("provider_response_invalid")
        return DriveMetadata(file_id, name, mime, version, modified, None, None, created)

    async def list_files(
        self,
        *,
        access_token: str,
        query: str,
        page_size: int,
        page_token: str | None = None,
        order_by: str | None = None,
        drive_id: str | None = None,
    ) -> dict[str, Any]:
        """One bounded Drive REST search page (the GA API the picker lane already uses)."""
        if (
            not isinstance(page_size, int)
            or isinstance(page_size, bool)
            or not 1 <= page_size <= 25
        ):
            raise DriveReadError("invalid_argument")
        if drive_id is not None and (
            not isinstance(drive_id, str) or not FILE_ID.fullmatch(drive_id)
        ):
            raise DriveReadError("invalid_argument")
        params = {**LIST_FIXED, "q": query, "pageSize": str(page_size)}
        if drive_id is not None:
            params.update(corpora="drive", driveId=drive_id)
        if page_token:
            params["pageToken"] = page_token
        if order_by:
            params["orderBy"] = order_by
        return _decode_json(
            await self._get(
                "/files", access_token=access_token, params=params, limit=METADATA_LIMIT
            )
        )

    async def list_drives(
        self, *, access_token: str, page_size: int = 25, page_token: str | None = None
    ) -> dict[str, Any]:
        """One bounded page of shared drives visible under the current owner grant."""
        if (
            not isinstance(page_size, int)
            or isinstance(page_size, bool)
            or not 1 <= page_size <= 25
        ):
            raise DriveReadError("invalid_argument")
        params = {"fields": "nextPageToken,drives(id,name)", "pageSize": str(page_size)}
        if page_token:
            params["pageToken"] = page_token
        return _decode_json(
            await self._get(
                "/drives", access_token=access_token, params=params, limit=METADATA_LIMIT
            )
        )

    async def read_live_bytes(
        self, *, file_id: str, mime_type: str, access_token: str
    ) -> tuple[str, bytes]:
        """Content of a file the owner's live grant can read (export for Docs/Slides/Sheets)."""
        export_mime = LIVE_EXPORTS.get(mime_type)
        if not export_mime:
            content = await self._get(
                _file_path(file_id),
                access_token=access_token,
                params={"alt": "media", "supportsAllDrives": "true"},
                limit=CONTENT_LIMIT,
            )
            return mime_type, content
        try:
            return export_mime, await self._export(file_id, export_mime, access_token)
        except DriveReadError as error:
            fallback = LIVE_EXPORT_FALLBACKS.get(mime_type)
            if not fallback or str(error) not in _LIVE_EXPORT_FALLBACK_CODES:
                raise
        return fallback, await self._export(file_id, fallback, access_token)

    async def _export(self, file_id: str, export_mime: str, access_token: str) -> bytes:
        return await self._get(
            _file_path(file_id) + "/export",
            access_token=access_token,
            params={"mimeType": export_mime},
            limit=CONTENT_LIMIT,
        )

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
