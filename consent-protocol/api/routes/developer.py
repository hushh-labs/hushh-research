from __future__ import annotations

import asyncio
import base64
import binascii
import inspect
import json
import logging
import os
import time
import uuid
from typing import Any, AsyncGenerator, Literal, Optional, TypedDict, cast

from fastapi import (
    APIRouter,
    Depends,
    Header,
    HTTPException,
    Path,
    Query,
    Request,
    Response,
    status,
)
from pydantic import BaseModel, ConfigDict, Field
from sse_starlette.sse import EventSourceResponse

from api.developer_auth import (
    authenticate_developer_principal,
    developer_api_disabled_error,
    developer_api_enabled,
    try_authenticate_developer_principal,
)
from api.middleware import require_firebase_auth
from api.middlewares.rate_limit import RateLimits, limiter
from api.utils.firebase_admin import get_firebase_auth_app
from hushh_mcp.consent.export_envelope import (
    connector_key_fingerprint,
    digest_bytes,
    scope_handle_for_machine_scope,
)
from hushh_mcp.consent.scope_helpers import get_scope_description, normalize_scope
from hushh_mcp.consent.token import validate_token_with_db
from hushh_mcp.constants import (
    EXTERNAL_REQUESTABLE_RESERVED_SCOPE_VALUES,
    INTERNAL_ONLY_SCOPE_VALUES,
    RETIRED_SCOPE_VALUES,
    SCOPE_POLICY_VERSION,
    ConsentScope,
)
from hushh_mcp.services.consent_db import ConsentDBService
from hushh_mcp.services.consent_request_links import build_consent_request_url
from hushh_mcp.services.developer_registry_service import (
    DEFAULT_PUBLIC_TOOL_GROUPS,
    DeveloperPrincipal,
    DeveloperRegistryService,
    normalize_tool_groups,
    visible_tool_names_for_groups,
)
from hushh_mcp.services.personal_knowledge_model_service import get_pkm_service

logger = logging.getLogger(__name__)

router = APIRouter()
developer_api_router = APIRouter(prefix="/api/v1", tags=["Developer API"])
portal_router = APIRouter(prefix="/api/developer", tags=["Developer Portal"])

_STATIC_REQUESTABLE_SCOPES: frozenset[str] = EXTERNAL_REQUESTABLE_RESERVED_SCOPE_VALUES
_MIN_PUBLIC_EXPIRY_HOURS = 24
_MAX_PUBLIC_EXPIRY_HOURS = 24 * 90
_MIN_PUBLIC_APPROVAL_TIMEOUT_MINUTES = 5
_MAX_PUBLIC_APPROVAL_TIMEOUT_MINUTES = 24 * 60
_CONNECTOR_WRAPPING_ALG = "X25519-AES256-GCM"
_CONSENT_EXPORT_MAX_RAW_BYTES = max(
    1,
    min(
        int(os.getenv("HUSHH_CONSENT_EXPORT_MAX_RAW_BYTES", str(16 * 1024 * 1024))),
        64 * 1024 * 1024,
    ),
)
_CONSENT_REQUEST_STATUS_MAP = {
    "REQUESTED": "pending",
    "CONSENT_GRANTED": "granted",
    "CONSENT_DENIED": "denied",
    "TIMEOUT": "expired",
    "CANCELLED": "cancelled",
    "REVOKED": "revoked",
}
_TERMINAL_CONSENT_STATUSES = {"granted", "denied", "expired", "cancelled", "revoked"}


class DeveloperScopeDescriptor(BaseModel):
    name: str = Field(..., min_length=1, max_length=200)
    description: str = Field(..., min_length=1, max_length=2000)
    dynamic: bool = False
    requires_discovery: bool = False


class DeveloperScopeCatalogResponse(BaseModel):
    version: str = f"v{SCOPE_POLICY_VERSION}"
    scopes_are_dynamic: bool = True
    discovery_required: bool = True
    scopes: list[DeveloperScopeDescriptor]
    discovery_endpoint: str = "/api/v1/user-scopes/{user_id}"
    request_endpoint: str = "/api/v1/request-consent"
    public_profile_export_endpoint: str = "/api/v1/public-profile-export"
    tool_catalog_endpoint: str = "/api/v1/tool-catalog"
    mcp_tools: list[str] = Field(default_factory=list)
    mcp_resources: list[str] = Field(
        default_factory=lambda: [
            "hushh://info/connector",
            "hushh://info/developer-api",
        ]
    )
    recommended_flow: list[str] = Field(
        default_factory=lambda: [
            "discover_user_domains",
            "read_public_profile_projection_when_available",
            "request_consent",
            "check_consent_status",
            "get_encrypted_scoped_export",
        ]
    )
    notes: list[str] = Field(
        default_factory=lambda: [
            "Do not hardcode domain keys. Discover available scopes per user at runtime.",
            "Dynamic attr scopes are derived from PKM discovery metadata and the scope registry.",
            "Public-profile publishing is a separate owner-controlled projection and is not an encrypted attr.* consent grant.",
            "Use get_encrypted_scoped_export for all consented reads; Hussh does not return plaintext user data to developer callers.",
            "Use Authorization: Bearer for developer authentication; query-string tokens are rejected.",
            "Large export ciphertext is fetched through an authenticated MCP resource outside model context.",
        ]
    )


class DeveloperUserScopesResponse(BaseModel):
    user_id: str = Field(..., min_length=1, max_length=128)
    available_domains: list[str] = Field(default_factory=list)
    scopes: list[str] = Field(default_factory=list)
    scope_entries: list[dict] = Field(default_factory=list)
    scopes_are_dynamic: bool = True
    source: str = "pkm_index + pkm_manifests.top_level_scope_paths + pkm_scope_registry"
    app_id: str | None = Field(default=None, max_length=128)
    app_display_name: str | None = Field(default=None, max_length=200)


class DeveloperScopeSearchResponse(BaseModel):
    user_id: str = Field(..., min_length=1, max_length=128)
    query: str | None = Field(default=None, max_length=200)
    domain: str | None = Field(default=None, max_length=128)
    matches: list[dict] = Field(default_factory=list)
    available_domains: list[str] = Field(default_factory=list)
    scopes_are_dynamic: bool = True
    app_id: str | None = Field(default=None, max_length=128)
    app_display_name: str | None = Field(default=None, max_length=200)


class DeveloperToolCatalogResponse(BaseModel):
    version: str = "v1"
    approval_required: bool = False
    allowed_tool_groups: list[str]
    compatibility_status: str = Field(..., min_length=1, max_length=64)
    tools: list[dict]
    tool_groups: list[dict]
    recommended_flow: list[str]
    notes: list[str]
    app_id: str | None = Field(default=None, max_length=128)
    app_display_name: str | None = Field(default=None, max_length=200)


class DeveloperConsentStatusResponse(BaseModel):
    status: str = Field(..., min_length=1, max_length=64)
    user_id: str = Field(..., min_length=1, max_length=128)
    scope: str | None = Field(default=None, max_length=200)
    requested_scope: str | None = Field(default=None, max_length=200)
    granted_scope: str | None = Field(default=None, max_length=200)
    coverage_kind: str | None = Field(default=None, max_length=64)
    covered_by_existing_grant: bool = False
    request_id: str | None = Field(default=None, max_length=128)
    consent_token: str | None = Field(default=None, max_length=2048)
    expires_at: int | None = None
    export_revision: int | None = None
    export_generated_at: str | None = Field(default=None, max_length=64)
    export_refresh_status: str | None = Field(default=None, max_length=64)
    poll_timeout_at: int | None = None
    approval_timeout_at: int | None = None
    approval_timeout_minutes: int | None = None
    expiry_hours: int | None = None
    is_scope_upgrade: bool | None = None
    existing_granted_scopes: list[str] | None = None
    additional_access_summary: str | None = Field(default=None, max_length=500)
    request_url: str | None = Field(default=None, max_length=2048)
    requester_label: str | None = Field(default=None, max_length=200)
    requester_image_url: str | None = Field(default=None, max_length=2048)
    reason: str | None = Field(default=None, max_length=1000)
    app_id: str | None = Field(default=None, max_length=128)
    app_display_name: str | None = Field(default=None, max_length=200)
    message: str = Field(..., min_length=1, max_length=2000)


class CoverageFields(TypedDict):
    requested_scope: str
    granted_scope: str | None
    coverage_kind: str | None
    covered_by_existing_grant: bool


class ExportFields(TypedDict):
    export_revision: int | None
    export_generated_at: str | None
    export_refresh_status: str | None


class DeveloperConsentOffer(BaseModel):
    """Optional priced-consent offer (the consent reverse-auction bid).

    When a Demand Agent requests consent it MAY attach an ``offer`` — a bid to
    pay the user for scoped, time-boxed access to their consented context. The
    bid rides inside ``request_consent`` (it is a data-access offer), is recorded
    on the consent event metadata, and surfaces in the response so the user side
    (One holds the reserve price, Nav clears it) can decide. SETTLEMENT of the
    bid is AP2's job at the money boundary — this layer authorizes the read and
    carries the bid; it never moves money. See the consent reverse-auction plan.
    """

    model_config = ConfigDict(extra="forbid")

    bid_amount: float = Field(..., gt=0, le=1_000_000)
    currency: str = Field(default="USD", min_length=3, max_length=3)
    offer_summary: str | None = Field(default=None, max_length=500)
    # Correlation id linking a cleared consent receipt (CRT) to its AP2 Payment
    # Mandate. The two ledgers stay separate; this is the only cross-reference.
    settlement_ref: str | None = Field(default=None, max_length=128)


class DeveloperConsentRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    user_id: str = Field(..., min_length=1, max_length=128)
    scope: str = Field(..., min_length=1, max_length=200)
    reason: str | None = Field(default=None, max_length=1000)
    expiry_hours: int = 24
    approval_timeout_minutes: int = 24 * 60
    connector_public_key: str | None = Field(default=None, min_length=16)
    connector_key_id: str | None = Field(default=None, min_length=1, max_length=128)
    connector_wrapping_alg: str | None = Field(default=None, min_length=1, max_length=128)
    refresh_policy: Literal["snapshot", "continuous_until_expiry"] = "snapshot"
    offer: DeveloperConsentOffer | None = None


class DeveloperScopedExportRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    user_id: str = Field(..., min_length=1, max_length=128)
    consent_token: str = Field(min_length=16, max_length=2048)
    expected_scope: str | None = Field(default=None, max_length=200)


class DeveloperPublicProfileExportRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    user_id: str = Field(..., min_length=1, max_length=128)
    public_profile_handle: str = Field(..., min_length=1, max_length=64)


class DeveloperScopedExportResponse(BaseModel):
    status: str = Field(..., min_length=1, max_length=64)
    user_id: str = Field(..., min_length=1, max_length=128)
    consent_token: str = Field(..., min_length=1, max_length=2048)
    granted_scope: str | None = Field(default=None, max_length=200)
    expected_scope: str | None = Field(default=None, max_length=200)
    coverage_kind: str | None = Field(default=None, max_length=64)
    expires_at: int | None = None
    export_revision: int | None = None
    export_generated_at: str | None = Field(default=None, max_length=64)
    export_refresh_status: str | None = Field(default=None, max_length=64)
    encrypted_data: str | None = Field(default=None, max_length=10_000_000)
    iv: str | None = Field(default=None, max_length=512)
    tag: str | None = Field(default=None, max_length=512)
    wrapped_key_bundle: dict | None = None
    export_envelope: dict | None = None
    resource_link: dict | None = None
    maximum_raw_bytes: int | None = None
    message: str = Field(..., min_length=1, max_length=2000)


class DeveloperPublicProfileExportResponse(BaseModel):
    status: str = Field(..., max_length=64)
    user_id: str = Field(..., max_length=128)
    public_profile_handle: str = Field(..., max_length=64)
    domain: str | None = Field(default=None, max_length=200)
    top_level_scope_path: str | None = Field(default=None, max_length=512)
    projection_payload: dict = Field(default_factory=dict)
    projection_hash: str | None = Field(default=None, max_length=256)
    projection_version: int | None = None
    projection_updated_at: str | None = Field(default=None, max_length=64)
    app_id: str | None = Field(default=None, max_length=128)
    app_display_name: str | None = Field(default=None, max_length=200)
    message: str = Field(..., max_length=2000)


class DeveloperPortalTokenResponse(BaseModel):
    id: int
    app_id: str = Field(..., max_length=128)
    token_prefix: str = Field(..., max_length=64)
    label: str | None = Field(default=None, max_length=256)
    created_at: int
    revoked_at: int | None = None
    last_used_at: int | None = None


class DeveloperPortalAppResponse(BaseModel):
    app_id: str = Field(..., max_length=128)
    agent_id: str = Field(..., max_length=128)
    display_name: str = Field(..., max_length=200)
    contact_email: str = Field(..., max_length=320)
    support_url: str | None = Field(default=None, max_length=2048)
    policy_url: str | None = Field(default=None, max_length=2048)
    website_url: str | None = Field(default=None, max_length=2048)
    brand_image_url: str | None = Field(default=None, max_length=2048)
    status: str = Field(..., max_length=64)
    allowed_tool_groups: list[str]
    allowed_capabilities: list[str]
    created_at: int
    updated_at: int


class DeveloperPortalAccessResponse(BaseModel):
    access_enabled: bool
    user_id: str = Field(..., max_length=128)
    owner_email: str | None = Field(default=None, max_length=320)
    owner_display_name: str | None = Field(default=None, max_length=200)
    owner_provider_ids: list[str] = Field(default_factory=list)
    app: DeveloperPortalAppResponse | None = None
    active_token: DeveloperPortalTokenResponse | None = None
    raw_token: str | None = Field(default=None, max_length=512)
    developer_token_env_var: str = "HUSHH_DEVELOPER_TOKEN"  # noqa: S105
    notes: list[str] = Field(
        default_factory=lambda: [
            "Use Authorization: Bearer <developer-token> for /api/v1 and hosted MCP.",
            "User consent is still approved inside Kai one scope at a time.",
            "Dynamic scopes must be discovered per user before requesting consent.",
        ]
    )


class DeveloperPortalProfileUpdateRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    display_name: str | None = Field(default=None, min_length=2, max_length=120)
    support_url: str | None = Field(default=None, max_length=512)
    policy_url: str | None = Field(default=None, max_length=512)
    website_url: str | None = Field(default=None, max_length=512)
    brand_image_url: str | None = Field(default=None, max_length=512)


class OwnerProfile(TypedDict):
    owner_email: str | None
    owner_display_name: str | None
    owner_provider_ids: list[str]


def _scope_catalog() -> list[DeveloperScopeDescriptor]:
    return [
        DeveloperScopeDescriptor(
            name="cap.one.invoke",
            description=(
                "Create or resume a task through One. This grants no user-data read "
                "or mutation authority."
            ),
        ),
        DeveloperScopeDescriptor(
            name="attr.{domain_slug}.{scope_slug}.*",
            description="Read one exact semantic branch returned by per-user scope discovery.",
            dynamic=True,
            requires_discovery=True,
        ),
    ]


def _is_supported_scope(scope: str) -> bool:
    return bool(ConsentScope.is_external_requestable_scope(scope))


def _validate_public_expiry_hours(expiry_hours: int) -> int:
    if _MIN_PUBLIC_EXPIRY_HOURS <= expiry_hours <= _MAX_PUBLIC_EXPIRY_HOURS:
        return expiry_hours
    raise HTTPException(
        status_code=status.HTTP_400_BAD_REQUEST,
        detail={
            "error_code": "INVALID_EXPIRY_HOURS",
            "message": (
                f"expiry_hours must be between {_MIN_PUBLIC_EXPIRY_HOURS} "
                f"and {_MAX_PUBLIC_EXPIRY_HOURS}"
            ),
        },
    )


def _validate_public_approval_timeout_minutes(approval_timeout_minutes: int) -> int:
    if (
        _MIN_PUBLIC_APPROVAL_TIMEOUT_MINUTES
        <= approval_timeout_minutes
        <= _MAX_PUBLIC_APPROVAL_TIMEOUT_MINUTES
    ):
        return approval_timeout_minutes
    raise HTTPException(
        status_code=status.HTTP_400_BAD_REQUEST,
        detail={
            "error_code": "INVALID_APPROVAL_TIMEOUT_MINUTES",
            "message": (
                "approval_timeout_minutes must be between "
                f"{_MIN_PUBLIC_APPROVAL_TIMEOUT_MINUTES} and {_MAX_PUBLIC_APPROVAL_TIMEOUT_MINUTES}"
            ),
        },
    )


def _validate_connector_wrapping_alg(connector_wrapping_alg: str) -> str:
    # Crypto-agility seam: today exactly one wrapping algorithm is accepted. To
    # scale 1 -> N, promote _CONNECTOR_WRAPPING_ALG to an allow-list set and check
    # membership here, and mirror the values in the request_consent tool schema
    # enum. The algorithm is ALWAYS validated server-side against this allow-list;
    # it is deterministic connector configuration and must never be inferred by a
    # model (JWT alg:none downgrade class of risk).
    normalized = str(connector_wrapping_alg or "").strip()
    if normalized == _CONNECTOR_WRAPPING_ALG:
        return normalized
    raise HTTPException(
        status_code=status.HTTP_400_BAD_REQUEST,
        detail={
            "error_code": "INVALID_CONNECTOR_WRAPPING_ALG",
            "message": f"connector_wrapping_alg must be {_CONNECTOR_WRAPPING_ALG}",
        },
    )


def _validate_connector_public_key(connector_public_key: str) -> str:
    try:
        return str(connector_key_fingerprint(connector_public_key))
    except ValueError as exc:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail={
                "error_code": "INVALID_CONNECTOR_PUBLIC_KEY",
                "message": "connector_public_key must be one base64-encoded 32-byte X25519 key.",
            },
        ) from exc


def _request_url_from_metadata(
    request_id: str | None,
    metadata: dict[str, object] | None,
) -> str | None:
    meta = _metadata_object_map(metadata)
    bundle_id = _optional_str(meta.get("bundle_id"))
    request_url = _optional_str(meta.get("request_url"))
    if request_url:
        return request_url
    if request_id or bundle_id:
        return str(build_consent_request_url(request_id=request_id, bundle_id=bundle_id))
    return None


def _normalize_scope_list(value: object | None) -> list[str]:
    if not isinstance(value, list):
        return []
    scopes: list[str] = []
    for item in value:
        normalized = str(item or "").strip()
        if normalized and normalized not in scopes:
            scopes.append(normalized)
    return scopes


def _metadata_object_map(value: object | None) -> dict[str, object]:
    if isinstance(value, dict):
        return cast(dict[str, object], value)
    return {}


def _optional_str(value: object | None) -> str | None:
    if value is None:
        return None
    normalized = str(value).strip()
    return normalized or None


