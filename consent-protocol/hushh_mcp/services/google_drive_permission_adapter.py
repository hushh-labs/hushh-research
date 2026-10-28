"""Fixed Drive ACL transport, separate from the read-only/agent tool adapter.

The domain executor owns exact-file approval, verified recipient identity,
same-file serialization, existing-ACL detection and durable reconciliation.
This adapter never retries a mutation or infers provenance from an ACL match.
"""

from __future__ import annotations

import asyncio
import json
import logging
import re
import time
from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field
from datetime import UTC, datetime, timedelta
from typing import Any

import httpx
from opentelemetry.instrumentation.utils import suppress_instrumentation

from hushh_mcp.services.google_drive_adapter import (
    DRIVE_BASE,
    FILE_ID,
    LIVE_SUPPORTED_TYPES,
    RESOURCE_KEY,
    RETRYABLE_403_REASONS,
    SUPPORTED_TYPES,
    DriveReadError,
)
from hushh_mcp.services.google_drive_adapter import (
    ERROR_RESPONSE_LIMIT as ERROR_RESPONSE_LIMIT,
)

logger = logging.getLogger(__name__)

DEADLINE_SECONDS = 20
RESPONSE_LIMIT = 256 * 1024
PAGE_LIMIT = 3
PERMISSION_LIMIT = 200
FILE_FIELDS = (
    "id,name,version,mimeType,modifiedTime,createdTime,trashed,isAppAuthorized,"
    "capabilities(canShare,canDownload,canAccessViaGenAi),"
    "clientEncryptionDetails(encryptionState)"
)
PERMISSION_FIELDS = (
    "id,type,role,emailAddress,domain,deleted,pendingOwner,expirationTime,"
    "permissionDetails(inherited,inheritedFrom,permissionType,role)"
)
LIST_FIELDS = f"nextPageToken,permissions({PERMISSION_FIELDS})"
INSPECTION_ACL_FIELDS = f"{FILE_FIELDS},driveId,permissions({PERMISSION_FIELDS})"
VERSION = re.compile(r"[0-9]{1,30}\Z")
EMAIL = re.compile(r'[^@\s<>"(),;:\\]+@[^@\s<>"(),;:\\]+\.[^@\s<>"(),;:\\]+\Z')
ROLES = frozenset({"owner", "organizer", "fileOrganizer", "writer", "commenter", "reader"})
KINDS = frozenset({"user", "group", "domain", "anyone"})
Fence = Callable[[], Awaitable[object]]

# Drive answers a create with these documented reasons. Google's own guide:
# invalidSharingRequest can follow a successful share whose email failed, and
# sharingRateLimitExceeded means "could not be shared because a rate limit was
# exceeded". Only these fixed names and the hints below leave this module.
INVALID_SHARING_REASON = "invalidSharingRequest"
SHARING_RATE_LIMIT_REASON = "sharingRateLimitExceeded"
# Workspace domain and shared-drive sharing rules refuse the recipient (403).
POLICY_403_REASONS = frozenset(
    {
        "shareInNotPermitted",
        "shareOutNotPermitted",
        "shareOutNotPermittedToUser",
        "teamDriveDomainUsersOnlyRestriction",
        "teamDriveTeamMembersOnlyRestriction",
    }
)
NO_GOOGLE_ACCOUNT_403_REASONS = frozenset({"cannotShareTeamDriveWithNonGoogleAccounts"})
# What an invalidSharingRequest message says, decided here and never stored or
# logged as text. A reconciled grant always wins over any hint.
SHARE_HINTS = frozenset(
    {
        "shared_without_email",
        "recipient_needs_google_account",
        "drive_policy_blocked",
        "invalid_sharing_request",
    }
)
REASON_CLASSES = frozenset(
    {
        "rate_limit",
        "sharing_rate_limit",
        "invalid_sharing",
        "policy",
        "no_google_account",
        "bad_request",
        "unreadable",
        "other",
    }
)
_HINT_TEXT_LIMIT = 2048
_EMAIL_LIKE = re.compile(r"\S+@\S+")
_HINT_PHRASES = (
    # Checked in order; the first match wins.
    ("shared_without_email", ("successfully shared", "emails could not be sent")),
    ("recipient_needs_google_account", ("no google account", "notify people")),
    (
        "drive_policy_blocked",
        (
            "acl change not allowed",
            "not allowed to share",
            "outside of your organization",
            "outside your organization",
            "outside of the domain",
            "outside the domain",
            "sharing policy",
            "domain policy",
        ),
    ),
)


