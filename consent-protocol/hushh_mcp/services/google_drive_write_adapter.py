"""Fixed Drive REST writes for the owner's live (full ``drive``) grant.

Internal transport only. Callers own the owner, grant and generation checks
before and after each call (see ``GoogleDriveRestTransport.write_tool``), and
the reviewed-write executor owns approval for sharing and trashing. This is not
a general HTTP executor: each operation has a fixed method, path shape, query
and response field set, and a bounded response. A mutation is never retried; a
transport failure after dispatch is reported as an unknown outcome. No file ID,
name, email, content, URL, token or provider body is logged.
"""

from __future__ import annotations

import asyncio
import json
import logging
import re
import time
import uuid
from contextvars import ContextVar
from dataclasses import dataclass
from typing import Any, Literal

import httpx
from opentelemetry.instrumentation.utils import suppress_instrumentation

from hushh_mcp.services.google_drive_adapter import DRIVE_BASE, FILE_ID, DriveReadError

logger = logging.getLogger(__name__)

UPLOAD_BASE = "https://www.googleapis.com/upload/drive/v3"
DEADLINE_SECONDS = 20
RESPONSE_LIMIT = 64 * 1024
# A created Doc or Sheet is written from text the model composed; keep it well
# inside Google's import limits and the model's own output budget.
MAX_CONTENT_BYTES = 1024 * 1024
MAX_NAME_CHARS = 255
MAX_COMMENT_CHARS = 4_000
MAX_SHARE_MESSAGE_CHARS = 1_000
FOLDER_MIME = "application/vnd.google-apps.folder"
DOCUMENT_MIME = "application/vnd.google-apps.document"
SPREADSHEET_MIME = "application/vnd.google-apps.spreadsheet"
FILE_FIELDS = "id,name,mimeType,webViewLink"
FACT_FIELDS = (
    "id,name,mimeType,parents,trashed,ownedByMe,shared,driveId,webViewLink,"
    "capabilities(canAddChildren)"
)
COMMENT_FIELDS = "id,createdTime"
PERMISSION_FIELDS = "id,type,role"
SHARE_ROLES = frozenset({"reader", "commenter", "writer"})
# Google Drive converts these uploads to a native Doc or Sheet on create.
CONTENT_IMPORTS = {
    ("document", "markdown"): (DOCUMENT_MIME, "text/markdown"),
    ("document", "text"): (DOCUMENT_MIME, "text/plain"),
    ("spreadsheet", "csv"): (SPREADSHEET_MIME, "text/csv"),
}
KIND_MIME = {"document": DOCUMENT_MIME, "spreadsheet": SPREADSHEET_MIME, "folder": FOLDER_MIME}
EMAIL = re.compile(r'[^@\s<>"(),;:\\]+@[^@\s<>"(),;:\\]+\.[^@\s<>"(),;:\\]+\Z')
_SAFE_OUTCOMES = frozenset(
    {
        "reconnect_required",
        "source_unavailable",
        "write_rejected",
        "write_outcome_unknown",
        "provider_unavailable",
        "provider_response_invalid",
        "operation_not_allowed",
        "invalid_argument",
    }
)

# Set by the caller that owns one write (``GoogleDriveRestTransport.write_tool``);
# flipped here the moment a mutation leaves for Google. Per request, never shared.
MUTATION_SENT: ContextVar[dict[str, bool] | None] = ContextVar("drive_mutation_sent", default=None)

FileKind = Literal["document", "spreadsheet", "folder"]
ContentFormat = Literal["markdown", "text", "csv"]


class DriveWriteError(DriveReadError):
    """Only authored codes cross this boundary; ``outcome_unknown`` is never retried."""

    def __init__(
        self, code: str, *, outcome_unknown: bool = False, provider_answered: bool = False
    ):
        super().__init__(code)
        self.outcome_unknown = outcome_unknown
        # Google answered with a definite refusal (401, 403/404/410, other 4xx):
        # the change was not applied, so this is not an unknown outcome.
        self.provider_answered = provider_answered


@dataclass(frozen=True)
class FileFacts:
    """What a direct write needs to know about an existing file or folder."""

    file_id: str
    mime_type: str
    parents: tuple[str, ...]
    trashed: bool
    owned_by_me: bool
    shared: bool
    shared_drive: bool
    can_add_children: bool

    @property
    def private_folder(self) -> bool:
        """A folder only the owner can see. Adding a file to any other folder shares it."""
        return (
            self.mime_type == FOLDER_MIME
            and not self.trashed
            and self.owned_by_me
            and not self.shared
            and not self.shared_drive
            and self.can_add_children
        )