def _optional_int(value: object | None) -> int | None:
    if isinstance(value, bool):
        return int(value)
    if isinstance(value, int):
        return value
    if isinstance(value, float):
        return int(value)
    if isinstance(value, str):
        normalized = value.strip()
        if not normalized:
            return None
        try:
            return int(normalized)
        except ValueError:
            return None
    return None


def _optional_float(value: object | None) -> float | None:
    if isinstance(value, bool):
        return None
    if isinstance(value, (int, float)):
        return float(value)
    if isinstance(value, str):
        normalized = value.strip()
        if not normalized:
            return None
        try:
            return float(normalized)
        except ValueError:
            return None
    return None


def _coverage_fields(*, requested_scope: str, granted_scope: str | None) -> CoverageFields:
    if not granted_scope:
        return {
            "requested_scope": requested_scope,
            "granted_scope": None,
            "coverage_kind": None,
            "covered_by_existing_grant": False,
        }
    return {
        "requested_scope": requested_scope,
        "granted_scope": granted_scope,
        "coverage_kind": "exact" if granted_scope == requested_scope else "superset",
        "covered_by_existing_grant": True,
    }


def _export_fields(export_metadata: dict[str, object] | None) -> ExportFields:
    metadata = _metadata_object_map(export_metadata)
    return {
        "export_revision": _optional_int(metadata.get("export_revision")),
        "export_generated_at": _optional_str(metadata.get("export_generated_at")),
        "export_refresh_status": _optional_str(metadata.get("refresh_status")),
    }


async def _resolve_strict_covering_active_token(
    *,
    service: ConsentDBService,
    user_id: str,
    agent_id: str,
    requested_scope: str,
) -> tuple[dict[str, Any] | None, dict[str, object] | None, bool]:
    invalidated_legacy = False
    covering_tokens = await service.get_covering_active_tokens(
        user_id,
        agent_id=agent_id,
        requested_scope=requested_scope,
    )
    for token_row in covering_tokens:
        token_id = str(token_row.get("token_id") or "").strip()
        if not token_id:
            continue
        export_metadata = await service.get_consent_export_metadata(token_id)
        export_metadata_map = _metadata_object_map(export_metadata)
        if export_metadata_map.get("is_strict_zero_knowledge"):
            return token_row, export_metadata_map, invalidated_legacy
        if export_metadata_map.get("legacy_export_key_present"):
            await service.invalidate_legacy_active_token(token_row)
            invalidated_legacy = True
    return None, None, invalidated_legacy


def _scope_upgrade_summary(
    *, requested_scope: str, existing_granted_scopes: list[str]
) -> str | None:
    if not existing_granted_scopes:
        return None
    if len(existing_granted_scopes) == 1:
        return (
            f"This app already has access to {existing_granted_scopes[0]} and is now requesting "
            f"additional access to {requested_scope}."
        )
    return (
        f"This app already has {len(existing_granted_scopes)} narrower scopes and is now requesting "
        f"additional access to {requested_scope}."
    )


def _scope_upgrade_fields(
    *,
    requested_scope: str,
    existing_granted_scopes: list[str],
) -> dict[str, object | None]:
    unique_scopes = sorted(
        {scope for scope in existing_granted_scopes if scope and scope != requested_scope}
    )
    is_scope_upgrade = bool(unique_scopes)
    return {
        "is_scope_upgrade": is_scope_upgrade,
        "existing_granted_scopes": unique_scopes or None,
        "additional_access_summary": _scope_upgrade_summary(
            requested_scope=requested_scope,
            existing_granted_scopes=unique_scopes,
        ),
    }


def _offer_metadata(offer: "DeveloperConsentOffer | None") -> dict[str, object]:
    """Flatten a priced-consent offer into consent-event metadata keys.

    Stored alongside the consent event so the bid is auditable and the user
    side can clear it against a reserve price. Returns {} when no offer.
    """
    if offer is None:
        return {}
    meta: dict[str, object] = {
        "offer_kind": "consent_reverse_auction_bid",
        "offer_bid_amount": round(float(offer.bid_amount), 2),
        "offer_currency": offer.currency.upper(),
    }
    if offer.offer_summary:
        meta["offer_summary"] = offer.offer_summary
    if offer.settlement_ref:
        meta["offer_settlement_ref"] = offer.settlement_ref
    return meta


def _offer_response_fields(metadata: dict[str, object] | None) -> dict[str, object | None]:
    """Surface the offer back to the caller, reading from event metadata.

    A non-null ``offer`` block tells the Demand Agent its bid was recorded and
    is awaiting the user's reserve-price clearance (handled by One/Nav). The
    bid is NOT settled here — AP2 settles at the money boundary on approval.
    """
    metadata = metadata or {}
    if metadata.get("offer_kind") != "consent_reverse_auction_bid":
        return {"offer": None}
    bid_amount = _optional_float(metadata.get("offer_bid_amount"))
    if bid_amount is None:
        return {"offer": None}
    return {
        "offer": {
            "kind": "consent_reverse_auction_bid",
            "bid_amount": bid_amount,
            "currency": _optional_str(metadata.get("offer_currency")) or "USD",
            "offer_summary": _optional_str(metadata.get("offer_summary")),
            "settlement_ref": _optional_str(metadata.get("offer_settlement_ref")),
            "settlement_status": "pending_user_clearance",
            "settlement_rail": "ap2",
        }
    }


def _developer_consent_status_payload(
    *,
    latest: dict[str, Any],
    user_id: str,
    request_id: str,
    principal: DeveloperPrincipal,
) -> dict[str, Any]:
    latest_action = str(latest.get("action") or "").strip().upper()
    resolved_status = _CONSENT_REQUEST_STATUS_MAP.get(latest_action, "unknown")
    metadata = _metadata_object_map(latest.get("metadata"))
    approval_timeout_at = latest.get("poll_timeout_at") or metadata.get("approval_timeout_at")
    consent_token = latest.get("token_id") if latest_action == "CONSENT_GRANTED" else None
    return {
        "status": resolved_status,
        "user_id": user_id,
        "request_id": request_id,
        "scope": latest.get("scope"),
        "requested_scope": str(latest.get("scope") or "") or None,
        "granted_scope": str(latest.get("scope") or "") or None,
        "coverage_kind": "exact" if latest.get("scope") else None,
        "covered_by_existing_grant": False,
        "consent_token": consent_token,
        "expires_at": latest.get("expires_at"),
        "poll_timeout_at": _optional_int(latest.get("poll_timeout_at")),
        "approval_timeout_at": _optional_int(approval_timeout_at),
        "approval_timeout_minutes": _optional_int(metadata.get("approval_timeout_minutes")),
        "expiry_hours": _optional_int(metadata.get("expiry_hours")),
        "request_url": _request_url_from_metadata(request_id, metadata),
        "requester_label": _optional_str(metadata.get("requester_label")),
        "requester_image_url": _optional_str(metadata.get("requester_image_url")),
        "reason": _optional_str(metadata.get("reason")),
        "app_id": principal.app_id,
        "app_display_name": principal.display_name,
        "terminal": resolved_status in _TERMINAL_CONSENT_STATUSES,
    }


async def _developer_consent_event_generator(
    *,
    request: Request,
    user_id: str,
    request_id: str,
    principal: DeveloperPrincipal,
    initial_latest: dict[str, Any],
) -> AsyncGenerator[dict[str, str], None]:
    from api.consent_listener import (
        subscribe_developer_consent_queue,
        unsubscribe_developer_consent_queue,
    )

    queue = await subscribe_developer_consent_queue(
        request_id=request_id,
        agent_id=principal.agent_id,
    )
    try:
        initial_payload = _developer_consent_status_payload(
            latest=initial_latest,
            user_id=user_id,
            request_id=request_id,
            principal=principal,
        )
        yield {
            "event": "snapshot",
            "id": f"{request_id}:snapshot",
            "data": json.dumps(initial_payload),
        }
        if initial_payload["terminal"]:
            return

        while True:
            if await request.is_disconnected():
                break
            try:
                data = await asyncio.wait_for(queue.get(), timeout=30)
            except asyncio.TimeoutError:
                yield {
                    "event": "heartbeat",
                    "data": json.dumps(
                        {
                            "request_id": request_id,
                            "timestamp": int(time.time() * 1000),
                        }
                    ),
                }
                continue

            if str(data.get("request_id") or "") != request_id:
                continue
            if str(data.get("agent_id") or "") != principal.agent_id:
                continue
            payload = _developer_consent_status_payload(
                latest=data,
                user_id=user_id,
                request_id=request_id,
                principal=principal,
            )
            event_id = (
                f"{request_id}:{data.get('action') or 'UNKNOWN'}:"
                f"{data.get('issued_at') or int(time.time() * 1000)}"
            )
            yield {
                "event": "consent_update",
                "id": event_id,
                "data": json.dumps(payload),
            }
            if payload["terminal"]:
                return
    finally:
        await unsubscribe_developer_consent_queue(
            request_id=request_id,
            agent_id=principal.agent_id,
            queue=queue,
        )


def _resolve_principal(
    *,
    request: Request,
    token: str | None,
    authorization: str | None,
) -> DeveloperPrincipal:
    return authenticate_developer_principal(
        token=token,
        authorization=authorization,
        request=request,
    )


