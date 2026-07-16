"""Safe public projection for the Hussh Consent MCP v0.3 lifecycle."""

from __future__ import annotations

import difflib
import ipaddress
import json
import re
import secrets
from typing import Any
from urllib.parse import urlparse

import httpx
from mcp.types import ResourceLink, TextContent

from hushh_mcp.consent.export_envelope import ConsentExportEnvelopeSubmissionV2
from hushh_mcp.consent.scope_helpers import get_scope_display_metadata
from hushh_mcp.services.local_mcp_keypair_service import get_or_create_local_connector_keypair
from mcp_modules.config import FASTAPI_URL
from mcp_modules.developer_context import get_developer_api_headers
from mcp_modules.transport_context import is_local_stdio_transport

from .data_tools import _try_build_local_decrypted_response

ToolContent = TextContent | ResourceLink
ToolResult = tuple[list[ToolContent], dict[str, Any]]

_SAFE_BACKEND_CODES = {
    "APP_CAPABILITY_NOT_ALLOWED",
    "CONNECTOR_KEY_REQUIRED",
    "CONNECTOR_KEY_REBIND_REQUIRED",
    "CONSENT_REQUEST_NOT_FOUND",
    "DEVELOPER_API_DISABLED_IN_PRODUCTION",
    "EXPORT_ENVELOPE_UPGRADE_REQUIRED",
    "EXPORT_NOT_CURRENT",
    "EXPORT_REFRESH_FAILED",
    "EXPORT_REFRESH_PENDING",
    "GRANT_NOT_FOUND",
    "INVALID_CONSENT_TOKEN",
    "INVALID_CONSENT_RESPONSE",
    "INVALID_EXPORT_AAD",
    "INVALID_USER_IDENTIFIER",
    "INVALID_SCOPE",
    "LEGACY_EXPORT_INVALIDATED",
    "RATE_LIMIT_EXCEEDED",
    "RESOURCE_FETCH_FAILED",
    "RESULT_REQUIRES_NARROWER_SCOPE",
    "REQUEST_TIMEOUT",
    "SCOPE_NOT_DISCOVERED_FOR_USER",
    "SCOPE_RETIRED",
    "USER_NOT_FOUND",
}


def _correlation_ref() -> str:
    return f"err_{secrets.token_hex(8)}"


def _error(
    error_code: str,
    message: str,
    *,
    recoverable: bool,
    next_action: str,
) -> ToolResult:
    payload = {
        "error_code": error_code,
        "message": message[:240],
        "recoverable": recoverable,
        "next_action": next_action[:240],
        "correlation_ref": _correlation_ref(),
    }
    return [TextContent(type="text", text=json.dumps(payload))], payload


def _http_error(response: httpx.Response, *, operation: str) -> ToolResult:
    code = "UPSTREAM_REJECTED"
    try:
        payload = response.json()
        detail = payload.get("detail") if isinstance(payload, dict) else None
        candidate = (
            detail.get("error_code") if isinstance(detail, dict) else payload.get("error_code")
        )
        if str(candidate or "") in _SAFE_BACKEND_CODES:
            code = str(candidate)
    except Exception:
        pass
    if response.status_code == 401:
        code = "AUTHENTICATION_REQUIRED"
    elif response.status_code == 403:
        code = "ACCESS_DENIED"
    elif response.status_code == 404 and code == "UPSTREAM_REJECTED":
        code = "NOT_FOUND"
    elif response.status_code == 429:
        code = "RATE_LIMIT_EXCEEDED"
    elif response.status_code == 504:
        code = "REQUEST_TIMEOUT"
    recoverable = response.status_code in {408, 429, 502, 503, 504}
    return _error(
        code,
        f"Hussh could not complete {operation}.",
        recoverable=recoverable,
        next_action=(
            "Retry with bounded exponential backoff."
            if recoverable
            else "Verify the reference, scope, and developer-app authorization."
        ),
    )


def _parse_cursor(raw: object) -> int | None:
    value = str(raw or "").strip()
    if not value:
        return 0
    if not value.startswith("c_"):
        return None
    try:
        offset = int(value[2:], 16)
    except ValueError:
        return None
    return offset if 0 <= offset <= 100_000 else None


