from __future__ import annotations

import inspect
import logging
import time
import uuid
from typing import Any, Literal, Optional, TypedDict, cast

from fastapi import APIRouter, Depends, Header, HTTPException, Query, Request, status
from pydantic import BaseModel, ConfigDict, Field

from api.developer_auth import (
    authenticate_developer_principal,
    developer_api_disabled_error,
    developer_api_enabled,
    try_authenticate_developer_principal,
)
from api.middleware import require_firebase_auth
from api.utils.firebase_admin import get_firebase_auth_app
from hushh_mcp.consent.scope_helpers import get_scope_description, normalize_scope
from hushh_mcp.consent.token import validate_token_with_db
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

_STATIC_REQUESTABLE_SCOPES = ("pkm.read", "pkm.write", "pkm.read", "pkm.write")
_MIN_PUBLIC_EXPIRY_HOURS = 24
_MAX_PUBLIC_EXPIRY_HOURS = 24 * 90
_MIN_PUBLIC_APPROVAL_TIMEOUT_MINUTES = 5
_MAX_PUBLIC_APPROVAL_TIMEOUT_MINUTES = 24 * 60


class DeveloperScopeDescriptor(BaseModel):
    name: str
    description: str
    dynamic: bool = False
    requires_discovery: bool = False


class DeveloperScopeCatalogResponse(BaseModel):
    version: str = "v1"
    scopes_are_dynamic: bool = True
    discovery_required: bool = True
    scopes: list[DeveloperScopeDescriptor]
    discovery_endpoint: str = "/api/v1/user-scopes/{user_id}"
    request_endpoint: str = "/api/v1/request-consent"
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
            "request_consent",
            "check_consent_status",
            "get_encrypted_scoped_export",
        ]
    )
    notes: list[str] = Field(
        default_factory=lambda: [
            "Do not hardcode domain keys. Discover available scopes per user at runtime.",
            "Dynamic attr scopes are derived from PKM discovery metadata and the scope registry.",
            "Use get_encrypted_scoped_export for all consented reads; Hushh does not return plaintext user data to developer callers.",
        ]
    )


class DeveloperUserScopesResponse(BaseModel):
    user_id: str
    available_domains: list[str] = Field(default_factory=list)
    scopes: list[str] = Field(default_factory=list)
    scope_entries: list[dict] = Field(default_factory=list)
    scopes_are_dynamic: bool = True
    source: str = "pkm_index + pkm_manifests.top_level_scope_paths + pkm_scope_registry"
    app_id: str | None = None
    app_display_name: str | None = None


class DeveloperToolCatalogResponse(BaseModel):
    version: str = "v1"
    approval_required: bool = False
    allowed_tool_groups: list[str]
    compatibility_status: str
    tools: list[dict]
    tool_groups: list[dict]
    recommended_flow: list[str]
    notes: list[str]
    app_id: str | None = None
    app_display_name: str | None = None


class DeveloperConsentStatusResponse(BaseModel):
    status: str
    user_id: str
    scope: str | None = None
    requested_scope: str | None = None
    granted_scope: str | None = None
    coverage_kind: str | None = None
    covered_by_existing_grant: bool = False
    request_id: str | None = None
    consent_token: str | None = None
    expires_at: int | None = None
    export_revision: int | None = None
    export_generated_at: str | None = None
    export_refresh_status: str | None = None
    poll_timeout_at: int | None = None
    approval_timeout_at: int | None = None
    approval_timeout_minutes: int | None = None
    expiry_hours: int | None = None
    is_scope_upgrade: bool | None = None
    existing_granted_scopes: list[str] | None = None
    additional_access_summary: str | None = None
    request_url: str | None = None
    requester_label: str | None = None
    requester_image_url: str | None = None
    reason: str | None = None
    app_id: str | None = None
    app_display_name: str | None = None
    message: str


class CoverageFields(TypedDict):
    requested_scope: str
    granted_scope: str | None
    coverage_kind: str | None
    covered_by_existing_grant: bool


class ExportFields(TypedDict):
    export_revision: int | None
    export_generated_at: str | None
    export_refresh_status: str | None


class DeveloperConsentRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    user_id: str
    scope: str
    reason: str | None = None
    expiry_hours: int = 24
    approval_timeout_minutes: int = 24 * 60
    connector_public_key: str = Field(min_length=16)
    connector_key_id: str = Field(min_length=1, max_length=128)
    connector_wrapping_alg: str = Field(min_length=1, max_length=128)


class DeveloperScopedExportRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    user_id: str
    consent_token: str = Field(min_length=16)
    expected_scope: str | None = None


class DeveloperScopedExportResponse(BaseModel):
    status: str
    user_id: str
    consent_token: str
    granted_scope: str | None = None
    expected_scope: str | None = None
    coverage_kind: str | None = None
    expires_at: int | None = None
    export_revision: int | None = None
    export_generated_at: str | None = None
    export_refresh_status: str | None = None
    encrypted_data: str | None = None
    iv: str | None = None
    tag: str | None = None
    wrapped_key_bundle: dict | None = None
    message: str