def _compact_scope_entries(
    *,
    available_domains: list[str],
    scope_entries: list[dict],
) -> tuple[list[str], list[str], list[dict]]:
    compact_entries: list[dict] = []
    seen_scopes: set[str] = set()
    discovered_domains = set()

    for entry in scope_entries:
        if not isinstance(entry, dict):
            continue
        scope = str(entry.get("scope") or "").strip()
        if not scope or scope in seen_scopes:
            continue

        source_kind = str(entry.get("source_kind") or "").strip()
        wildcard = entry.get("wildcard") is True
        domain = str(entry.get("domain") or "").strip().lower() or None

        # Default developer discovery should expose requestable top-level consent
        # surfaces only. Deep path-level manifest rows remain available via verbose
        # mode for debugging and inspection.
        if source_kind not in {"pkm_index", "pkm_manifests.top_level_scope_paths"}:
            continue
        if not wildcard:
            continue
        if not ConsentScope.is_external_requestable_scope(scope):
            continue
        if entry.get("consumer_visible") is False or entry.get("internal_only") is True:
            continue
        if str(entry.get("visibility_posture") or "consent_required").strip().lower() == "private":
            continue

        compact_entries.append(entry)
        seen_scopes.add(scope)
        if domain:
            discovered_domains.add(domain)

    compact_scopes = sorted(
        {
            *(str(entry.get("scope") or "").strip() for entry in compact_entries),
        }
    )
    compact_domains = sorted(discovered_domains)
    return compact_domains, compact_scopes, compact_entries


def _scope_entry_for_scope(scope_entries: list[dict], scope: str) -> dict[str, Any] | None:
    normalized_scope = str(scope or "").strip()
    for entry in scope_entries:
        if not isinstance(entry, dict):
            continue
        if str(entry.get("scope") or "").strip() == normalized_scope:
            return entry
    return None


async def _get_user_scope_snapshot(
    user_id: str,
    *,
    detail: Literal["compact", "verbose"] = "compact",
) -> tuple[list[str], list[str], list[dict]]:
    pkm_service = get_pkm_service()
    index = await pkm_service.resolve_metadata_index(user_id)
    if index is None:
        return [], [], []
    available_domains = sorted(
        {
            str(domain).strip().lower()
            for domain in (index.available_domains or [])
            if str(domain).strip()
        }
    )
    get_available_scopes = pkm_service.scope_generator.get_available_scopes
    scope_signature = inspect.signature(get_available_scopes)
    scope_kwargs: dict[str, Any] = {}
    if "include_internal" in scope_signature.parameters:
        scope_kwargs["include_internal"] = False
    if "include_exact_paths" in scope_signature.parameters:
        scope_kwargs["include_exact_paths"] = False
    scopes = sorted(await get_available_scopes(user_id, **scope_kwargs))
    scope_entries_getter = getattr(pkm_service.scope_generator, "get_available_scope_entries", None)
    if callable(scope_entries_getter):
        scope_entries = [
            entry
            for entry in await scope_entries_getter(user_id)
            if isinstance(entry, dict)
            and ConsentScope.is_external_requestable_scope(str(entry.get("scope") or ""))
            and entry.get("consumer_visible") is not False
            and entry.get("internal_only") is not True
            and str(entry.get("visibility_posture") or "consent_required").strip().lower()
            != "private"
        ]
    else:
        scope_entries = [{"scope": scope} for scope in scopes if scope.startswith("attr.")]

    scopes = sorted(
        {
            str(entry.get("scope") or "").strip()
            for entry in scope_entries
            if str(entry.get("scope") or "").strip()
        }
    )

    if detail == "verbose":
        discovered_domains = {
            *available_domains,
            *(
                str(entry.get("domain") or "").strip().lower()
                for entry in scope_entries
                if isinstance(entry, dict) and str(entry.get("domain") or "").strip()
            ),
        }
        return sorted(discovered_domains), scopes, scope_entries

    return _compact_scope_entries(
        available_domains=available_domains,
        scope_entries=scope_entries,
    )


def _developer_root_payload() -> dict[str, object]:
    return {
        "version": "v1",
        "dynamic_scopes": True,
        "endpoints": {
            "list_scopes": "/api/v1/list-scopes",
            "tool_catalog": "/api/v1/tool-catalog",
            "user_scopes": "/api/v1/user-scopes/{user_id}",
            "request_consent": "/api/v1/request-consent",
            "public_profile_export": "/api/v1/public-profile-export",
            "consent_status": "/api/v1/consent-status",
            "scoped_export": "/api/v1/scoped-export",
            "scoped_export_download": "/api/v1/scoped-export/download",
        },
        "recommended_resources": [
            "hushh://info/connector",
            "hushh://info/developer-api",
        ],
        "recommended_mcp_flow": [
            "discover_user_domains",
            "read_public_profile_projection_when_available",
            "request_consent",
            "check_consent_status",
            "get_encrypted_scoped_export",
        ],
        "public_beta_default_tool_groups": list(DEFAULT_PUBLIC_TOOL_GROUPS),
        "developer_access": {
            "mode": "self_serve",
            "portal": "/developers",
            "portal_api": {
                "access": "/api/developer/access",
                "enable": "/api/developer/access/enable",
                "profile": "/api/developer/access/profile",
                "rotate_key": "/api/developer/access/rotate-key",
            },
        },
    }


def _serialize_token(token: dict | None) -> DeveloperPortalTokenResponse | None:
    if not token:
        return None
    return DeveloperPortalTokenResponse(
        id=int(token["id"]),
        app_id=str(token["app_id"]),
        token_prefix=str(token["token_prefix"]),
        label=str(token["label"]) if token.get("label") else None,
        created_at=int(token["created_at"]),
        revoked_at=int(token["revoked_at"]) if token.get("revoked_at") else None,
        last_used_at=int(token["last_used_at"]) if token.get("last_used_at") else None,
    )


def _serialize_app(app: dict | None) -> DeveloperPortalAppResponse | None:
    if not app:
        return None
    allowed_groups = normalize_tool_groups(app.get("allowed_tool_groups"))
    allowed_capabilities = DeveloperRegistryService._parse_allowed_capabilities(
        app.get("allowed_capabilities")
    )
    return DeveloperPortalAppResponse(
        app_id=str(app["app_id"]),
        agent_id=str(app["agent_id"]),
        display_name=str(app["display_name"]),
        contact_email=str(app["contact_email"]),
        support_url=str(app["support_url"]) if app.get("support_url") else None,
        policy_url=str(app["policy_url"]) if app.get("policy_url") else None,
        website_url=str(app["website_url"]) if app.get("website_url") else None,
        brand_image_url=str(app["brand_image_url"]) if app.get("brand_image_url") else None,
        status=str(app["status"]),
        allowed_tool_groups=list(allowed_groups),
        allowed_capabilities=list(allowed_capabilities),
        created_at=int(app["created_at"]),
        updated_at=int(app["updated_at"]),
    )


def _portal_access_response(
    *,
    firebase_uid: str,
    owner_email: str | None,
    owner_display_name: str | None,
    owner_provider_ids: list[str] | tuple[str, ...] | None,
    app: dict | None,
    active_token: dict | None,
    raw_token: str | None = None,
) -> DeveloperPortalAccessResponse:
    provider_ids = [str(item).strip() for item in (owner_provider_ids or []) if str(item).strip()]
    return DeveloperPortalAccessResponse(
        access_enabled=app is not None,
        user_id=firebase_uid,
        owner_email=owner_email,
        owner_display_name=owner_display_name,
        owner_provider_ids=provider_ids,
        app=_serialize_app(app),
        active_token=_serialize_token(active_token),
        raw_token=raw_token,
    )


def _resolve_firebase_owner_profile(firebase_uid: str) -> OwnerProfile:
    owner_email: str | None = None
    owner_display_name: str | None = None
    owner_provider_ids: list[str] = []

    try:
        from firebase_admin import auth as firebase_auth

        firebase_app = get_firebase_auth_app()
        if firebase_app is not None:
            user_record = firebase_auth.get_user(firebase_uid, app=firebase_app)
            owner_email = getattr(user_record, "email", None)
            owner_display_name = getattr(user_record, "display_name", None)
            owner_provider_ids = sorted(
                {
                    str(getattr(provider, "provider_id", "")).strip()
                    for provider in (getattr(user_record, "provider_data", None) or [])
                    if str(getattr(provider, "provider_id", "")).strip()
                }
            )
    except Exception as exc:
        logger.warning("developer.portal.profile_lookup_failed uid=%s error=%s", firebase_uid, exc)

    return {
        "owner_email": owner_email,
        "owner_display_name": owner_display_name,
        "owner_provider_ids": owner_provider_ids,
    }


@developer_api_router.get("/list-scopes", response_model=DeveloperScopeCatalogResponse)
async def list_scopes():
    if not developer_api_enabled():
        raise developer_api_disabled_error()

    return DeveloperScopeCatalogResponse(
        scopes=_scope_catalog(),
        mcp_tools=list(visible_tool_names_for_groups(DEFAULT_PUBLIC_TOOL_GROUPS)),
    )


@developer_api_router.get("")
async def developer_api_root():
    if not developer_api_enabled():
        raise developer_api_disabled_error()

    return _developer_root_payload()


@developer_api_router.get("/tool-catalog", response_model=DeveloperToolCatalogResponse)
async def get_tool_catalog(
    request: Request,
    token: Optional[str] = Query(None, max_length=2048),
    authorization: Optional[str] = Header(None),
):
    if not developer_api_enabled():
        raise developer_api_disabled_error()

    principal = try_authenticate_developer_principal(
        token=token,
        authorization=authorization,
        request=request,
    )
    payload = DeveloperRegistryService().get_tool_catalog(principal=principal)
    return DeveloperToolCatalogResponse(
        **payload,
        app_id=principal.app_id if principal else None,
        app_display_name=principal.display_name if principal else None,
    )