def _project_hosted_crypto(data: dict[str, Any]) -> dict[str, Any] | None:
    """Validate and allowlist only the envelope fields a connector must consume."""

    iv = str(data.get("iv") or "")
    tag = str(data.get("tag") or "")
    wrapped = data.get("wrapped_key_bundle")
    envelope = data.get("export_envelope")
    if not iv or len(iv) > 512 or not tag or len(tag) > 512:
        return None
    if not isinstance(wrapped, dict) or not isinstance(envelope, dict):
        return None

    wrapped_fields = {
        "wrapped_export_key": (2048, False),
        "wrapped_key_iv": (512, False),
        "wrapped_key_tag": (512, False),
        "sender_public_key": (512, False),
        "wrapping_alg": (64, False),
        "connector_key_id": (128, True),
    }
    safe_wrapped: dict[str, str | None] = {}
    for key, (maximum, nullable) in wrapped_fields.items():
        raw = wrapped.get(key)
        if raw is None and nullable:
            safe_wrapped[key] = None
            continue
        value = str(raw or "")
        if not value or len(value) > maximum:
            return None
        safe_wrapped[key] = value
    if safe_wrapped["wrapping_alg"] != "X25519-AES256-GCM":
        return None

    try:
        safe_envelope = ConsentExportEnvelopeSubmissionV2.model_validate(envelope).model_dump(
            mode="json"
        )
    except (TypeError, ValueError):
        return None
    return {
        "iv": iv,
        "tag": tag,
        "wrapped_key_bundle": safe_wrapped,
        "export_envelope": safe_envelope,
    }


def _is_public_resource_hostname(hostname: str) -> bool:
    normalized = hostname.strip().lower().rstrip(".")
    if normalized == "localhost" or normalized.endswith((".localhost", ".local", ".internal")):
        return False
    try:
        address = ipaddress.ip_address(normalized)
    except ValueError:
        return True
    return not (
        address.is_private
        or address.is_loopback
        or address.is_link_local
        or address.is_unspecified
        or address.is_reserved
    )


def _rank_scope_entries(entries: list[dict], *, query: str, domain: str) -> list[dict]:
    normalized_query = query.strip().lower()
    normalized_domain = domain.strip().lower()
    scored: list[tuple[int, float, int, str, dict]] = []
    for entry in entries:
        if not isinstance(entry, dict):
            continue
        scope = str(entry.get("scope") or "").strip()
        if not re.fullmatch(
            r"(?:attr\.[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)*(?:\.\*)?|cap\.one\.invoke)",
            scope,
        ):
            continue
        if scope.startswith("attr."):
            entry_domain = scope.split(".", 2)[1]
        else:
            entry_domain = "one"
        if (
            not scope
            or not entry_domain
            or (normalized_domain and entry_domain != normalized_domain)
        ):
            continue
        meta = get_scope_display_metadata(scope)
        label = str(meta.get("label") or "Scope").strip()
        haystack = f"{scope.lower()} {entry_domain} {label.lower()}"
        if not normalized_query:
            tier, ratio = 3, 0.0
        elif normalized_query == entry_domain:
            tier, ratio = 0, 1.0
        elif normalized_query in haystack:
            tier, ratio = 1, 0.0
        else:
            ratio = difflib.SequenceMatcher(None, normalized_query, haystack).ratio()
            if ratio < 0.35:
                continue
            tier = 2
        item = {
            "scope": scope[:200],
            "domain": entry_domain[:64],
            "label": label[:120],
            "description": str(meta.get("description") or "Consent-controlled information.")[:280],
        }
        scored.append((tier, -ratio, -len(scope), scope, item))
    scored.sort(key=lambda item: item[:4])
    return [item[4] for item in scored]