def file_id(value: object) -> str:
    if not isinstance(value, str) or not FILE_ID.fullmatch(value):
        raise DriveWriteError("invalid_argument")
    return value


def file_name(value: object) -> str:
    if (
        not isinstance(value, str)
        or not value.strip()
        or len(value) > MAX_NAME_CHARS
        or any(ord(char) < 32 or ord(char) == 127 for char in value)
    ):
        raise DriveWriteError("invalid_argument")
    return value.strip()


def bounded_text(value: object, *, limit: int, allow_empty: bool = False) -> str:
    if (
        not isinstance(value, str)
        or (not allow_empty and not value.strip())
        or len(value) > limit
        or "\x00" in value
    ):
        raise DriveWriteError("invalid_argument")
    return value


def share_email(value: object) -> str:
    if (
        not isinstance(value, str)
        or not value.isascii()
        or not 3 <= len(value) <= 254
        or not EMAIL.fullmatch(value)
    ):
        raise DriveWriteError("invalid_argument")
    # Syntax only. The owner reviews this exact address before anything is sent.
    return value


def _project_file(payload: dict[str, Any]) -> dict[str, Any]:
    identifier, name, mime = (payload.get(key) for key in ("id", "name", "mimeType"))
    if (
        not isinstance(identifier, str)
        or not FILE_ID.fullmatch(identifier)
        or not isinstance(name, str)
        or not isinstance(mime, str)
    ):
        raise DriveWriteError("write_outcome_unknown", outcome_unknown=True)
    link = payload.get("webViewLink")
    return {
        "id": identifier,
        "title": name[:MAX_NAME_CHARS],
        "mimeType": mime[:255],
        "viewUrl": link if isinstance(link, str) and link.startswith("https://") else None,
    }


def _multipart(metadata: dict[str, Any], content: str, content_mime: str) -> tuple[bytes, str]:
    boundary = f"hussh-{uuid.uuid4().hex}"
    body = (
        (
            f"--{boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n"
            f"{json.dumps(metadata, ensure_ascii=False)}\r\n"
            f"--{boundary}\r\nContent-Type: {content_mime}; charset=UTF-8\r\n\r\n"
        ).encode()
        + content.encode("utf-8")
        + f"\r\n--{boundary}--\r\n".encode()
    )
    return body, f"multipart/related; boundary={boundary}"


def _malformed(mutation: bool) -> DriveWriteError:
    # A malformed answer to a sent mutation does not prove it failed.
    if mutation:
        return DriveWriteError("write_outcome_unknown", outcome_unknown=True)
    return DriveWriteError("provider_response_invalid")