class DrivePermissionError(DriveReadError):
    def __init__(
        self,
        code: str,
        *,
        outcome_unknown: bool = False,
        retryable: bool = False,
        share_hint: str | None = None,
        reason_class: str | None = None,
    ):
        super().__init__(code, retryable=retryable)
        self.outcome_unknown = outcome_unknown
        # Fixed classifications only; never provider text, file or account data.
        self.share_hint = share_hint if share_hint in SHARE_HINTS else None
        self.reason_class = reason_class if reason_class in REASON_CLASSES else None


@dataclass(frozen=True)
class _ProviderError:
    """One bounded read of a Drive error body: reason names and a hint text."""

    code: int
    reasons: tuple[str | None, ...]
    text: str = field(repr=False)

    def only(self, *names: str) -> bool:
        return bool(self.reasons) and all(reason in names for reason in self.reasons)

    def rate_limited(self) -> bool:
        # Exactly the former retryable_403_response rule for reads and writes.
        return self.code == 403 and self.only(*RETRYABLE_403_REASONS)


async def _provider_error(response: httpx.Response) -> _ProviderError | None:
    """Size-limited parse. Messages are matched to fixed hints, then discarded."""
    if response.headers.get("Content-Encoding", "identity").lower() != "identity":
        return None
    data = bytearray()
    async for chunk in response.aiter_raw():
        if len(data) + len(chunk) > ERROR_RESPONSE_LIMIT:
            return None
        data.extend(chunk)
    try:
        result = json.loads(data)
    except (ValueError, UnicodeError, RecursionError):
        return None
    error = result.get("error") if isinstance(result, dict) else None
    items = error.get("errors") if isinstance(error, dict) else None
    if (
        not isinstance(error, dict)
        or type(error.get("code")) is not int
        or not isinstance(items, list)
        or not 1 <= len(items) <= 16
    ):
        return None
    reasons: list[str | None] = []
    texts = [error.get("message")]
    for item in items:
        reason = item.get("reason") if isinstance(item, dict) else None
        reasons.append(reason if isinstance(reason, str) and 1 <= len(reason) <= 64 else None)
        texts.append(item.get("message") if isinstance(item, dict) else None)
    text = " ".join(item[:512] for item in texts if isinstance(item, str))[:_HINT_TEXT_LIMIT]
    return _ProviderError(error["code"], tuple(reasons), _EMAIL_LIKE.sub(" ", text).casefold())


def _share_hint(failure: _ProviderError) -> str:
    for hint, phrases in _HINT_PHRASES:
        if any(phrase in failure.text for phrase in phrases):
            return hint
    return "invalid_sharing_request"