async def handle_search_user_scopes(args: dict) -> ToolResult:
    identifier = str(args.get("user_identifier") or "").strip()
    offset = _parse_cursor(args.get("cursor"))
    if offset is None:
        return _error(
            "INVALID_CURSOR",
            "The pagination cursor is invalid.",
            recoverable=True,
            next_action="Restart the search without a cursor.",
        )
    headers = get_developer_api_headers()
    if not headers:
        return _error(
            "AUTHENTICATION_REQUIRED",
            "Developer bearer authentication is required.",
            recoverable=True,
            next_action="Configure HUSHH_DEVELOPER_TOKEN in the connector environment.",
        )
    try:
        async with httpx.AsyncClient(timeout=10.0) as client:
            response = await client.post(
                f"{FASTAPI_URL}/api/v1/mcp/search-scopes",
                json={
                    "user_identifier": identifier,
                    **(
                        {"country_iso2": str(args.get("country_iso2")).strip()}
                        if args.get("country_iso2")
                        else {}
                    ),
                    **(
                        {"country": str(args.get("country")).strip()} if args.get("country") else {}
                    ),
                },
                headers=headers,
            )
    except (httpx.TimeoutException, httpx.NetworkError):
        return _error(
            "BACKEND_UNAVAILABLE",
            "Hussh scope lookup is temporarily unavailable.",
            recoverable=True,
            next_action="Retry with bounded exponential backoff.",
        )
    if response.status_code == 404:
        payload = {"status": "success", "scopes": [], "next_cursor": None, "has_more": False}
        return [TextContent(type="text", text=json.dumps(payload))], payload
    if response.status_code >= 400:
        return _http_error(response, operation="scope lookup")
    data = response.json()
    entries = data.get("scope_entries") if isinstance(data, dict) else []
    if not entries:
        entries = [{"scope": scope} for scope in (data.get("scopes") or [])]
    ranked = _rank_scope_entries(
        list(entries or []),
        query=str(args.get("query") or "")[:200],
        domain=str(args.get("domain") or "")[:64],
    )
    limit = max(1, min(int(args.get("limit") or 20), 50))
    page = ranked[offset : offset + limit]
    next_offset = offset + len(page)
    has_more = next_offset < len(ranked)
    payload = {
        "status": "success",
        "scopes": page,
        "next_cursor": f"c_{next_offset:x}" if has_more else None,
        "has_more": has_more,
    }
    return [TextContent(type="text", text=json.dumps(payload))], payload


async def handle_request_consent(args: dict) -> ToolResult:
    identifier = str(args.get("user_identifier") or "").strip()
    headers = get_developer_api_headers()
    if not headers:
        return _error(
            "AUTHENTICATION_REQUIRED",
            "Developer bearer authentication is required.",
            recoverable=True,
            next_action="Configure HUSHH_DEVELOPER_TOKEN in the connector environment.",
        )

    scope = str(args.get("scope") or "").strip()
    connector_public_key = str(args.get("connector_public_key") or "").strip()
    connector_key_id = str(args.get("connector_key_id") or "").strip()
    connector_wrapping_alg = str(args.get("connector_wrapping_alg") or "").strip()
    if (
        scope.startswith("attr.")
        and is_local_stdio_transport()
        and not all((connector_public_key, connector_key_id, connector_wrapping_alg))
    ):
        keypair = get_or_create_local_connector_keypair()
        connector_public_key = keypair.public_key_b64
        connector_key_id = keypair.key_id
        connector_wrapping_alg = keypair.wrapping_alg
    if scope.startswith("attr.") and not all(
        (connector_public_key, connector_key_id, connector_wrapping_alg)
    ):
        return _error(
            "CONNECTOR_KEY_REQUIRED",
            "Hosted encrypted grants require an X25519 connector public-key bundle.",
            recoverable=True,
            next_action="Supply the connector public key, key id, and X25519-AES256-GCM algorithm.",
        )

    body = {
        "user_identifier": identifier,
        "scope": scope,
        "purpose": str(args.get("purpose") or "").strip(),
        "expiry_hours": int(args.get("expiry_hours") or 24),
        "approval_timeout_minutes": int(args.get("approval_timeout_minutes") or 1440),
        "refresh_policy": str(args.get("refresh_policy") or "snapshot"),
        **(
            {"country_iso2": str(args.get("country_iso2")).strip()}
            if args.get("country_iso2")
            else {}
        ),
        **({"country": str(args.get("country")).strip()} if args.get("country") else {}),
    }
    if scope.startswith("attr."):
        body.update(
            {
                "connector_public_key": connector_public_key,
                "connector_key_id": connector_key_id,
                "connector_wrapping_alg": connector_wrapping_alg,
            }
        )
    try:
        async with httpx.AsyncClient(timeout=10.0) as client:
            response = await client.post(
                f"{FASTAPI_URL}/api/v1/mcp/request-consent",
                headers=headers,
                json=body,
            )
    except (httpx.TimeoutException, httpx.NetworkError):
        return _error(
            "BACKEND_UNAVAILABLE",
            "Hussh consent request is temporarily unavailable.",
            recoverable=True,
            next_action="Retry once with bounded exponential backoff.",
        )
    if response.status_code >= 400:
        return _http_error(response, operation="the consent request")
    data = response.json()
    state = str(data.get("status") or "").strip().lower()
    request_ref = str(data.get("grant_ref") or data.get("request_ref") or "").strip()
    if state == "denied":
        return _error(
            "CONSENT_RECENTLY_DENIED",
            "The user recently denied this scope.",
            recoverable=False,
            next_action="Do not retry until the user initiates a new consent decision.",
        )
    if state not in {"pending", "granted"} or not request_ref:
        return _error(
            "INVALID_BACKEND_RESPONSE",
            "Hussh returned an invalid consent lifecycle response.",
            recoverable=True,
            next_action="Retry once; if it repeats, report the correlation reference.",
        )
    granted = state == "granted"
    payload: dict[str, Any] = {
        "status": "granted" if granted else "pending",
        "scope": scope,
        "coverage_kind": data.get("coverage_kind") if granted else None,
        "expires_at": int(data["expires_at"]) if data.get("expires_at") is not None else None,
        "poll_after_seconds": None if granted else 5,
        "approval_timeout_at": (
            int(data.get("approval_timeout_at") or data.get("poll_timeout_at"))
            if (data.get("approval_timeout_at") or data.get("poll_timeout_at")) is not None
            else None
        ),
    }
    payload["grant_ref" if granted else "request_ref"] = request_ref
    return [TextContent(type="text", text=json.dumps(payload))], payload