class GoogleDriveWriteAdapter:
    async def facts(self, *, target: str, access_token: str) -> FileFacts:
        payload = await self._send(
            "facts",
            "GET",
            f"{DRIVE_BASE}/files/{file_id(target)}",
            access_token=access_token,
            params={"fields": FACT_FIELDS, "supportsAllDrives": "true"},
        )
        parents = payload.get("parents", [])
        capabilities = payload.get("capabilities")
        if (
            payload.get("id") != target
            or not isinstance(payload.get("mimeType"), str)
            or not isinstance(parents, list)
            or len(parents) > 16
            or any(not isinstance(item, str) or not FILE_ID.fullmatch(item) for item in parents)
            or not isinstance(capabilities, dict)
        ):
            raise DriveWriteError("provider_response_invalid")
        return FileFacts(
            file_id=target,
            mime_type=payload["mimeType"],
            parents=tuple(parents),
            trashed=payload.get("trashed") is True,
            owned_by_me=payload.get("ownedByMe") is True,
            # Unknown sharing state is treated as shared, never as private.
            shared=payload.get("shared") is not False,
            shared_drive=isinstance(payload.get("driveId"), str),
            can_add_children=capabilities.get("canAddChildren") is True,
        )

    async def create(
        self,
        *,
        access_token: str,
        name: str,
        kind: FileKind,
        parent: str | None,
        content: str = "",
        content_format: ContentFormat = "markdown",
    ) -> dict[str, Any]:
        if kind not in KIND_MIME:
            raise DriveWriteError("invalid_argument")
        metadata: dict[str, Any] = {"name": file_name(name), "mimeType": KIND_MIME[kind]}
        if parent is not None:
            metadata["parents"] = [file_id(parent)]
        params = {"fields": FILE_FIELDS, "supportsAllDrives": "true"}
        if not content:
            return _project_file(
                await self._send(
                    "create",
                    "POST",
                    f"{DRIVE_BASE}/files",
                    access_token=access_token,
                    params=params,
                    json_body=metadata,
                )
            )
        imported = CONTENT_IMPORTS.get((kind, content_format))
        if imported is None or len(content.encode("utf-8")) > MAX_CONTENT_BYTES:
            raise DriveWriteError("invalid_argument")
        target_mime, content_mime = imported
        body, content_type = _multipart(
            {**metadata, "mimeType": target_mime},
            bounded_text(content, limit=MAX_CONTENT_BYTES),
            content_mime,
        )
        return _project_file(
            await self._send(
                "create",
                "POST",
                f"{UPLOAD_BASE}/files",
                access_token=access_token,
                params={**params, "uploadType": "multipart"},
                raw_body=body,
                content_type=content_type,
            )
        )

    async def copy(
        self, *, access_token: str, source: str, name: str | None, parent: str | None
    ) -> dict[str, Any]:
        body: dict[str, Any] = {}
        if name is not None:
            body["name"] = file_name(name)
        # Always name the parent. Without one, Drive puts the copy beside its
        # source, which may be a shared folder, and that would share the copy.
        body["parents"] = [file_id(parent) if parent is not None else "root"]
        return _project_file(
            await self._send(
                "copy",
                "POST",
                f"{DRIVE_BASE}/files/{file_id(source)}/copy",
                access_token=access_token,
                params={"fields": FILE_FIELDS, "supportsAllDrives": "true"},
                json_body=body,
            )
        )

    async def update(
        self,
        *,
        access_token: str,
        target: str,
        name: str | None = None,
        add_parent: str | None = None,
        remove_parents: tuple[str, ...] = (),
        trash: bool = False,
    ) -> dict[str, Any]:
        """Rename, move, or (reviewed callers only) trash one file."""
        body: dict[str, Any] = {}
        params = {"fields": FILE_FIELDS, "supportsAllDrives": "true"}
        if name is not None:
            body["name"] = file_name(name)
        if add_parent is not None:
            params["addParents"] = file_id(add_parent)
            if remove_parents:
                params["removeParents"] = ",".join(file_id(item) for item in remove_parents)
        if trash:
            if body or add_parent is not None:
                raise DriveWriteError("operation_not_allowed")
            body["trashed"] = True
        if not body and add_parent is None:
            raise DriveWriteError("invalid_argument")
        return _project_file(
            await self._send(
                "trash" if trash else "update",
                "PATCH",
                f"{DRIVE_BASE}/files/{file_id(target)}",
                access_token=access_token,
                params=params,
                json_body=body,
            )
        )

    async def comment(self, *, access_token: str, target: str, text: str) -> dict[str, Any]:
        payload = await self._send(
            "comment",
            "POST",
            f"{DRIVE_BASE}/files/{file_id(target)}/comments",
            access_token=access_token,
            params={"fields": COMMENT_FIELDS},
            json_body={"content": bounded_text(text, limit=MAX_COMMENT_CHARS)},
        )
        identifier = payload.get("id")
        if not isinstance(identifier, str) or not FILE_ID.fullmatch(identifier):
            raise DriveWriteError("write_outcome_unknown", outcome_unknown=True)
        created = payload.get("createdTime")
        return {
            "commentId": identifier,
            "createdTime": created if isinstance(created, str) and len(created) <= 64 else None,
        }

    async def share(
        self,
        *,
        access_token: str,
        target: str,
        email: str,
        role: str,
        notify: bool,
        message: str = "",
    ) -> dict[str, Any]:
        """Reviewed callers only: add one user permission with an exact role."""
        if role not in SHARE_ROLES or type(notify) is not bool:
            raise DriveWriteError("invalid_argument")
        params = {
            "fields": PERMISSION_FIELDS,
            "supportsAllDrives": "true",
            "sendNotificationEmail": "true" if notify else "false",
        }
        if message:
            if not notify:
                raise DriveWriteError("invalid_argument")
            params["emailMessage"] = bounded_text(message, limit=MAX_SHARE_MESSAGE_CHARS)
        payload = await self._send(
            "share",
            "POST",
            f"{DRIVE_BASE}/files/{file_id(target)}/permissions",
            access_token=access_token,
            params=params,
            json_body={"type": "user", "role": role, "emailAddress": share_email(email)},
        )
        if payload.get("role") != role or payload.get("type") != "user":
            raise DriveWriteError("write_outcome_unknown", outcome_unknown=True)
        return {"role": role}

    async def _send(
        self,
        operation: str,
        method: Literal["GET", "POST", "PATCH"],
        url: str,
        *,
        access_token: str,
        params: dict[str, str],
        json_body: dict[str, Any] | None = None,
        raw_body: bytes | None = None,
        content_type: str | None = None,
    ) -> dict[str, Any]:
        started = time.perf_counter()
        outcome = "error"
        try:
            result = await self._send_private(
                method,
                url,
                access_token=access_token,
                params=params,
                json_body=json_body,
                raw_body=raw_body,
                content_type=content_type,
            )
            outcome = "ok"
            return result
        except DriveWriteError as error:
            outcome = str(error) if str(error) in _SAFE_OUTCOMES else "error"
            raise
        except asyncio.CancelledError:
            outcome = "cancelled"
            raise
        finally:
            logger.info(
                "drive_write_rest.timing operation=%s outcome=%s duration_ms=%.2f",
                operation,
                outcome,
                (time.perf_counter() - started) * 1000,
            )

    async def _send_private(
        self,
        method: Literal["GET", "POST", "PATCH"],
        url: str,
        *,
        access_token: str,
        params: dict[str, str],
        json_body: dict[str, Any] | None,
        raw_body: bytes | None,
        content_type: str | None,
    ) -> dict[str, Any]:
        if not url.startswith((DRIVE_BASE + "/files", UPLOAD_BASE + "/files")):
            raise DriveWriteError("operation_not_allowed")
        if (
            not isinstance(access_token, str)
            or not 1 <= len(access_token) <= 16384
            or any(ord(char) < 32 for char in access_token)
        ):
            raise DriveWriteError("reconnect_required")
        mutation = method != "GET"
        headers = {"Authorization": f"Bearer {access_token}", "Accept-Encoding": "identity"}
        kwargs: dict[str, Any] = {"params": params, "headers": headers}
        if raw_body is not None:
            headers["Content-Type"] = content_type or "application/octet-stream"
            kwargs["content"] = raw_body
        elif json_body is not None:
            kwargs["json"] = json_body
        dispatched = False
        try:
            # Provider identifiers must not reach the global HTTPX trace exporter.
            with suppress_instrumentation():
                async with (
                    asyncio.timeout(DEADLINE_SECONDS),
                    httpx.AsyncClient(
                        timeout=15, follow_redirects=False, trust_env=False
                    ) as client,
                ):
                    dispatched = True
                    sent = MUTATION_SENT.get()
                    if mutation and sent is not None:
                        sent["sent"] = True
                    async with client.stream(method, url, **kwargs) as response:
                        status = response.status_code
                        if status == 401:
                            raise DriveWriteError("reconnect_required", provider_answered=True)
                        if status in (403, 404, 410):
                            raise DriveWriteError("source_unavailable", provider_answered=True)
                        if mutation and (
                            status >= 500 or status in (408, 429) or 300 <= status < 400
                        ):
                            raise DriveWriteError("write_outcome_unknown", outcome_unknown=True)
                        if not mutation and (status == 429 or status >= 500):
                            raise DriveWriteError("provider_unavailable")
                        if status != 200:
                            raise DriveWriteError(
                                "write_rejected" if mutation else "provider_response_invalid",
                                provider_answered=True,
                            )
                        if (
                            response.headers.get("Content-Encoding", "identity").lower()
                            != "identity"
                        ):
                            raise _malformed(mutation)
                        data = bytearray()
                        async for chunk in response.aiter_raw():
                            if len(data) + len(chunk) > RESPONSE_LIMIT:
                                raise _malformed(mutation)
                            data.extend(chunk)
        except (httpx.HTTPError, TimeoutError):
            if mutation and dispatched:
                raise DriveWriteError("write_outcome_unknown", outcome_unknown=True) from None
            raise DriveWriteError("provider_unavailable") from None
        try:
            payload = json.loads(bytes(data))
        except (ValueError, UnicodeError):
            raise _malformed(mutation) from None
        if not isinstance(payload, dict):
            raise _malformed(mutation)
        return payload