def _refused_403(failure: _ProviderError | None, *, create: bool, mutation: bool) -> None:
    """Every 403 raises. Only a create gets the sharing-specific outcomes."""
    if failure is not None and failure.rate_limited():
        # Reads can back off safely. A dispatched write still requires
        # reconciliation, never a blind POST retry.
        if mutation:
            raise DrivePermissionError(
                "permission_outcome_unknown", outcome_unknown=True, reason_class="rate_limit"
            )
        raise DrivePermissionError(
            "permission_provider_unavailable", retryable=True, reason_class="rate_limit"
        )
    if create and failure is not None and SHARING_RATE_LIMIT_REASON in failure.reasons:
        if failure.only(SHARING_RATE_LIMIT_REASON):
            # Google refused the share itself. The worker waits minutes and
            # repeats its complete absence check before any later POST.
            raise DrivePermissionError(
                "sharing_rate_limited", retryable=True, reason_class="sharing_rate_limit"
            )
        # Mixed with another quota reason: reconcile instead of guessing.
        raise DrivePermissionError(
            "permission_outcome_unknown", outcome_unknown=True, reason_class="rate_limit"
        )
    if create and failure is not None:
        if any(reason in NO_GOOGLE_ACCOUNT_403_REASONS for reason in failure.reasons):
            raise DrivePermissionError(
                "recipient_needs_google_account", reason_class="no_google_account"
            )
        if any(reason in POLICY_403_REASONS for reason in failure.reasons):
            raise DrivePermissionError("drive_policy_blocked", reason_class="policy")
    # A hidden file is not verified permission absence.
    raise DrivePermissionError(
        "permission_target_unavailable",
        reason_class="other" if failure is not None else "unreadable",
    )


def _refused_create_400(failure: _ProviderError | None) -> None:
    """A create refused with 400. invalidSharingRequest may follow a real share."""
    if failure is None:
        # An unreadable answer cannot rule out invalidSharingRequest.
        raise DrivePermissionError(
            "permission_outcome_unknown", outcome_unknown=True, reason_class="unreadable"
        )
    if INVALID_SHARING_REASON in failure.reasons:
        raise DrivePermissionError(
            "permission_outcome_unknown",
            outcome_unknown=True,
            share_hint=_share_hint(failure),
            reason_class="invalid_sharing",
        )
    raise DrivePermissionError(
        "permission_rejected",
        reason_class="bad_request" if failure.only("badRequest", "invalid") else "other",
    )


@dataclass(frozen=True)
class PermissionSnapshot:
    permissions: tuple[dict, ...] = field(repr=False)


@dataclass(frozen=True)
class CreatedReader:
    permission_id: str = field(repr=False)
    email: str = field(repr=False)
    expiration_time: str | None = field(default=None, repr=False)


def same_expiration(actual: object, expected: object) -> bool:
    """Compare equivalent RFC3339 times; absence is valid only for legacy grants."""
    if actual is None or expected is None:
        return actual is expected
    try:
        a = datetime.fromisoformat(actual.replace("Z", "+00:00"))
        b = datetime.fromisoformat(expected.replace("Z", "+00:00"))
        return a.tzinfo is not None and b.tzinfo is not None and a == b
    except (AttributeError, TypeError, ValueError):
        return False


def _expiry(value: str) -> str:
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
        now = datetime.now(UTC)
        if parsed.tzinfo is None or not now < parsed <= now + timedelta(days=365):
            raise ValueError()
        return parsed.astimezone(UTC).isoformat().replace("+00:00", "Z")
    except (AttributeError, TypeError, ValueError):
        raise DrivePermissionError("operation_not_allowed") from None


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


