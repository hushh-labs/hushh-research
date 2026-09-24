"""Fixed Drive ACL transport, separate from the read-only/agent tool adapter.

The domain executor owns exact-file approval, verified recipient identity,
same-file serialization, existing-ACL detection and durable reconciliation.
This adapter never retries a mutation or infers provenance from an ACL match.
"""

from __future__ import annotations

import asyncio
import json
import re
from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field
from datetime import datetime
from typing import Any

import httpx
from opentelemetry.instrumentation.utils import suppress_instrumentation

from hushh_mcp.services.google_drive_adapter import (
    DRIVE_BASE,
    FILE_ID,
    LIVE_SUPPORTED_TYPES,
    SUPPORTED_TYPES,
    DriveReadError,
)

DEADLINE_SECONDS = 20
RESPONSE_LIMIT = 256 * 1024
PAGE_LIMIT = 3
PERMISSION_LIMIT = 200
FILE_FIELDS = (
    "id,version,mimeType,modifiedTime,createdTime,trashed,isAppAuthorized,"
    "capabilities(canShare,canDownload,canAccessViaGenAi),"
    "clientEncryptionDetails(encryptionState)"
)
PERMISSION_FIELDS = (
    "id,type,role,emailAddress,domain,deleted,pendingOwner,expirationTime,"
    "permissionDetails(inherited,inheritedFrom,permissionType,role)"
)
LIST_FIELDS = f"nextPageToken,permissions({PERMISSION_FIELDS})"
VERSION = re.compile(r"[0-9]{1,30}\Z")
EMAIL = re.compile(r'[^@\s<>"(),;:\\]+@[^@\s<>"(),;:\\]+\.[^@\s<>"(),;:\\]+\Z')
ROLES = frozenset({"owner", "organizer", "fileOrganizer", "writer", "commenter", "reader"})
KINDS = frozenset({"user", "group", "domain", "anyone"})
Fence = Callable[[], Awaitable[object]]


class DrivePermissionError(DriveReadError):
    def __init__(self, code: str, *, outcome_unknown: bool = False, retryable: bool = False):
        super().__init__(code, retryable=retryable)
        self.outcome_unknown = outcome_unknown


@dataclass(frozen=True)
class PermissionSnapshot:
    permissions: tuple[dict, ...] = field(repr=False)


@dataclass(frozen=True)
class CreatedReader:
    permission_id: str = field(repr=False)
    email: str = field(repr=False)


def _unknown() -> DrivePermissionError:
    return DrivePermissionError("permission_outcome_unknown", outcome_unknown=True)


def _invalid(mutation: bool = False) -> DrivePermissionError:
    return _unknown() if mutation else DrivePermissionError("permission_response_invalid")


def _identifier(value: object) -> str:
    if not isinstance(value, str) or not FILE_ID.fullmatch(value):
        raise DrivePermissionError("operation_not_allowed")
    return value


def _email(value: object) -> str:
    if (
        not isinstance(value, str)
        or not value.isascii()
        or not 3 <= len(value) <= 254
        or not EMAIL.fullmatch(value)
    ):
        raise DrivePermissionError("recipient_not_verified")
    # Syntax validation is NOT identity verification; preserve the bound address.
    return value


def _permission(value: object) -> dict:
    if not isinstance(value, dict):
        raise _invalid()
    identifier, kind, role = (value.get(key) for key in ("id", "type", "role"))
    if (
        not isinstance(identifier, str)
        or not FILE_ID.fullmatch(identifier)
        or not isinstance(kind, str)
        or kind not in KINDS
        or not isinstance(role, str)
        or role not in ROLES
    ):
        raise _invalid()
    result: dict[str, Any] = {"id": identifier, "type": kind, "role": role}
    for key, maximum in (("emailAddress", 254), ("domain", 253), ("expirationTime", 64)):
        if key in value:
            item = value[key]
            if (
                not isinstance(item, str)
                or not 1 <= len(item) <= maximum
                or any(ord(char) < 32 for char in item)
            ):
                raise _invalid()
            result[key] = item
    for key in ("deleted", "pendingOwner"):
        if key in value:
            if type(value[key]) is not bool:
                raise _invalid()
            result[key] = value[key]
    if "permissionDetails" in value:
        details = value["permissionDetails"]
        if not isinstance(details, list) or len(details) > 16:
            raise _invalid()
        result["permissionDetails"] = []
        for detail in details:
            if (
                not isinstance(detail, dict)
                or type(detail.get("inherited")) is not bool
                or detail.get("permissionType") not in ("file", "member")
                or detail.get("role") not in tuple(ROLES)
            ):
                raise _invalid()
            kept = {key: detail[key] for key in ("inherited", "permissionType", "role")}
            if "inheritedFrom" in detail:
                source = detail["inheritedFrom"]
                if not isinstance(source, str) or not FILE_ID.fullmatch(source):
                    raise _invalid()
                kept["inheritedFrom"] = source
            result["permissionDetails"].append(kept)
    # Missing inheritance evidence stays missing, never inferred as direct.
    return result