async def handle_check_consent_status(args: dict) -> ToolResult:
    headers = get_developer_api_headers()
    if not headers:
        return _error(
            "AUTHENTICATION_REQUIRED",
            "Developer bearer authentication is required.",
            recoverable=True,
            next_action="Configure HUSHH_DEVELOPER_TOKEN in the connector environment.",
        )
    request_ref = str(args.get("request_ref") or "").strip()
    try:
        async with httpx.AsyncClient(timeout=10.0) as client:
            response = await client.get(
                f"{FASTAPI_URL}/api/v1/mcp/consent-status/{request_ref}",
                headers=headers,
            )
    except (httpx.TimeoutException, httpx.NetworkError):
        return _error(
            "BACKEND_UNAVAILABLE",
            "Hussh consent status is temporarily unavailable.",
            recoverable=True,
            next_action="Retry at the prior polling interval.",
        )
    if response.status_code >= 400:
        return _http_error(response, operation="the consent status check")
    data = response.json()
    lifecycle = str(data.get("status") or "").strip().lower()
    if lifecycle not in {"pending", "granted", "denied", "expired", "revoked", "cancelled"}:
        return _error(
            "INVALID_BACKEND_RESPONSE",
            "Hussh returned an invalid consent lifecycle response.",
            recoverable=True,
            next_action="Retry once; if it repeats, report the correlation reference.",
        )
    payload = {
        "status": lifecycle,
        "expires_at": int(data["expires_at"]) if data.get("expires_at") is not None else None,
        "poll_after_seconds": (
            int(data["poll_after_seconds"]) if data.get("poll_after_seconds") is not None else None
        ),
        "approval_timeout_at": (
            int(data["approval_timeout_at"])
            if data.get("approval_timeout_at") is not None
            else None
        ),
        "grant_ref": str(data.get("grant_ref")) if data.get("grant_ref") else None,
    }
    return [TextContent(type="text", text=json.dumps(payload))], payload