def _embedded_snapshot(result) -> PermissionSnapshot | None:
    """Only an explicitly returned complete My Drive ACL can replace listing."""
    capabilities = result.get("capabilities")
    values = result.get("permissions")
    if (
        result.get("driveId") is not None
        or not isinstance(capabilities, dict)
        or capabilities.get("canShare") is not True
        or type(values) is not list
        or len(values) > PERMISSION_LIMIT
    ):
        return None
    try:
        permissions = tuple(_permission(value) for value in values)
        if len({item["id"] for item in permissions}) != len(permissions) or any(
            item["type"] == "user" and not item.get("deleted") and not item.get("emailAddress")
            for item in permissions
        ):
            return None
        return PermissionSnapshot(permissions)
    except DrivePermissionError:
        return None


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
        send_notification_email: bool = True,
        resource_key: str | None = None,
        expiration_time: str | None = None,
        include_permissions: bool = False,
    ) -> dict:
        started = time.perf_counter()
        outcome = "error"
        reason_class = "none"
        safe_operation = (
            operation if operation in {"inspect", "list", "create", "remove"} else "invalid"
        )
        try:
            result = await self._exchange_private(
                operation,
                file_id=file_id,
                access_token=access_token,
                require_current=require_current,
                email=email,
                permission_id=permission_id,
                page_token=page_token,
                send_notification_email=send_notification_email,
                resource_key=resource_key,
                expiration_time=expiration_time,
                include_permissions=include_permissions,
            )
            outcome = "ok"
            return result
        except DrivePermissionError as error:
            outcome = (
                str(error)
                if str(error)
                in {
                    "reconnect_required",
                    "permission_target_unavailable",
                    "permission_outcome_unknown",
                    "permission_provider_unavailable",
                    "permission_rejected",
                    "permission_response_invalid",
                    "operation_not_allowed",
                    "recipient_not_verified",
                    "sharing_rate_limited",
                    "recipient_needs_google_account",
                    "drive_policy_blocked",
                }
                else "error"
            )
            # Unrecognized provider reasons are counted by class ("other"),
            # never by their own text.
            reason_class = error.reason_class or "none"
            raise
        except asyncio.CancelledError:
            outcome = "cancelled"
            raise
        finally:
            # No file/permission ID, email, URL, token, or provider body in telemetry.
            # The outcome is dotted on purpose: the log redactor masks any 24-128
            # character token of letters, digits, `_` and `-` as a possible
            # identifier, which would hide permission_target_unavailable and the
            # other long outcome codes in the very line meant to count them.
            logger.info(
                "drive_permission_rest.timing operation=%s outcome=%s duration_ms=%.2f reason=%s",
                safe_operation,
                outcome.replace("_", "."),
                (time.perf_counter() - started) * 1000,
                reason_class,
            )

    async def _exchange_private(
        self,
        operation: str,
        *,
        file_id: str,
        access_token: str,
        require_current: Fence,
        email: str | None = None,
        permission_id: str | None = None,
        page_token: str | None = None,
        send_notification_email: bool = True,
        resource_key: str | None = None,
        expiration_time: str | None = None,
        include_permissions: bool = False,
    ) -> dict:
        if type(include_permissions) is not bool or include_permissions and operation != "inspect":
            raise DrivePermissionError("operation_not_allowed")
        path = f"/files/{_identifier(file_id)}"
        body, method = None, "GET"
        params = {"supportsAllDrives": "true"}
        if operation == "inspect" and email is permission_id is page_token is None:
            params["fields"] = INSPECTION_ACL_FIELDS if include_permissions else FILE_FIELDS
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
            if type(send_notification_email) is not bool:
                raise DrivePermissionError("operation_not_allowed")
            method, path = "POST", path + "/permissions"
            body = {"type": "user", "role": "reader", "emailAddress": _email(email)}
            if expiration_time is not None:
                body["expirationTime"] = _expiry(expiration_time)
            # Bulk shares suppress one email per file and deliver a single
            # confirmed-results summary. Existing individual shares retain
            # Google's standard notification.
            params.update(
                {
                    "fields": PERMISSION_FIELDS,
                    "sendNotificationEmail": "true" if send_notification_email else "false",
                }
            )
        elif operation == "remove" and email is page_token is None:
            method = "DELETE"
            path += f"/permissions/{_identifier(permission_id)}"
        else:
            raise DrivePermissionError("operation_not_allowed")
        if resource_key is not None and (
            not isinstance(resource_key, str) or not RESOURCE_KEY.fullmatch(resource_key)
        ):
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
                from hushh_mcp.services.drive_rest_admission import rest_admission

                async with rest_admission(require_current), asyncio.timeout(DEADLINE_SECONDS):
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
                        if resource_key is not None:
                            kwargs["headers"]["X-Goog-Drive-Resource-Keys"] = (
                                f"{file_id}/{resource_key}"
                            )
                        async with client.stream(method, DRIVE_BASE + path, **kwargs) as response:
                            status = response.status_code
                            if status == 401:
                                raise DrivePermissionError("reconnect_required")
                            if status == 403:
                                _refused_403(
                                    await _provider_error(response),
                                    create=operation == "create",
                                    mutation=mutation,
                                )
                            if status in (404, 410):
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
                                if operation == "create" and status == 400:
                                    _refused_create_400(await _provider_error(response))
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
        metadata_period: dict | None = None,
        expected_name: str | None = None,
        time_field: str | None = None,
        start_time: str | None = None,
        end_time: str | None = None,
        resource_key: str | None = None,
        include_permissions: bool = False,
    ) -> PermissionSnapshot | None:
        if not isinstance(expected_version, str) or not VERSION.fullmatch(expected_version):
            raise DrivePermissionError("operation_not_allowed")
        inspect_args = dict(
            file_id=file_id,
            access_token=access_token,
            require_current=require_current,
            resource_key=resource_key,
        )
        try:
            result = await self._exchange(
                "inspect", **inspect_args, include_permissions=include_permissions
            )
        except DrivePermissionError as error:
            if not include_permissions or str(error) != "permission_response_invalid":
                raise
            result = await self._exchange("inspect", **inspect_args)
            include_permissions = False
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
        # Metadata-only shares bind identity (id, name, time window), not bytes.
        # An earlier grant of the same file bumps its version, so an exact
        # version fence here silently cancelled every later recipient. The
        # reviewed name is re-checked instead; a missing one fails closed.
        if metadata_only:
            if not expected_name or result.get("name") != expected_name:
                raise DrivePermissionError("source_changed")
        elif result.get("version") != expected_version:
            raise DrivePermissionError("source_changed")
        if metadata_only and metadata_period is not None:
            from hushh_mcp.services.drive_owner_search_service import _in_requested_period

            basis = metadata_period.get("date_basis")
            match = {
                "name": result.get("name"),
                "created_time": result.get("createdTime"),
                "modified_time": result.get("modifiedTime"),
            }
            if basis in {"created", "modified"}:
                field = "created_time" if basis == "created" else "modified_time"
                match = {"name": "", field: match.get(field)}
            if basis not in {"title_created_modified", "created", "modified"}:
                raise DrivePermissionError("operation_not_allowed")
            try:
                eligible = _in_requested_period(match, metadata_period, precedence=True)
            except (ValueError, TypeError, KeyError):
                raise DrivePermissionError("operation_not_allowed") from None
            if not eligible:
                raise DrivePermissionError("source_changed")
        elif metadata_only:
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
        return _embedded_snapshot(result) if include_permissions else None

    async def list_permissions(
        self,
        *,
        file_id: str,
        access_token: str,
        require_current: Fence,
        resource_key: str | None = None,
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
                        resource_key=resource_key,
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
        self,
        *,
        file_id,
        access_token,
        require_current,
        require_app_authorized=True,
        resource_key: str | None = None,
    ):
        result = await self._exchange(
            "inspect",
            file_id=file_id,
            access_token=access_token,
            require_current=require_current,
            resource_key=resource_key,
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
        self,
        *,
        file_id: str,
        verified_email: str,
        access_token: str,
        require_current: Fence,
        send_notification_email: bool = True,
        resource_key: str | None = None,
        expiration_time: str | None = None,
    ) -> CreatedReader:
        result = await self._exchange(
            "create",
            file_id=file_id,
            email=verified_email,
            access_token=access_token,
            require_current=require_current,
            send_notification_email=send_notification_email,
            resource_key=resource_key,
            expiration_time=expiration_time,
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
            or not same_expiration(permission.get("expirationTime"), expiration_time)
        ):
            raise _unknown()
        # Record success even if owner disconnects while Google is responding.
        return CreatedReader(
            permission["id"], permission["emailAddress"], permission.get("expirationTime")
        )

    async def remove_recorded_permission(
        self,
        *,
        file_id: str,
        recorded_permission_id: str,
        access_token: str,
        require_current: Fence,
        resource_key: str | None = None,
    ) -> None:
        await self._exchange(
            "remove",
            file_id=file_id,
            permission_id=recorded_permission_id,
            access_token=access_token,
            require_current=require_current,
            resource_key=resource_key,
        )