class GoogleDrivePermissionAdapter:
    async def _exchange(
        self,
        operation: str,
        *,
        file_id: str,
        access_token: str,
        require_current: Fence,
        email: str | None = None,
        permission_id: str | None = None,
        page_token: str | None = None,
    ) -> dict:
        path = f"/files/{_identifier(file_id)}"
        body, method = None, "GET"
        params = {"supportsAllDrives": "true"}
        if operation == "inspect" and email is permission_id is page_token is None:
            params["fields"] = FILE_FIELDS
        elif operation == "list" and email is permission_id is None:
            path += "/permissions"
            params.update({"fields": LIST_FIELDS, "pageSize": "100"})
            if page_token is not None:
                if (
                    not isinstance(page_token, str)
                    or not 1 <= len(page_token) <= 4096
                    or any(ord(char) < 32 for char in page_token)
                ):
                    raise _invalid()
                params["pageToken"] = page_token
        elif operation == "create" and permission_id is page_token is None:
            method, path = "POST", path + "/permissions"
            body = {"type": "user", "role": "reader", "emailAddress": _email(email)}
            params.update({"fields": PERMISSION_FIELDS, "sendNotificationEmail": "false"})
        elif operation == "remove" and email is page_token is None:
            method = "DELETE"
            path += f"/permissions/{_identifier(permission_id)}"
        else:
            raise DrivePermissionError("operation_not_allowed")
        if (
            not isinstance(access_token, str)
            or not 1 <= len(access_token) <= 16384
            or any(ord(char) < 32 for char in access_token)
        ):
            raise DrivePermissionError("reconnect_required")
        mutation = method != "GET"
        try:
            with suppress_instrumentation():
                async with asyncio.timeout(DEADLINE_SECONDS):
                    await require_current()
                    async with httpx.AsyncClient(
                        timeout=15, follow_redirects=False, trust_env=False
                    ) as client:
                        kwargs: dict[str, Any] = {
                            "params": params,
                            "headers": {
                                "Authorization": f"Bearer {access_token}",
                                "Accept-Encoding": "identity",
                            },
                        }
                        if body is not None:
                            kwargs["json"] = body
                        async with client.stream(method, DRIVE_BASE + path, **kwargs) as response:
                            status = response.status_code
                            if status == 401:
                                raise DrivePermissionError("reconnect_required")
                            if status in (403, 404, 410):
                                # A hidden file is not verified permission absence.
                                raise DrivePermissionError("permission_target_unavailable")
                            if mutation and (
                                status >= 500 or status in (408, 429) or 300 <= status < 400
                            ):
                                raise _unknown()
                            if not mutation and (status == 429 or status >= 500):
                                raise DrivePermissionError(
                                    "permission_provider_unavailable", retryable=True
                                )
                            expected = (200, 204) if operation == "remove" else (200,)
                            if status not in expected:
                                if mutation and 400 <= status < 500:
                                    raise DrivePermissionError("permission_rejected")
                                raise _invalid(mutation)
                            if (
                                response.headers.get("Content-Encoding", "identity").lower()
                                != "identity"
                            ):
                                raise _invalid(mutation)
                            data = bytearray()
                            async for chunk in response.aiter_raw():
                                if len(data) + len(chunk) > RESPONSE_LIMIT:
                                    raise _invalid(mutation)
                                data.extend(chunk)
                            if operation == "remove" and not data:
                                return {}
                            try:
                                result = json.loads(data)
                            except (ValueError, UnicodeError, RecursionError):
                                raise _invalid(mutation) from None
                            if not isinstance(result, dict):
                                raise _invalid(mutation)
                            if operation == "remove" and result:
                                raise _unknown()
                            return result
        except (httpx.HTTPError, TimeoutError):
            if mutation:
                raise _unknown() from None
            raise DrivePermissionError("permission_provider_unavailable", retryable=True) from None
        # Cancellation propagates: the caller's dispatching record must reconcile.

    async def inspect_shareable(
        self,
        *,
        file_id: str,
        expected_version: str,
        access_token: str,
        require_current: Fence,
        require_app_authorized: bool = True,
        require_genai_eligibility: bool = True,
        metadata_only: bool = False,
        time_field: str | None = None,
        start_time: str | None = None,
        end_time: str | None = None,
    ) -> None:
        if not isinstance(expected_version, str) or not VERSION.fullmatch(expected_version):
            raise DrivePermissionError("operation_not_allowed")
        result = await self._exchange(
            "inspect", file_id=file_id, access_token=access_token, require_current=require_current
        )
        capabilities, encryption = result.get("capabilities"), result.get("clientEncryptionDetails")
        mime = result.get("mimeType")
        if (
            result.get("id") != file_id
            or result.get("trashed") is not False
            or require_app_authorized
            and result.get("isAppAuthorized") is not True
            or not isinstance(mime, str)
            or not mime
            or (
                mime
                in {"application/vnd.google-apps.folder", "application/vnd.google-apps.shortcut"}
                if metadata_only
                else mime
                not in (SUPPORTED_TYPES if require_app_authorized else LIVE_SUPPORTED_TYPES)
            )
            or not isinstance(capabilities, dict)
            or capabilities.get("canShare") is not True
            or not metadata_only
            and capabilities.get("canDownload") is not True
            or require_genai_eligibility
            and capabilities.get("canAccessViaGenAi") is not True
            or (
                encryption is not None
                and (
                    not isinstance(encryption, dict)
                    or encryption.get("encryptionState") != "unencrypted"
                )
            )
        ):
            raise DrivePermissionError("source_not_shareable")
        if result.get("version") != expected_version:
            raise DrivePermissionError("source_changed")
        if metadata_only:
            if time_field not in {"modifiedTime", "createdTime"} or not all(
                isinstance(value, str)
                and re.fullmatch(r"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z", value)
                for value in (start_time, end_time)
            ):
                raise DrivePermissionError("operation_not_allowed")
            observed = result.get(time_field)
            try:
                if not isinstance(observed, str) or not (
                    datetime.fromisoformat(start_time.replace("Z", "+00:00"))
                    <= datetime.fromisoformat(observed.replace("Z", "+00:00"))
                    < datetime.fromisoformat(end_time.replace("Z", "+00:00"))
                ):
                    raise DrivePermissionError("source_changed")
            except (TypeError, ValueError):
                raise DrivePermissionError("source_changed") from None
        await require_current()

    async def list_permissions(
        self, *, file_id: str, access_token: str, require_current: Fence
    ) -> PermissionSnapshot:
        permissions, seen_ids, seen_tokens = [], set(), set()
        page_token = None
        try:
            async with asyncio.timeout(DEADLINE_SECONDS):
                for _ in range(PAGE_LIMIT):
                    result = await self._exchange(
                        "list",
                        file_id=file_id,
                        access_token=access_token,
                        require_current=require_current,
                        page_token=page_token,
                    )
                    rows = result.get("permissions", [])
                    if not isinstance(rows, list) or len(rows) > 100:
                        raise _invalid()
                    for raw in rows:
                        permission = _permission(raw)
                        if permission["id"] in seen_ids:
                            raise DrivePermissionError("permission_catalog_changed")
                        seen_ids.add(permission["id"])
                        permissions.append(permission)
                    if len(permissions) > PERMISSION_LIMIT:
                        raise DrivePermissionError("permission_catalog_too_large")
                    page_token = result.get("nextPageToken")
                    if page_token is None:
                        await require_current()
                        return PermissionSnapshot(tuple(permissions))
                    if (
                        not isinstance(page_token, str)
                        or not 1 <= len(page_token) <= 4096
                        or page_token in seen_tokens
                        or len(permissions) >= PERMISSION_LIMIT
                    ):
                        raise DrivePermissionError("permission_catalog_incomplete")
                    seen_tokens.add(page_token)
        except TimeoutError:
            raise DrivePermissionError("permission_provider_unavailable", retryable=True) from None
        raise DrivePermissionError("permission_catalog_incomplete")

    async def inspect_permission_management(
        self, *, file_id, access_token, require_current, require_app_authorized=True
    ):
        result = await self._exchange(
            "inspect", file_id=file_id, access_token=access_token, require_current=require_current
        )
        capabilities = result.get("capabilities")
        if (
            result.get("id") != file_id
            or require_app_authorized
            and result.get("isAppAuthorized") is not True
            or not isinstance(result.get("mimeType"), str)
            or not result["mimeType"]
            or result["mimeType"]
            in {"application/vnd.google-apps.folder", "application/vnd.google-apps.shortcut"}
            or not isinstance(capabilities, dict)
            or capabilities.get("canShare") is not True
        ):
            raise DrivePermissionError("permission_target_unavailable")
        await require_current()

    async def create_reader(
        self, *, file_id: str, verified_email: str, access_token: str, require_current: Fence
    ) -> CreatedReader:
        result = await self._exchange(
            "create",
            file_id=file_id,
            email=verified_email,
            access_token=access_token,
            require_current=require_current,
        )
        try:
            permission = _permission(result)
        except DrivePermissionError:
            raise _unknown() from None
        if (
            permission["type"] != "user"
            or permission["role"] != "reader"
            or permission.get("emailAddress", "").casefold() != verified_email.casefold()
            or permission.get("deleted") is True
            or permission.get("pendingOwner") is True
            or permission.get("expirationTime") is not None
        ):
            raise _unknown()
        # Record success even if owner disconnects while Google is responding.
        return CreatedReader(permission["id"], permission["emailAddress"])

    async def remove_recorded_permission(
        self,
        *,
        file_id: str,
        recorded_permission_id: str,
        access_token: str,
        require_current: Fence,
    ) -> None:
        await self._exchange(
            "remove",
            file_id=file_id,
            permission_id=recorded_permission_id,
            access_token=access_token,
            require_current=require_current,
        )