@developer_api_router.get("/user-scopes/{user_id}", response_model=DeveloperUserScopesResponse)
async def get_user_scopes(
    user_id: str,
    request: Request,
    token: Optional[str] = Query(None, max_length=2048),
    authorization: Optional[str] = Header(None),
    detail: Literal["compact", "verbose"] = Query(default="compact"),
):
    principal = _resolve_principal(
        request=request,
        token=token,
        authorization=authorization,
    )

    available_domains, scopes, scope_entries = await _get_user_scope_snapshot(
        user_id,
        detail=detail,
    )
    return DeveloperUserScopesResponse(
        user_id=user_id,
        available_domains=available_domains,
        scopes=scopes,
        scope_entries=scope_entries,
        app_id=principal.app_id,
        app_display_name=principal.display_name,
    )


@developer_api_router.get(
    "/user-scopes/{user_id}/search", response_model=DeveloperScopeSearchResponse
)
@limiter.limit(RateLimits.SEARCH_SCOPES)
async def search_user_scopes(
    user_id: str,
    request: Request,
    query: str | None = Query(default=None, max_length=200),
    domain: str | None = Query(default=None, max_length=128),
    limit: int = Query(default=20, ge=1, le=50),
    token: Optional[str] = Query(None, max_length=2048),
    authorization: Optional[str] = Header(None),
):
    """Deterministically ranked lookup over a user's discoverable scopes.

    Graceful by contract: an unknown domain or no-match returns an empty match
    list plus the user's available domains, never an error status.
    """
    from hushh_mcp.consent.scope_generator import rank_scope_matches

    principal = _resolve_principal(
        request=request,
        token=token,
        authorization=authorization,
    )

    available_domains, _scopes, scope_entries = await _get_user_scope_snapshot(
        user_id,
        detail="verbose",
    )
    matches = rank_scope_matches(
        scope_entries,
        query=str(query or ""),
        domain=str(domain or ""),
        limit=limit,
    )
    return DeveloperScopeSearchResponse(
        user_id=user_id,
        query=query,
        domain=domain,
        matches=matches,
        available_domains=available_domains,
        app_id=principal.app_id,
        app_display_name=principal.display_name,
    )


@developer_api_router.get("/consent-status", response_model=DeveloperConsentStatusResponse)
async def get_consent_status(
    request: Request,
    user_id: str = Query(..., alias="user_id", max_length=128),
    scope: str | None = Query(default=None, max_length=500),
    request_id: str | None = Query(default=None, max_length=200),
    token: Optional[str] = Query(None, max_length=2048),
    authorization: Optional[str] = Header(None),
):
    principal = _resolve_principal(
        request=request,
        token=token,
        authorization=authorization,
    )
    normalized_scope = normalize_scope(scope) if scope else None

    service = ConsentDBService()
    if normalized_scope:
        active, export_metadata, invalidated_legacy = await _resolve_strict_covering_active_token(
            service=service,
            user_id=user_id,
            agent_id=principal.agent_id,
            requested_scope=normalized_scope,
        )
        if active:
            active_metadata = _metadata_object_map(active.get("metadata"))
            coverage = _coverage_fields(
                requested_scope=normalized_scope,
                granted_scope=_optional_str(active.get("scope")),
            )
            export_fields = _export_fields(export_metadata)
            return DeveloperConsentStatusResponse(
                status="granted",
                user_id=user_id,
                scope=normalized_scope,
                requested_scope=coverage["requested_scope"],
                granted_scope=coverage["granted_scope"],
                coverage_kind=coverage["coverage_kind"],
                covered_by_existing_grant=coverage["covered_by_existing_grant"],
                request_id=active.get("request_id"),
                consent_token=active.get("token_id"),
                expires_at=active.get("expires_at"),
                export_revision=export_fields["export_revision"],
                export_generated_at=export_fields["export_generated_at"],
                export_refresh_status=export_fields["export_refresh_status"],
                expiry_hours=_optional_int(active_metadata.get("expiry_hours")),
                request_url=_request_url_from_metadata(active.get("request_id"), active_metadata),
                requester_label=_optional_str(active_metadata.get("requester_label")),
                requester_image_url=_optional_str(active_metadata.get("requester_image_url")),
                reason=_optional_str(active_metadata.get("reason")),
                app_id=principal.app_id,
                app_display_name=principal.display_name,
                message=(
                    "Consent is active for this app and scope."
                    if str(active.get("scope") or "") == normalized_scope
                    else "Consent is active for this app; an existing broader grant covers the requested scope."
                ),
            )
        if invalidated_legacy:
            return DeveloperConsentStatusResponse(
                status="requires_reconsent",
                user_id=user_id,
                scope=normalized_scope,
                requested_scope=normalized_scope,
                app_id=principal.app_id,
                app_display_name=principal.display_name,
                message=(
                    "A legacy consent export for this app was invalidated because it was not wrapped-key-only. "
                    "Request consent again to receive a strict zero-knowledge export."
                ),
            )

    if request_id:
        latest = await service.get_request_status(user_id, request_id)
        if latest and latest.get("agent_id") == principal.agent_id:
            latest_action = str(latest.get("action") or "").strip().upper()
            status_map = {
                "REQUESTED": "pending",
                "CONSENT_GRANTED": "granted",
                "CONSENT_DENIED": "denied",
                "TIMEOUT": "expired",
                "CANCELLED": "cancelled",
                "REVOKED": "revoked",
            }
            resolved_status = status_map.get(latest_action, "unknown")
            metadata = _metadata_object_map(latest.get("metadata"))
            approval_timeout_at = latest.get("poll_timeout_at") or metadata.get(
                "approval_timeout_at"
            )
            export_metadata = None
            if latest_action == "CONSENT_GRANTED" and latest.get("token_id"):
                export_metadata = await service.get_consent_export_metadata(
                    str(latest.get("token_id"))
                )
            export_fields = _export_fields(export_metadata)
            consent_token = latest.get("token_id") if latest_action == "CONSENT_GRANTED" else None
            return DeveloperConsentStatusResponse(
                status=resolved_status,
                user_id=user_id,
                scope=latest.get("scope"),
                requested_scope=str(latest.get("scope") or "") or normalized_scope or None,
                granted_scope=str(latest.get("scope") or "") or None,
                coverage_kind="exact" if latest.get("scope") else None,
                covered_by_existing_grant=False,
                request_id=request_id,
                consent_token=consent_token,
                expires_at=latest.get("expires_at"),
                export_revision=export_fields["export_revision"],
                export_generated_at=export_fields["export_generated_at"],
                export_refresh_status=export_fields["export_refresh_status"],
                poll_timeout_at=_optional_int(latest.get("poll_timeout_at")),
                approval_timeout_at=_optional_int(approval_timeout_at),
                approval_timeout_minutes=_optional_int(metadata.get("approval_timeout_minutes")),
                expiry_hours=_optional_int(metadata.get("expiry_hours")),
                is_scope_upgrade=bool(metadata.get("is_scope_upgrade")),
                existing_granted_scopes=_normalize_scope_list(
                    metadata.get("existing_granted_scopes")
                )
                or None,
                additional_access_summary=str(
                    metadata.get("additional_access_summary") or ""
                ).strip()
                or None,
                request_url=_request_url_from_metadata(request_id, metadata),
                requester_label=_optional_str(metadata.get("requester_label")),
                requester_image_url=_optional_str(metadata.get("requester_image_url")),
                reason=_optional_str(metadata.get("reason")),
                app_id=principal.app_id,
                app_display_name=principal.display_name,
                message=f"Latest request action is {latest_action or 'UNKNOWN'}.",
            )

    return DeveloperConsentStatusResponse(
        status="not_found",
        user_id=user_id,
        scope=normalized_scope,
        requested_scope=normalized_scope,
        request_id=request_id,
        app_id=principal.app_id,
        app_display_name=principal.display_name,
        message="No matching consent state was found for this app.",
    )


@developer_api_router.get("/consent-events")
async def stream_consent_events(
    request: Request,
    user_id: str = Query(..., alias="user_id", max_length=128),
    request_id: str = Query(..., max_length=200),
    token: Optional[str] = Query(None, max_length=2048),
    authorization: Optional[str] = Header(None),
):
    principal = _resolve_principal(
        request=request,
        token=token,
        authorization=authorization,
    )
    latest = await ConsentDBService().get_request_status(user_id, request_id)
    if not latest or latest.get("agent_id") != principal.agent_id:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail={
                "error_code": "CONSENT_REQUEST_NOT_FOUND",
                "message": "No matching consent request was found for this developer app.",
            },
        )

    return EventSourceResponse(
        _developer_consent_event_generator(
            request=request,
            user_id=user_id,
            request_id=request_id,
            principal=principal,
            initial_latest=latest,
        ),
        headers={
            "Cache-Control": "no-store, no-cache",
            "Pragma": "no-cache",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
        },
    )