class DeveloperPortalTokenResponse(BaseModel):
    id: int
    app_id: str
    token_prefix: str
    label: str | None = None
    created_at: int
    revoked_at: int | None = None
    last_used_at: int | None = None


class DeveloperPortalAppResponse(BaseModel):
    app_id: str
    agent_id: str
    display_name: str
    contact_email: str
    support_url: str | None = None
    policy_url: str | None = None
    website_url: str | None = None
    brand_image_url: str | None = None
    status: str
    allowed_tool_groups: list[str]
    created_at: int
    updated_at: int


class DeveloperPortalAccessResponse(BaseModel):
    access_enabled: bool
    user_id: str
    owner_email: str | None = None
    owner_display_name: str | None = None
    owner_provider_ids: list[str] = Field(default_factory=list)
    app: DeveloperPortalAppResponse | None = None
    active_token: DeveloperPortalTokenResponse | None = None
    raw_token: str | None = None
    developer_token_env_var: str = "HUSHH_DEVELOPER_TOKEN"  # noqa: S105
    notes: list[str] = Field(
        default_factory=lambda: [
            "Use ?token=<developer-token> for /api/v1 and append ?token=<developer-token> to remote MCP URLs.",
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
            name="pkm.read",
            description="Read the full user personal knowledge model (all discovered domains).",
        ),
        DeveloperScopeDescriptor(
            name="pkm.write",
            description="Write to the user personal knowledge model in governed flows.",
        ),
        DeveloperScopeDescriptor(
            name="attr.{domain}.*",
            description="Read one discovered domain branch.",
            dynamic=True,
            requires_discovery=True,
        ),
        DeveloperScopeDescriptor(
            name="attr.{domain}.{subintent}.*",
            description="Read one discovered nested branch when metadata exposes subintents.",
            dynamic=True,
            requires_discovery=True,
        ),
        DeveloperScopeDescriptor(
            name="attr.{domain}.{path}",
            description="Read one specific discovered path.",
            dynamic=True,
            requires_discovery=True,
        ),
    ]