async def handle_get_encrypted_scoped_export(args: dict) -> ToolResult:
    headers = get_developer_api_headers()
    if not headers:
        return _error(
            "AUTHENTICATION_REQUIRED",
            "Developer bearer authentication is required.",
            recoverable=True,
            next_action="Configure HUSHH_DEVELOPER_TOKEN in the connector environment.",
        )
    expected_scope = str(args.get("expected_scope") or "").strip()
    try:
        async with httpx.AsyncClient(timeout=10.0) as client:
            response = await client.post(
                f"{FASTAPI_URL}/api/v1/mcp/scoped-export",
                headers=headers,
                json={
                    "grant_ref": str(args.get("grant_ref") or "").strip(),
                    "expected_scope": expected_scope,
                },
            )
    except (httpx.TimeoutException, httpx.NetworkError):
        return _error(
            "BACKEND_UNAVAILABLE",
            "Hussh export retrieval is temporarily unavailable.",
            recoverable=True,
            next_action="Retry once with bounded exponential backoff.",
        )
    if response.status_code >= 400:
        return _http_error(response, operation="the scoped export")
    data = response.json()
    granted_scope = str(data.get("granted_scope") or "")[:200]
    base = {
        "status": "success",
        "expected_scope": expected_scope,
        "granted_scope": granted_scope,
        "expires_at": int(data["expires_at"]) if data.get("expires_at") is not None else None,
        "export_revision": max(1, int(data.get("export_revision") or 1)),
    }

    if is_local_stdio_transport():
        decrypted, local_error = await _try_build_local_decrypted_response(
            {},
            export_payload=data,
            expected_scope=expected_scope,
        )
        if decrypted is None:
            code = str((local_error or {}).get("error_code") or "CONNECTOR_CRYPTO_UNSUPPORTED")
            return _error(
                code if code in _SAFE_BACKEND_CODES else "CONNECTOR_CRYPTO_UNSUPPORTED",
                "The connector could not validate and decrypt this export.",
                recoverable=code
                in {"CONNECTOR_KEY_REBIND_REQUIRED", "RESULT_REQUIRES_NARROWER_SCOPE"},
                next_action=(
                    "Request a fresh grant with this connector key or use a narrower discovered scope."
                ),
            )
        payload = {
            **base,
            "delivery": "decrypted_local",
            "resource": None,
            "crypto": None,
            "information": dict(decrypted.get("data") or {}),
        }
        return [TextContent(type="text", text=json.dumps(payload))], payload

    resource = data.get("resource_link") if isinstance(data.get("resource_link"), dict) else {}
    uri = str(resource.get("uri") or "").strip()
    parsed_uri = urlparse(uri)
    if (
        not uri
        or len(uri) > 2048
        or parsed_uri.scheme != "https"
        or not parsed_uri.hostname
        or not _is_public_resource_hostname(parsed_uri.hostname)
        or parsed_uri.username is not None
        or parsed_uri.password is not None
        or bool(parsed_uri.query)
        or bool(parsed_uri.fragment)
    ):
        return _error(
            "RESOURCE_LINK_MISSING",
            "The encrypted export resource is unavailable.",
            recoverable=True,
            next_action="Retry once; if it repeats, report the correlation reference.",
        )
    resource_size = int(resource["size"]) if resource.get("size") is not None else None
    if resource_size is not None and not 0 <= resource_size <= 1_000_000_000:
        return _error(
            "INVALID_BACKEND_RESPONSE",
            "The encrypted export metadata is incomplete or invalid.",
            recoverable=True,
            next_action="Retry once; if it repeats, report the correlation reference.",
        )
    safe_resource = {
        "name": "Hussh encrypted scoped export",
        "uri": uri,
        "mime_type": "application/octet-stream",
        "size": resource_size,
    }
    safe_crypto = _project_hosted_crypto(data)
    if safe_crypto is None:
        return _error(
            "INVALID_BACKEND_RESPONSE",
            "The encrypted export metadata is incomplete or invalid.",
            recoverable=True,
            next_action="Retry once; if it repeats, report the correlation reference.",
        )
    payload = {
        **base,
        "delivery": "resource_link",
        "resource": safe_resource,
        "crypto": safe_crypto,
        "information": None,
    }
    return [
        TextContent(type="text", text=json.dumps(payload)),
        ResourceLink(
            type="resource_link",
            name=safe_resource["name"],
            uri=safe_resource["uri"],
            description="Bearer-authenticated ciphertext; validate envelope v2 and decrypt outside model context.",
            mimeType=safe_resource["mime_type"],
            size=safe_resource["size"],
        ),
    ], payload