@developer_api_router.post("/request-consent")
@limiter.limit(RateLimits.CONSENT_REQUEST)
async def request_consent(
    payload: DeveloperConsentRequest,
    request: Request,
    token: Optional[str] = Query(None, max_length=2048),
    authorization: Optional[str] = Header(None),
):
    principal = _resolve_principal(
        request=request,
        token=token,
        authorization=authorization,
    )

    normalized_scope = normalize_scope(payload.scope)
    if normalized_scope in RETIRED_SCOPE_VALUES:
        raise HTTPException(
            status_code=status.HTTP_410_GONE,
            detail={
                "error_code": "SCOPE_RETIRED",
                "message": "This scope is retired and cannot authorize a new request.",
                "replacement": "cap.one.invoke"
                if normalized_scope == "agent.one.orchestrate"
                else None,
            },
        )
    if normalized_scope in INTERNAL_ONLY_SCOPE_VALUES:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail={
                "error_code": "INTERNAL_SCOPE_NOT_REQUESTABLE",
                "message": "Internal PKM and vault authorities cannot be requested externally.",
            },
        )
    if normalized_scope in EXTERNAL_REQUESTABLE_RESERVED_SCOPE_VALUES and normalized_scope not in (
        getattr(principal, "allowed_capabilities", ()) or ()
    ):
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail={
                "error_code": "APP_CAPABILITY_NOT_ALLOWED",
                "message": "This developer app is not permitted to request that capability.",
            },
        )
    if not _is_supported_scope(normalized_scope):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail={
                "error_code": "INVALID_SCOPE",
                "message": f"Unsupported scope: {payload.scope}",
                "valid_scopes": [descriptor.name for descriptor in _scope_catalog()],
            },
        )

    expiry_hours = _validate_public_expiry_hours(payload.expiry_hours)
    approval_timeout_minutes = _validate_public_approval_timeout_minutes(
        payload.approval_timeout_minutes
    )
    is_information_scope = normalized_scope.startswith("attr.")
    connector_wrapping_alg: str | None = None
    recipient_key_fingerprint: str | None = None
    if is_information_scope:
        if not all(
            (
                payload.connector_public_key,
                payload.connector_key_id,
                payload.connector_wrapping_alg,
            )
        ):
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail={
                    "error_code": "CONNECTOR_KEY_REQUIRED",
                    "message": "Encrypted attr.* grants require connector key binding.",
                },
            )
        connector_wrapping_alg = _validate_connector_wrapping_alg(
            str(payload.connector_wrapping_alg)
        )
        recipient_key_fingerprint = _validate_connector_public_key(
            str(payload.connector_public_key)
        )
    elif payload.refresh_policy != "snapshot":
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail={
                "error_code": "REFRESH_POLICY_NOT_APPLICABLE",
                "message": "Continuous refresh applies only to encrypted attr.* grants.",
            },
        )

    # Keep default developer discovery compact, but validate requestable scopes
    # against the full resolver output so explicitly requested leaf paths found via
    # verbose/debug discovery remain valid.
    available_domains, discovered_scopes, scope_entries = await _get_user_scope_snapshot(
        payload.user_id,
        detail="verbose",
    )
    if normalized_scope.startswith("attr.") and normalized_scope not in set(discovered_scopes):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail={
                "error_code": "SCOPE_NOT_DISCOVERED_FOR_USER",
                "message": "Requested scope is not available for this user.",
                "discovery_hint": "Call GET /api/v1/user-scopes/{user_id} first and request one of the returned scopes.",
                "available_domains": available_domains,
            },
        )
    discovered_entry = _scope_entry_for_scope(scope_entries, normalized_scope)
    scope_handle = str(
        (discovered_entry or {}).get("registry_handle") or ""
    ).strip() or scope_handle_for_machine_scope(payload.user_id, normalized_scope)

    service = ConsentDBService()
    if is_information_scope:
        active, export_metadata, _invalidated_legacy = await _resolve_strict_covering_active_token(
            service=service,
            user_id=payload.user_id,
            agent_id=principal.agent_id,
            requested_scope=normalized_scope,
        )
    else:
        active = await service.find_covering_active_token(
            payload.user_id,
            agent_id=principal.agent_id,
            requested_scope=normalized_scope,
        )
        export_metadata = None
    if active and is_information_scope:
        export_fingerprint = str(
            (export_metadata or {}).get("recipient_key_fingerprint") or ""
        ).strip()
        export_policy = str((export_metadata or {}).get("refresh_policy") or "snapshot").strip()
        if export_fingerprint and export_fingerprint != recipient_key_fingerprint:
            active = None
        elif export_policy != payload.refresh_policy:
            active = None
    if active:
        active_metadata = _metadata_object_map(active.get("metadata"))
        granted_scope = str(active.get("scope") or "") or None
        coverage = _coverage_fields(
            requested_scope=normalized_scope,
            granted_scope=granted_scope,
        )
        export_fields = _export_fields(export_metadata)
        logger.info(
            "developer_api.request_consent.reused scope=%s app_id=%s",
            normalized_scope,
            principal.app_id,
        )
        return {
            "status": "already_granted",
            "message": (
                "Consent already active for this developer app and scope."
                if granted_scope == normalized_scope
                else "Consent already active for this developer app; an existing broader grant covers the requested scope."
            ),
            "consent_token": active.get("token_id"),
            "expires_at": active.get("expires_at"),
            "request_id": active.get("request_id"),
            "scope": normalized_scope,
            **coverage,
            **export_fields,
            "expiry_hours": _optional_int(active_metadata.get("expiry_hours")),
            "refresh_policy": (export_metadata or {}).get("refresh_policy") or "snapshot",
            "request_url": _request_url_from_metadata(active.get("request_id"), active_metadata),
            "requester_label": _optional_str(active_metadata.get("requester_label")),
            "requester_image_url": _optional_str(active_metadata.get("requester_image_url")),
            "reason": _optional_str(active_metadata.get("reason")),
            "agent_id": principal.agent_id,
            "app_id": principal.app_id,
            "app_display_name": principal.display_name,
            **_offer_response_fields(active_metadata),
        }

    pending = await service.get_pending_request_for_scope(
        payload.user_id,
        agent_id=principal.agent_id,
        scope=normalized_scope,
    )
    if pending:
        pending_metadata = _metadata_object_map(pending.get("metadata"))
        return {
            "status": "pending",
            "message": "Consent request already pending in the Hussh app.",
            "request_id": pending.get("id"),
            "scope": normalized_scope,
            **_coverage_fields(
                requested_scope=normalized_scope,
                granted_scope=None,
            ),
            "scope_description": pending.get("scopeDescription")
            or get_scope_description(normalized_scope),
            "poll_timeout_at": pending.get("pollTimeoutAt"),
            "approval_timeout_at": pending.get("approvalTimeoutAt"),
            "approval_timeout_minutes": pending.get("approvalTimeoutMinutes"),
            "expiry_hours": pending.get("expiryHours"),
            "refresh_policy": pending_metadata.get("refresh_policy") or "snapshot",
            "agent_id": principal.agent_id,
            "app_id": principal.app_id,
            "app_display_name": principal.display_name,
            "request_url": pending.get("requestUrl"),
            "requester_label": pending.get("requesterLabel"),
            "requester_image_url": pending.get("requesterImageUrl"),
            "reason": pending.get("reason") or pending_metadata.get("reason"),
            "approval_surface": "/consents?tab=pending",
            "is_scope_upgrade": bool(
                pending.get("isScopeUpgrade") or pending_metadata.get("is_scope_upgrade")
            ),
            "existing_granted_scopes": pending.get("existingGrantedScopes")
            or _normalize_scope_list(pending_metadata.get("existing_granted_scopes"))
            or None,
            "additional_access_summary": pending.get("additionalAccessSummary")
            or str(pending_metadata.get("additional_access_summary") or "").strip()
            or None,
            **_offer_response_fields(pending_metadata),
        }

    if await service.was_recently_denied(
        payload.user_id,
        normalized_scope,
        agent_id=principal.agent_id,
    ):
        return {
            "status": "denied_recently",
            "message": "This scope was recently denied. Wait before sending another request.",
            "scope": normalized_scope,
            "agent_id": principal.agent_id,
            "app_id": principal.app_id,
            "app_display_name": principal.display_name,
        }

    request_id = f"req_{uuid.uuid4().hex[:28]}"
    now_ms = int(time.time() * 1000)
    poll_timeout_at = now_ms + (approval_timeout_minutes * 60 * 1000)
    scope_description = get_scope_description(normalized_scope)
    existing_granted_scopes = [
        str(token.get("scope") or "")
        for token in await service.get_superseded_active_tokens(
            payload.user_id,
            agent_id=principal.agent_id,
            requested_scope=normalized_scope,
        )
        if str(token.get("scope") or "").strip()
    ]
    scope_upgrade_fields = _scope_upgrade_fields(
        requested_scope=normalized_scope,
        existing_granted_scopes=existing_granted_scopes,
    )
    metadata = DeveloperRegistryService.build_consent_metadata(
        principal,
        reason=payload.reason,
        connector_public_key=payload.connector_public_key if is_information_scope else None,
        connector_key_id=payload.connector_key_id if is_information_scope else None,
        connector_wrapping_alg=connector_wrapping_alg,
    )
    request_url = build_consent_request_url(request_id=request_id)
    offer_meta = _offer_metadata(payload.offer)
    metadata.update(
        {
            "expiry_hours": expiry_hours,
            "approval_timeout_minutes": approval_timeout_minutes,
            "approval_timeout_at": poll_timeout_at,
            "request_url": request_url,
            "refresh_policy": payload.refresh_policy,
            "scope_handle": scope_handle,
            "scope_contract_version": 2,
            "recipient_key_fingerprint": recipient_key_fingerprint,
            **scope_upgrade_fields,
            **offer_meta,
        }
    )

    await service.insert_event(
        user_id=payload.user_id,
        agent_id=principal.agent_id,
        scope=normalized_scope,
        action="REQUESTED",
        request_id=request_id,
        scope_description=scope_description,
        poll_timeout_at=poll_timeout_at,
        metadata=metadata,
    )

    logger.info(
        "developer_api.request_consent.created scope=%s app_id=%s",
        normalized_scope,
        principal.app_id,
    )
    return {
        "status": "pending",
        "message": "Consent request submitted. User approval is pending in the Hussh app.",
        "request_id": request_id,
        "scope": normalized_scope,
        **_coverage_fields(
            requested_scope=normalized_scope,
            granted_scope=None,
        ),
        "scope_description": scope_description,
        "poll_timeout_at": poll_timeout_at,
        "approval_timeout_at": poll_timeout_at,
        "approval_timeout_minutes": approval_timeout_minutes,
        "expiry_hours": expiry_hours,
        "refresh_policy": payload.refresh_policy,
        "agent_id": principal.agent_id,
        "app_id": principal.app_id,
        "app_display_name": principal.display_name,
        "request_url": request_url,
        "requester_label": _optional_str(metadata.get("requester_label")),
        "requester_image_url": _optional_str(metadata.get("requester_image_url")),
        "reason": payload.reason,
        "approval_surface": "/consents?tab=pending",
        "is_scope_upgrade": scope_upgrade_fields["is_scope_upgrade"],
        "existing_granted_scopes": scope_upgrade_fields["existing_granted_scopes"],
        "additional_access_summary": scope_upgrade_fields["additional_access_summary"],
        **_offer_response_fields(metadata),
    }