def _is_supported_scope(scope: str) -> bool:
    if scope in _STATIC_REQUESTABLE_SCOPES:
        return True
    return scope.startswith("attr.")


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
    scopes: list[str],
) -> tuple[list[str], list[str], list[dict]]:
    compact_entries: list[dict] = []
    seen_scopes: set[str] = set()
    discovered_domains = {
        str(domain).strip().lower() for domain in available_domains if str(domain).strip()
    }

    for entry in scope_entries:
        if not isinstance(entry, dict):
            continue
        scope = str(entry.get("scope") or "").strip()
        if not scope or scope in seen_scopes:
            continue

        source_kind = str(entry.get("source_kind") or "").strip()
        wildcard = entry.get("wildcard") is True
        domain = str(entry.get("domain") or "").strip().lower() or None
        if domain:
            discovered_domains.add(domain)

        # Default developer discovery should expose requestable top-level consent
        # surfaces only. Deep path-level manifest rows remain available via verbose
        # mode for debugging and inspection.
        if source_kind not in {"pkm_index", "pkm_manifests.top_level_scope_paths"}:
            continue
        if not wildcard:
            continue
        if entry.get("consumer_visible") is False or entry.get("internal_only") is True:
            continue

        compact_entries.append(entry)
        seen_scopes.add(scope)

    compact_scopes = sorted(
        {
            "pkm.read",
            *(
                str(entry.get("scope") or "").strip()
                for entry in compact_entries
                if str(entry.get("scope") or "").strip()
            ),
            *(str(scope).strip() for scope in scopes if str(scope).strip() == "pkm.read"),
        }
    )
    compact_domains = sorted(discovered_domains)
    return compact_domains, compact_scopes, compact_entries


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
        scope_kwargs["include_internal"] = detail == "verbose"
    if "include_exact_paths" in scope_signature.parameters:
        scope_kwargs["include_exact_paths"] = detail == "verbose"
    scopes = sorted(await get_available_scopes(user_id, **scope_kwargs))
    scope_entries_getter = getattr(pkm_service.scope_generator, "get_available_scope_entries", None)
    if callable(scope_entries_getter):
        scope_entries = await scope_entries_getter(user_id)
    else:
        scope_entries = [{"scope": scope} for scope in scopes if scope.startswith("attr.")]

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
        scopes=scopes,
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
            "consent_status": "/api/v1/consent-status",
            "scoped_export": "/api/v1/scoped-export",
        },
        "recommended_resources": [
            "hushh://info/connector",
            "hushh://info/developer-api",
        ],
        "recommended_mcp_flow": [
            "discover_user_domains",
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
    token: Optional[str] = Query(None),
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
    token: Optional[str] = Query(None),
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


@developer_api_router.get("/consent-status", response_model=DeveloperConsentStatusResponse)
async def get_consent_status(
    request: Request,
    user_id: str = Query(..., alias="user_id"),
    scope: str | None = Query(default=None),
    request_id: str | None = Query(default=None),
    token: Optional[str] = Query(None),
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
            return DeveloperConsentStatusResponse(
                status=resolved_status,
                user_id=user_id,
                scope=latest.get("scope"),
                requested_scope=str(latest.get("scope") or "") or normalized_scope or None,
                granted_scope=str(latest.get("scope") or "") or None,
                coverage_kind="exact" if latest.get("scope") else None,
                covered_by_existing_grant=False,
                request_id=request_id,
                consent_token=latest.get("token_id"),
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


@developer_api_router.post("/request-consent")
async def request_consent(
    payload: DeveloperConsentRequest,
    request: Request,
    token: Optional[str] = Query(None),
    authorization: Optional[str] = Header(None),
):
    principal = _resolve_principal(
        request=request,
        token=token,
        authorization=authorization,
    )

    normalized_scope = normalize_scope(payload.scope)
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

    # Keep default developer discovery compact, but validate requestable scopes
    # against the full resolver output so explicitly requested leaf paths found via
    # verbose/debug discovery remain valid.
    available_domains, discovered_scopes, _scope_entries = await _get_user_scope_snapshot(
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

    service = ConsentDBService()
    active, export_metadata, _invalidated_legacy = await _resolve_strict_covering_active_token(
        service=service,
        user_id=payload.user_id,
        agent_id=principal.agent_id,
        requested_scope=normalized_scope,
    )
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
            "request_url": _request_url_from_metadata(active.get("request_id"), active_metadata),
            "requester_label": _optional_str(active_metadata.get("requester_label")),
            "requester_image_url": _optional_str(active_metadata.get("requester_image_url")),
            "reason": _optional_str(active_metadata.get("reason")),
            "agent_id": principal.agent_id,
            "app_id": principal.app_id,
            "app_display_name": principal.display_name,
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
            "message": "Consent request already pending in the Hushh app.",
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
            "agent_id": principal.agent_id,
            "app_id": principal.app_id,
            "app_display_name": principal.display_name,
            "request_url": pending.get("requestUrl"),
            "requester_label": pending.get("requesterLabel"),
            "requester_image_url": pending.get("requesterImageUrl"),
            "reason": pending.get("reason") or pending_metadata.get("reason"),
            "approval_surface": "/profile?tab=privacy&sheet=consents",
            "is_scope_upgrade": bool(
                pending.get("isScopeUpgrade") or pending_metadata.get("is_scope_upgrade")
            ),
            "existing_granted_scopes": pending.get("existingGrantedScopes")
            or _normalize_scope_list(pending_metadata.get("existing_granted_scopes"))
            or None,
            "additional_access_summary": pending.get("additionalAccessSummary")
            or str(pending_metadata.get("additional_access_summary") or "").strip()
            or None,
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
        connector_public_key=payload.connector_public_key,
        connector_key_id=payload.connector_key_id,
        connector_wrapping_alg=payload.connector_wrapping_alg,
    )
    request_url = build_consent_request_url(request_id=request_id)
    metadata.update(
        {
            "expiry_hours": expiry_hours,
            "approval_timeout_minutes": approval_timeout_minutes,
            "approval_timeout_at": poll_timeout_at,
            "request_url": request_url,
            **scope_upgrade_fields,
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
        "message": "Consent request submitted. User approval is pending in the Hushh app.",
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
        "agent_id": principal.agent_id,
        "app_id": principal.app_id,
        "app_display_name": principal.display_name,
        "request_url": request_url,
        "requester_label": _optional_str(metadata.get("requester_label")),
        "requester_image_url": _optional_str(metadata.get("requester_image_url")),
        "reason": payload.reason,
        "approval_surface": "/profile?tab=privacy&sheet=consents",
        "is_scope_upgrade": scope_upgrade_fields["is_scope_upgrade"],
        "existing_granted_scopes": scope_upgrade_fields["existing_granted_scopes"],
        "additional_access_summary": scope_upgrade_fields["additional_access_summary"],
    }


@developer_api_router.post("/scoped-export", response_model=DeveloperScopedExportResponse)
async def get_scoped_export(
    payload: DeveloperScopedExportRequest,
    request: Request,
    token: Optional[str] = Query(None),
    authorization: Optional[str] = Header(None),
):
    principal = _resolve_principal(
        request=request,
        token=token,
        authorization=authorization,
    )
    expected_scope = normalize_scope(payload.expected_scope) if payload.expected_scope else None
    valid, reason, token_obj = await validate_token_with_db(
        payload.consent_token,
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

    if str(token_obj.user_id) != payload.user_id:
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
    export_data = await service.get_consent_export(payload.consent_token)
    if not export_data:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail={
                "error_code": "SCOPED_EXPORT_NOT_FOUND",
                "message": "No active encrypted export is available for this consent token.",
            },
        )

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
        encrypted_data=export_data.get("encrypted_data"),
        iv=export_data.get("iv"),
        tag=export_data.get("tag"),
        wrapped_key_bundle=export_data.get("wrapped_key_bundle"),
        message=(
            "Encrypted scoped export ready."
            if not expected_scope or expected_scope == granted_scope
            else "Encrypted export ready. The granted scope is broader than expected_scope, so narrow it client-side after decrypting."
        ),
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