@developer_api_router.post(
    "/public-profile-export",
    response_model=DeveloperPublicProfileExportResponse,
)
async def get_public_profile_export(
    payload: DeveloperPublicProfileExportRequest,
    request: Request,
    authorization: Optional[str] = Header(None),
):
    principal = _resolve_principal(
        request=request,
        token=None,
        authorization=authorization,
    )
    projection = await get_pkm_service().get_public_profile_projection(
        user_id=payload.user_id,
        public_profile_handle=payload.public_profile_handle,
    )
    if not projection or not projection.get("projection_payload"):
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail={
                "error_code": "PUBLIC_PROFILE_NOT_FOUND",
                "message": "No active owner-published public profile was found.",
            },
        )

    await ConsentDBService().insert_internal_event(
        user_id=payload.user_id,
        agent_id=principal.agent_id,
        scope=f"public_profile:{payload.public_profile_handle}",
        action="PUBLIC_PROFILE_READ",
        token_id=f"public_profile_{uuid.uuid4().hex[:24]}",
        scope_description="Owner-published public profile projection",
        metadata={
            "app_id": principal.app_id,
            "app_display_name": principal.display_name,
            "projection_hash": projection.get("projection_hash"),
            "projection_version": projection.get("projection_version"),
            "top_level_scope_path": projection.get("top_level_scope_path"),
            "public_profile_handle": payload.public_profile_handle,
            "publication_contract": projection.get("publication_provenance"),
        },
    )

    return DeveloperPublicProfileExportResponse(
        status="success",
        user_id=payload.user_id,
        public_profile_handle=payload.public_profile_handle,
        domain=str(projection.get("domain") or "") or None,
        top_level_scope_path=str(projection.get("top_level_scope_path") or "") or None,
        projection_payload=dict(projection.get("projection_payload") or {}),
        projection_hash=str(projection.get("projection_hash") or "") or None,
        projection_version=_optional_int(projection.get("projection_version")),
        projection_updated_at=_optional_str(projection.get("updated_at")),
        app_id=principal.app_id,
        app_display_name=principal.display_name,
        message="Owner-published public profile projection ready.",
    )


async def _load_scoped_export_or_raise(
    *,
    request: Request,
    token: Optional[str],
    authorization: Optional[str],
    user_id: str,
    consent_token: str,
    expected_scope: str | None,
) -> tuple[DeveloperPrincipal, Any, dict]:
    """Shared auth + fetch path for /scoped-export and /scoped-export/download.

    Validates the developer principal, the consent token (signature, expiry,
    scope), user binding, and app binding, then loads the active encrypted
    export. Raises HTTPException on any failure; both endpoints must enforce
    an identical trust boundary.
    """
    principal = _resolve_principal(
        request=request,
        token=token,
        authorization=authorization,
    )
    valid, reason, token_obj = await validate_token_with_db(
        consent_token,
        expected_scope=expected_scope,
    )
    if not valid or token_obj is None:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail={
                "error_code": "INVALID_CONSENT_TOKEN",
                "message": f"Consent validation failed: {reason or 'unknown error'}",
            },
        )

    if str(token_obj.user_id) != user_id:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail={
                "error_code": "CONSENT_TOKEN_USER_MISMATCH",
                "message": "Token user_id does not match the requested user_id.",
            },
        )
    if str(token_obj.agent_id) != principal.agent_id:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail={
                "error_code": "CONSENT_TOKEN_APP_MISMATCH",
                "message": "This consent token belongs to a different developer app.",
            },
        )

    service = ConsentDBService()
    export_data = await service.get_consent_export(consent_token)
    if not export_data:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail={
                "error_code": "SCOPED_EXPORT_NOT_FOUND",
                "message": "No active encrypted export is available for this consent token.",
            },
        )
    refresh_status = str(export_data.get("refresh_status") or "current")
    if refresh_status != "current":
        error_code = {
            "refresh_pending": "EXPORT_REFRESH_PENDING",
            "refresh_failed": "EXPORT_REFRESH_FAILED",
            "scope_retired": "SCOPE_RETIRED",
            "key_rebind_required": "CONNECTOR_KEY_REBIND_REQUIRED",
        }.get(refresh_status, "EXPORT_NOT_CURRENT")
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail={
                "error_code": error_code,
                "message": "The current encrypted export is not available for retrieval.",
            },
        )
    if (
        export_data.get("is_strict_zero_knowledge")
        and int(export_data.get("envelope_version") or 1) != 2
    ):
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail={
                "error_code": "EXPORT_ENVELOPE_UPGRADE_REQUIRED",
                "message": "This snapshot predates envelope v2 and must be approved again.",
            },
        )
    if (
        export_data.get("is_strict_zero_knowledge")
        and int(export_data.get("envelope_version") or 1) == 2
        and str(export_data.get("app_id") or "") != principal.app_id
    ):
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail={
                "error_code": "CONSENT_EXPORT_APP_MISMATCH",
                "message": "This encrypted export belongs to a different developer app.",
            },
        )
    return principal, token_obj, export_data


@developer_api_router.post("/scoped-export", response_model=DeveloperScopedExportResponse)
async def get_scoped_export(
    payload: DeveloperScopedExportRequest,
    request: Request,
    token: Optional[str] = Query(None, max_length=2048),
    authorization: Optional[str] = Header(None),
):
    expected_scope = normalize_scope(payload.expected_scope) if payload.expected_scope else None
    principal, token_obj, export_data = await _load_scoped_export_or_raise(
        request=request,
        token=token,
        authorization=authorization,
        user_id=payload.user_id,
        consent_token=payload.consent_token,
        expected_scope=expected_scope,
    )
    service = ConsentDBService()

    if not export_data.get("is_strict_zero_knowledge"):
        await service.invalidate_legacy_active_token(
            {
                "user_id": payload.user_id,
                "agent_id": principal.agent_id,
                "scope": export_data.get("scope") or token_obj.scope_str or token_obj.scope.value,
                "token_id": payload.consent_token,
            }
        )
        raise HTTPException(
            status_code=status.HTTP_410_GONE,
            detail={
                "error_code": "LEGACY_EXPORT_INVALIDATED",
                "message": (
                    "This consent grant used a deprecated non-zero-knowledge export format. "
                    "Request consent again to receive a wrapped-key-only export."
                ),
            },
        )

    granted_scope = str(export_data.get("scope") or token_obj.scope_str or token_obj.scope.value)
    export_id = str(export_data.get("export_id") or "")
    export_revision = int(export_data.get("export_revision") or 1)
    resource_origin = str(os.getenv("CONSENT_API_PUBLIC_ORIGIN") or "").strip().rstrip("/") or str(
        request.base_url
    ).rstrip("/")
    resource_uri = (
        f"{resource_origin}/api/v1/scoped-export/resources/{export_id}/revisions/{export_revision}"
    )
    return DeveloperScopedExportResponse(
        status="success",
        user_id=payload.user_id,
        consent_token=payload.consent_token,
        granted_scope=granted_scope,
        expected_scope=expected_scope,
        coverage_kind="exact"
        if not expected_scope or expected_scope == granted_scope
        else "superset",
        expires_at=token_obj.expires_at,
        export_revision=export_data.get("export_revision"),
        export_generated_at=_optional_str(export_data.get("export_generated_at")),
        export_refresh_status=export_data.get("refresh_status"),
        encrypted_data=None,
        iv=export_data.get("iv"),
        tag=export_data.get("tag"),
        wrapped_key_bundle=export_data.get("wrapped_key_bundle"),
        export_envelope={
            "version": export_data.get("envelope_version"),
            "export_id": export_id,
            "aad": export_data.get("envelope_aad"),
            "aad_sha256": export_data.get("envelope_aad_sha256"),
            "ciphertext_sha256": export_data.get("ciphertext_sha256"),
            "ciphertext_bytes": export_data.get("ciphertext_bytes"),
        },
        resource_link={
            "uri": resource_uri,
            "name": f"Hussh encrypted export revision {export_revision}",
            "mime_type": "application/octet-stream",
            "size": export_data.get("ciphertext_bytes"),
            "auth": "developer_bearer",
        },
        maximum_raw_bytes=_CONSENT_EXPORT_MAX_RAW_BYTES,
        message=(
            "Encrypted scoped export ready."
            if not expected_scope or expected_scope == granted_scope
            else "Encrypted export ready. The granted scope is broader than expected_scope, so narrow it client-side after decrypting."
        ),
    )


def _parse_single_byte_range(range_header: str | None, total_bytes: int) -> tuple[int, int] | None:
    if not range_header:
        return None
    value = range_header.strip()
    if not value.startswith("bytes=") or "," in value:
        raise ValueError("invalid_range")
    start_raw, separator, end_raw = value.removeprefix("bytes=").partition("-")
    if not separator:
        raise ValueError("invalid_range")
    if not start_raw:
        suffix_length = int(end_raw)
        if suffix_length <= 0:
            raise ValueError("invalid_range")
        start = max(0, total_bytes - suffix_length)
        return start, total_bytes - 1
    start = int(start_raw)
    end = int(end_raw) if end_raw else total_bytes - 1
    if start < 0 or start >= total_bytes or end < start:
        raise ValueError("range_not_satisfiable")
    return start, min(end, total_bytes - 1)


@developer_api_router.get("/scoped-export/resources/{export_id}/revisions/{revision}")
async def get_scoped_export_resource(
    request: Request,
    export_id: str = Path(min_length=32, max_length=64),
    revision: int = Path(ge=1, le=10_000_000),
    authorization: Optional[str] = Header(None),
    range_header: Optional[str] = Header(None, alias="Range"),
):
    """Stream immutable ciphertext bytes outside model context with range support."""

    principal = _resolve_principal(request=request, token=None, authorization=authorization)
    export_data = await ConsentDBService().get_consent_export_by_id(export_id)
    if not export_data:
        raise HTTPException(status_code=404, detail={"error_code": "SCOPED_EXPORT_NOT_FOUND"})
    if str(export_data.get("app_id") or "") != principal.app_id:
        raise HTTPException(
            status_code=403,
            detail={"error_code": "CROSS_TENANT_DENIED", "message": "Resource access denied."},
        )
    consent_token = str(export_data.get("consent_token") or "")
    valid, _reason, token_obj = await validate_token_with_db(consent_token)
    if not valid or token_obj is None or str(token_obj.agent_id) != principal.agent_id:
        raise HTTPException(status_code=401, detail={"error_code": "INVALID_CONSENT_TOKEN"})
    if int(export_data.get("export_revision") or 0) != revision:
        raise HTTPException(status_code=404, detail={"error_code": "EXPORT_REVISION_NOT_FOUND"})
    if str(export_data.get("refresh_status") or "") != "current":
        raise HTTPException(status_code=409, detail={"error_code": "EXPORT_REFRESH_PENDING"})
    if int(export_data.get("envelope_version") or 1) != 2:
        raise HTTPException(
            status_code=409,
            detail={"error_code": "EXPORT_ENVELOPE_UPGRADE_REQUIRED"},
        )
    try:
        ciphertext = base64.b64decode(str(export_data.get("encrypted_data") or ""), validate=True)
    except (binascii.Error, ValueError) as exc:
        raise HTTPException(
            status_code=500,
            detail={"error_code": "SCOPED_EXPORT_CORRUPT"},
        ) from exc
    expected_size = int(export_data.get("ciphertext_bytes") or 0)
    if expected_size != len(ciphertext) or digest_bytes(ciphertext) != str(
        export_data.get("ciphertext_sha256") or ""
    ):
        raise HTTPException(status_code=500, detail={"error_code": "SCOPED_EXPORT_CORRUPT"})

    headers = {
        "Accept-Ranges": "bytes",
        "Cache-Control": "private, no-store",
        "ETag": f'"{str(export_data.get("ciphertext_sha256") or "")}"',
        "X-Export-Revision": str(revision),
        "X-Content-Type-Options": "nosniff",
    }
    try:
        selected = _parse_single_byte_range(range_header, len(ciphertext))
    except (TypeError, ValueError):
        return Response(
            status_code=status.HTTP_416_REQUESTED_RANGE_NOT_SATISFIABLE,
            headers={**headers, "Content-Range": f"bytes */{len(ciphertext)}"},
        )
    if selected is None:
        return Response(content=ciphertext, media_type="application/octet-stream", headers=headers)
    start, end = selected
    headers["Content-Range"] = f"bytes {start}-{end}/{len(ciphertext)}"
    return Response(
        content=ciphertext[start : end + 1],
        status_code=status.HTTP_206_PARTIAL_CONTENT,
        media_type="application/octet-stream",
        headers=headers,
    )


@portal_router.get("/access", response_model=DeveloperPortalAccessResponse)
async def get_developer_access(
    firebase_uid: str = Depends(require_firebase_auth),
):
    if not developer_api_enabled():
        raise developer_api_disabled_error()

    registry = DeveloperRegistryService()
    owner_profile = _resolve_firebase_owner_profile(firebase_uid)
    app = registry.get_app_by_owner_uid(firebase_uid)
    active_token = registry.get_active_token(app_id=str(app["app_id"])) if app else None
    return _portal_access_response(
        firebase_uid=firebase_uid,
        owner_email=owner_profile["owner_email"] if isinstance(owner_profile, dict) else None,
        owner_display_name=owner_profile["owner_display_name"]
        if isinstance(owner_profile, dict)
        else None,
        owner_provider_ids=owner_profile["owner_provider_ids"]
        if isinstance(owner_profile, dict)
        else [],
        app=app,
        active_token=active_token,
    )


@portal_router.post("/access/enable", response_model=DeveloperPortalAccessResponse)
async def enable_developer_access(
    firebase_uid: str = Depends(require_firebase_auth),
):
    if not developer_api_enabled():
        raise developer_api_disabled_error()

    owner_profile = _resolve_firebase_owner_profile(firebase_uid)
    registry = DeveloperRegistryService()
    ensured = registry.ensure_self_serve_access(
        owner_firebase_uid=firebase_uid,
        owner_email=str(owner_profile.get("owner_email") or "").strip() or None,
        owner_display_name=str(owner_profile.get("owner_display_name") or "").strip() or None,
        owner_provider_ids=owner_profile.get("owner_provider_ids")
        if isinstance(owner_profile, dict)
        else [],
    )
    return _portal_access_response(
        firebase_uid=firebase_uid,
        owner_email=str(owner_profile.get("owner_email") or "").strip() or None,
        owner_display_name=str(owner_profile.get("owner_display_name") or "").strip() or None,
        owner_provider_ids=owner_profile.get("owner_provider_ids")
        if isinstance(owner_profile, dict)
        else [],
        app=ensured.get("app"),
        active_token=ensured.get("active_token"),
        raw_token=str(ensured.get("raw_token") or "").strip() or None,
    )


@portal_router.patch("/access/profile", response_model=DeveloperPortalAccessResponse)
async def update_developer_access_profile(
    payload: DeveloperPortalProfileUpdateRequest,
    firebase_uid: str = Depends(require_firebase_auth),
):
    if not developer_api_enabled():
        raise developer_api_disabled_error()

    registry = DeveloperRegistryService()
    updated_app = registry.update_self_serve_profile(
        owner_firebase_uid=firebase_uid,
        display_name=payload.display_name,
        website_url=payload.website_url,
        brand_image_url=payload.brand_image_url,
        support_url=payload.support_url,
        policy_url=payload.policy_url,
    )
    if updated_app is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail={
                "error_code": "DEVELOPER_ACCESS_NOT_ENABLED",
                "message": "Enable developer access before updating the app profile.",
            },
        )

    owner_profile = _resolve_firebase_owner_profile(firebase_uid)
    active_token = registry.get_active_token(app_id=str(updated_app["app_id"]))
    return _portal_access_response(
        firebase_uid=firebase_uid,
        owner_email=str(owner_profile.get("owner_email") or "").strip() or None,
        owner_display_name=str(owner_profile.get("owner_display_name") or "").strip() or None,
        owner_provider_ids=owner_profile.get("owner_provider_ids")
        if isinstance(owner_profile, dict)
        else [],
        app=updated_app,
        active_token=active_token,
    )


@portal_router.post("/access/rotate-key", response_model=DeveloperPortalAccessResponse)
async def rotate_developer_access_token(
    firebase_uid: str = Depends(require_firebase_auth),
):
    if not developer_api_enabled():
        raise developer_api_disabled_error()

    registry = DeveloperRegistryService()
    rotated = registry.rotate_self_serve_token(owner_firebase_uid=firebase_uid)
    if rotated is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail={
                "error_code": "DEVELOPER_ACCESS_NOT_ENABLED",
                "message": "Enable developer access before rotating a token.",
            },
        )

    owner_profile = _resolve_firebase_owner_profile(firebase_uid)
    return _portal_access_response(
        firebase_uid=firebase_uid,
        owner_email=str(owner_profile.get("owner_email") or "").strip() or None,
        owner_display_name=str(owner_profile.get("owner_display_name") or "").strip() or None,
        owner_provider_ids=owner_profile.get("owner_provider_ids")
        if isinstance(owner_profile, dict)
        else [],
        app=rotated.get("app"),
        active_token=rotated.get("active_token"),
        raw_token=str(rotated.get("raw_token") or "").strip() or None,
    )


router.include_router(developer_api_router)
router.include_router(portal_router)
