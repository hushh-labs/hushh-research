# api/routes/consent.py
"""
Consent management endpoints (pending, approve, deny, revoke, history, active).

NOTE: Uses dynamic attr.{domain}.* scopes instead of legacy vault wildcard scopes.
Legacy scopes are mapped to dynamic scopes for backward compatibility.

SECURITY: All consent management endpoints require VAULT_OWNER token authentication.
The consent page is vault-gated, so users must unlock their vault first.
This ensures consistent consent-first architecture throughout the system.
"""

import logging
import re
import time
from typing import Any, Dict

from fastapi import APIRouter, Depends, Header, HTTPException, Query, Request
from pydantic import BaseModel, ConfigDict, Field, ValidationError, model_validator
from sqlalchemy.exc import OperationalError as SqlalchemyOperationalError

from api.middleware import require_firebase_auth, require_vault_owner_token
from api.utils.firebase_auth import verify_firebase_bearer
from hushh_mcp.consent.scope_helpers import get_scope_description as get_dynamic_scope_description
from hushh_mcp.consent.scope_helpers import resolve_scope_to_enum
from hushh_mcp.consent.token import issue_token, revoke_token, validate_token_with_db
from hushh_mcp.constants import ConsentScope
from hushh_mcp.services.actor_identity_service import ActorIdentityService
from hushh_mcp.services.consent_center_service import ConsentCenterService
from hushh_mcp.services.consent_db import ConsentDBService
from hushh_mcp.services.ria_iam_service import (
    IAMSchemaNotReadyError,
    RIAIAMPolicyError,
    RIAIAMService,
)

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/consent", tags=["Consent Management"])

# NOTE: Export data is now persisted to database via ConsentDBService.store_consent_export()
# The in-memory dict is kept as a fast cache but database is the source of truth
_consent_exports: Dict[str, Dict] = {}

# Consent tokens are valid for 24 hours.  Keep cache entries for the token
# lifetime plus a one-hour grace period, then drop them.  Without this bound,
# tokens that expire naturally (without explicit revocation) leave stale blobs
# in the process heap indefinitely.
_CONSENT_EXPORT_TTL_MS: int = 25 * 60 * 60 * 1000  # 24 h token lifetime + 1 h grace


def _evict_stale_consent_exports() -> int:
    """Remove entries whose token has certainly expired (created_at older than TTL).

    Caller does NOT need to hold any lock — dict mutation in CPython is protected
    by the GIL for single operations, and this sweep is only triggered from
    request-handling coroutines (one event-loop thread).

    Returns the number of entries evicted.
    """
    now_ms = int(time.time() * 1000)
    stale = [
        k
        for k, v in _consent_exports.items()
        if now_ms - int(v.get("created_at") or 0) >= _CONSENT_EXPORT_TTL_MS
    ]
    for k in stale:
        del _consent_exports[k]
    if stale:
        logger.debug(
            "consent_exports.ttl_eviction evicted=%s remaining=%s",
            len(stale),
            len(_consent_exports),
        )
    return len(stale)


_UUID_LIKE_PATTERN = re.compile(
    r"^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$",
    re.IGNORECASE,
)
_CONSENT_STORAGE_ERROR_PATTERNS = (
    "connection refused",
    "server closed the connection unexpectedly",
    "db operation failed",
    "timed out",
    "timeout",
)
_CONNECTOR_WRAPPING_ALG = "X25519-AES256-GCM"


async def _owned_consent_identifiers(user_id: str) -> list[str]:
    try:
        identifiers = await ActorIdentityService().list_account_identifiers(user_id)
    except Exception as exc:
        logger.debug(
            "consent.identifier_expansion_skipped user_id=%s error=%s",
            user_id,
            exc,
        )
        identifiers = []
    return identifiers or [user_id]


def _identifier_filter_kwargs(user_id: str, identifiers: list[str]) -> dict[str, list[str]]:
    normalized_user_id = str(user_id or "").strip()
    normalized_identifiers = [
        str(item or "").strip() for item in identifiers if str(item or "").strip()
    ]
    if set(normalized_identifiers) <= {normalized_user_id}:
        return {}
    return {"user_ids": normalized_identifiers}


def _clean_text(value: object | None) -> str:
    return str(value or "").strip()


def _require_non_empty_text(value: object | None, field_name: str) -> str:
    cleaned = _clean_text(value)
    if not cleaned:
        raise HTTPException(status_code=400, detail=f"{field_name} is required.")
    return cleaned


def _expected_connector_key_id(metadata: dict | None) -> str:
    return _clean_text((metadata or {}).get("connector_key_id"))


def _expected_connector_wrapping_alg(metadata: dict | None) -> str:
    return _clean_text((metadata or {}).get("connector_wrapping_alg")) or _CONNECTOR_WRAPPING_ALG


def _build_verified_wrapped_key_bundle(
    *,
    metadata: dict | None,
    wrapped_export_key: str | None,
    wrapped_key_iv: str | None,
    wrapped_key_tag: str | None,
    sender_public_key: str | None,
    wrapping_alg: str | None,
    connector_key_id: str | None,
) -> dict:
    wrapped_export_key = _require_non_empty_text(wrapped_export_key, "wrappedExportKey")
    wrapped_key_iv = _require_non_empty_text(wrapped_key_iv, "wrappedKeyIv")
    wrapped_key_tag = _require_non_empty_text(wrapped_key_tag, "wrappedKeyTag")
    sender_public_key = _require_non_empty_text(sender_public_key, "senderPublicKey")
    expected_key_id = _expected_connector_key_id(metadata)
    provided_key_id = _clean_text(connector_key_id)
    if expected_key_id and not provided_key_id:
        raise HTTPException(status_code=400, detail="Connector key id is required.")
    if expected_key_id and provided_key_id != expected_key_id:
        raise HTTPException(status_code=400, detail="Connector key id does not match request.")
    normalized_alg = _clean_text(wrapping_alg) or _expected_connector_wrapping_alg(metadata)
    expected_alg = _expected_connector_wrapping_alg(metadata)
    if normalized_alg != expected_alg or normalized_alg != _CONNECTOR_WRAPPING_ALG:
        raise HTTPException(
            status_code=400,
            detail="Connector wrapping algorithm does not match request.",
        )
    return {
        "wrapped_export_key": wrapped_export_key,
        "wrapped_key_iv": wrapped_key_iv,
        "wrapped_key_tag": wrapped_key_tag,
        "sender_public_key": sender_public_key,
        "wrapping_alg": normalized_alg,
        "connector_key_id": provided_key_id or expected_key_id or None,
    }


def _require_encrypted_export_payload(
    *,
    encrypted_data: object | None,
    encrypted_iv: object | None,
    encrypted_tag: object | None,
) -> tuple[str, str, str]:
    return (
        _require_non_empty_text(encrypted_data, "encryptedData"),
        _require_non_empty_text(encrypted_iv, "encryptedIv"),
        _require_non_empty_text(encrypted_tag, "encryptedTag"),
    )


def _is_consent_storage_unavailable(exc: Exception) -> bool:
    current: BaseException | None = exc
    seen: set[int] = set()
    while current is not None and id(current) not in seen:
        seen.add(id(current))
        if current.__class__.__name__ == "DatabaseExecutionError":
            return True
        if isinstance(current, SqlalchemyOperationalError):
            return True
        if isinstance(current, (ConnectionError, OSError, TimeoutError)):
            return True
        message = str(current).strip().lower()
        if message and any(pattern in message for pattern in _CONSENT_STORAGE_ERROR_PATTERNS):
            return True
        current = current.__cause__ or current.__context__
    return False


def get_scope_description(scope: str) -> str:
    """
    Human-readable scope descriptions.

    Delegated to centralized dynamic scope resolution.
    """
    return get_dynamic_scope_description(scope)


def _looks_technical_requester_label(
    value: object | None, *, counterpart_id: str | None = None
) -> bool:
    normalized = str(value or "").strip()
    if not normalized:
        return True
    if counterpart_id and normalized == counterpart_id:
        return True
    if normalized.lower().startswith("ria:"):
        return True
    if _UUID_LIKE_PATTERN.match(normalized):
        return True
    return False


async def _hydrate_pending_requester_labels(pending_items: list[dict]) -> list[dict]:
    if not pending_items:
        return pending_items

    identity_ids: list[str] = []
    pending_identity_map: list[str | None] = []
    for item in pending_items:
        metadata = item.get("metadata")
        metadata = metadata if isinstance(metadata, dict) else {}
        agent_id = str(item.get("agent_id") or item.get("developer") or "").strip()
        counterpart_id = str(metadata.get("requester_entity_id") or "").strip() or None
        requester_actor_type = str(metadata.get("requester_actor_type") or "").strip().lower()
        identity_id: str | None = None
        if requester_actor_type == "ria" or agent_id.lower().startswith("ria:"):
            identity_id = counterpart_id
            if not identity_id and agent_id.lower().startswith("ria:"):
                identity_id = agent_id.split(":", 1)[1].strip() or None
        pending_identity_map.append(identity_id)
        if identity_id:
            identity_ids.append(identity_id)

    identities = await ActorIdentityService().ensure_many(identity_ids)

    for item, identity_id in zip(pending_items, pending_identity_map, strict=False):
        if not identity_id:
            continue
        identity = identities.get(identity_id) or {}
        display_name = str(identity.get("display_name") or "").strip()
        photo_url = str(identity.get("photo_url") or "").strip()
        current_label = str(item.get("requesterLabel") or "").strip()
        if display_name and _looks_technical_requester_label(
            current_label, counterpart_id=identity_id
        ):
            item["requesterLabel"] = display_name
        if photo_url and not str(item.get("requesterImageUrl") or "").strip():
            item["requesterImageUrl"] = photo_url
    return pending_items


# ============================================================================
# PENDING CONSENT MANAGEMENT
# ============================================================================


class CancelConsentRequest(BaseModel):
    userId: str = Field(min_length=1, max_length=128)
    requestId: str = Field(min_length=1, max_length=128)


class PendingConsentOpenedRequest(BaseModel):
    userId: str = Field(min_length=1, max_length=128)
    requestId: str | None = Field(default=None, max_length=128)
    bundleId: str | None = Field(default=None, max_length=128)
    openedVia: str | None = Field(default=None, max_length=64)


class GenericConsentRequestCreate(BaseModel):
    subject_user_id: str = Field(min_length=1, max_length=128)
    requester_actor_type: str = Field(default="ria", max_length=64)
    subject_actor_type: str = Field(default="investor", max_length=64)
    scope_template_id: str = Field(min_length=1, max_length=256)
    selected_scope: str | None = Field(default=None, max_length=256)
    duration_mode: str = Field(default="preset", max_length=64)
    duration_hours: int | None = Field(default=None, ge=1, le=8760)
    firm_id: str | None = Field(default=None, max_length=128)
    reason: str | None = Field(default=None, max_length=1000)


class RelationshipDisconnectRequest(BaseModel):
    investor_user_id: str | None = Field(default=None, max_length=128)
    ria_profile_id: str | None = Field(default=None, max_length=128)


class RefreshExportUploadRequest(BaseModel):
    userId: str = Field(min_length=1, max_length=128)
    consentToken: str = Field(min_length=1, max_length=2048)
    encryptedData: str = Field(min_length=1)
    encryptedIv: str = Field(min_length=1, max_length=256)
    encryptedTag: str = Field(min_length=1, max_length=256)
    wrappedExportKey: str = Field(min_length=1, max_length=8192)
    wrappedKeyIv: str = Field(min_length=1, max_length=256)
    wrappedKeyTag: str = Field(min_length=1, max_length=256)
    senderPublicKey: str = Field(min_length=1, max_length=8192)
    wrappingAlg: str | None = Field(default=None, max_length=64)
    connectorKeyId: str | None = Field(default=None, max_length=128)
    sourceContentRevision: int | None = Field(default=None, ge=1)
    sourceManifestRevision: int | None = Field(default=None, ge=1)


class RefreshExportFailureRequest(BaseModel):
    userId: str = Field(min_length=1, max_length=128)
    consentToken: str = Field(min_length=1, max_length=2048)
    lastError: str | None = Field(default=None, max_length=2000)


@router.get("/pending")
async def get_pending_consents(
    userId: str = Query(..., max_length=128),
    token_data: dict = Depends(require_vault_owner_token),
):
    """
    Get all pending consent requests for a user.

    SECURITY: Requires VAULT_OWNER token. User can only view their own pending requests.
    """
    # Verify user is requesting their own data
    if token_data["user_id"] != userId:
        raise HTTPException(status_code=403, detail="User ID does not match authenticated user")

    service = ConsentDBService()
    try:
        owned_identifiers = await _owned_consent_identifiers(userId)
        pending_from_db = await service.get_pending_requests(
            userId,
            **_identifier_filter_kwargs(userId, owned_identifiers),
        )
        pending_from_db = await _hydrate_pending_requester_labels(pending_from_db)
        logger.info("consent.pending_fetched count=%s", len(pending_from_db))
        return {"pending": pending_from_db}
    except Exception as exc:
        if _is_consent_storage_unavailable(exc):
            logger.warning(
                "consent.pending_degraded user_id=%s reason=%s",
                userId,
                exc,
            )
            return {"pending": [], "degraded": True}
        raise


@router.get("/pending/lookup")
async def lookup_pending_consents(
    userId: str = Query(..., max_length=128),
    request_id: list[str] | None = Query(default=None),
    token_data: dict = Depends(require_vault_owner_token),
):
    """
    Resolve specific pending consent requests by canonical request id.

    This is intentionally uncached and request-id scoped so product surfaces that
    hold cross-links to consent requests do not reconstruct consent payloads from
    feature-local workflow state.
    """
    if token_data["user_id"] != userId:
        raise HTTPException(status_code=403, detail="User ID does not match authenticated user")

    request_ids = []
    seen: set[str] = set()
    for value in request_id or []:
        normalized = _clean_text(value)
        if not normalized or normalized in seen:
            continue
        if len(normalized) > 128:
            raise HTTPException(status_code=400, detail="request_id is too long.")
        seen.add(normalized)
        request_ids.append(normalized)

    if not request_ids:
        raise HTTPException(status_code=400, detail="At least one request_id is required.")
    if len(request_ids) > 25:
        raise HTTPException(status_code=400, detail="At most 25 request ids can be looked up.")

    service = ConsentDBService()
    items = []
    missing_request_ids = []
    for request_id_value in request_ids:
        pending = await service.get_pending_by_request_id(userId, request_id_value)
        if pending:
            items.append(pending)
        else:
            missing_request_ids.append(request_id_value)

    logger.info(
        "consent.pending_lookup user_id=%s requested=%s found=%s missing=%s",
        userId,
        len(request_ids),
        len(items),
        len(missing_request_ids),
    )
    return {"items": items, "missing_request_ids": missing_request_ids}


@router.post("/pending/opened")
async def mark_pending_consent_opened(
    body: PendingConsentOpenedRequest,
    token_data: dict = Depends(require_vault_owner_token),
):
    if token_data["user_id"] != body.userId:
        raise HTTPException(status_code=403, detail="User ID does not match authenticated user")

    service = ConsentDBService()
    owned_identifiers = await _owned_consent_identifiers(body.userId)
    opened = await service.mark_pending_request_opened(
        user_id=body.userId,
        request_id=body.requestId,
        bundle_id=body.bundleId,
        opened_via=body.openedVia,
        **_identifier_filter_kwargs(body.userId, owned_identifiers),
    )
    if opened is None:
        return {"ok": True, "acknowledged": False}
    return {"ok": True, "acknowledged": True, **opened}


class ConsentApprovalPayload(BaseModel):
    """Versioned, field-validated consent-approval request body.

    Field constraints and the agent_id/X-Client-Id identity check ensure
    callers supply well-formed, consistent data before any DB or token
    logic runs.  FastAPI returns 422 on field violations; the handler
    returns 403 on identity mismatch.

    agent_id
        Optional identifier the calling agent declares about itself.
        When present AND the ``X-Client-Id`` header is also present, the
        two values MUST match — a mismatch returns HTTP 403
        ``AGENT_ID_CLIENT_ID_MISMATCH`` before any further processing.

    Canonical surface: api.routes.consent — no separate validation service.
    Integrated by Abdul Gaffar — canonical field-level validation logic.
    """

    # Reject unknown fields with HTTP 422 rather than silently storing them.
    # extra="allow" let callers inject arbitrary keys into __pydantic_extra__,
    # which propagated to downstream DB writes and log entries (CWE-915 / DoS).
    model_config = ConfigDict(extra="forbid")

    version: int = Field(default=1, ge=1, le=2)

    userId: str = Field(..., min_length=1, max_length=128, pattern=r"^\S+$")
    requestId: str = Field(..., min_length=1, max_length=128, pattern=r"^\S+$")

    agent_id: str | None = Field(
        default=None,
        min_length=1,
        max_length=256,
        pattern=r"^\S+$",
        description=(
            "Agent identifier declared by the caller. "
            "Must equal the X-Client-Id header when both are present."
        ),
    )

    encryptedData: str | None = Field(default=None, max_length=10_000_000)
    encryptedIv: str | None = Field(default=None, max_length=512)
    encryptedTag: str | None = Field(default=None, max_length=512)
    wrappedExportKey: str | None = Field(default=None, max_length=10_000_000)
    wrappedKeyIv: str | None = Field(default=None, max_length=512)
    wrappedKeyTag: str | None = Field(default=None, max_length=512)
    senderPublicKey: str | None = Field(default=None, max_length=4096)
    connectorPublicKey: str | None = Field(default=None, max_length=8192)
    wrappingAlg: str | None = Field(default=None, max_length=64)
    connectorKeyId: str | None = Field(default=None, max_length=256)
    durationHours: int | None = Field(default=None, ge=1, le=8760)
    sourceContentRevision: int | None = Field(default=None, ge=0)
    sourceManifestRevision: int | None = Field(default=None, ge=0)

    @model_validator(mode="before")
    @classmethod
    def _stamp_missing_version(cls, values: Any) -> Any:
        if isinstance(values, dict) and "version" not in values:
            values = {**values, "version": 1}
        return values


@router.post("/pending/approve")
async def approve_consent(
    request: Request,
    token_data: dict = Depends(require_vault_owner_token),
    x_client_id: str | None = Header(None, alias="X-Client-Id"),
):
    """
    User approves a pending consent request (Zero-Knowledge).

    SECURITY: Requires VAULT_OWNER token. User can only approve their own consent requests.

    Browser sends encrypted export data (server never sees plaintext).
    For connector-backed approvals, the export key is wrapped to the connector public key
    and the backend never persists a plaintext decrypt key.
    """
    try:
        _body = ConsentApprovalPayload.model_validate(await request.json())
    except ValidationError as exc:
        raise HTTPException(status_code=422, detail=exc.errors(include_url=False))

    # Granular field-level validation: agent_id in payload must match
    # X-Client-Id header when both are supplied.  A mismatch indicates the
    # caller is misrepresenting its identity and is rejected before any
    # further auth or DB logic runs.
    # Integrated by Abdul Gaffar — canonical field-level validation logic.
    if _body.agent_id is not None and x_client_id is not None:
        if _body.agent_id != x_client_id:
            logger.warning(
                "consent.approve.agent_id_mismatch payload=%s header=%s",
                _body.agent_id,
                x_client_id,
            )
            raise HTTPException(
                status_code=403,
                detail={
                    "error_code": "AGENT_ID_CLIENT_ID_MISMATCH",
                    "message": (
                        "agent_id in payload does not match X-Client-Id header. "
                        "Ensure both values identify the same agent."
                    ),
                },
            )

    userId = _body.userId
    requestId = _body.requestId
    encryptedData = _body.encryptedData  # Base64 ciphertext
    encryptedIv = _body.encryptedIv  # Base64 IV
    encryptedTag = _body.encryptedTag  # Base64 auth tag
    wrappedExportKey = _body.wrappedExportKey
    wrappedKeyIv = _body.wrappedKeyIv
    wrappedKeyTag = _body.wrappedKeyTag
    senderPublicKey = _body.senderPublicKey
    wrappingAlg = _body.wrappingAlg
    connectorKeyId = _body.connectorKeyId
    requested_duration_hours = _body.durationHours
    source_content_revision = _body.sourceContentRevision
    source_manifest_revision = _body.sourceManifestRevision

    # Verify user is approving their own consent
    if token_data["user_id"] != userId:
        raise HTTPException(status_code=403, detail="User ID does not match authenticated user")

    logger.info("consent.approve_requested")
    logger.info("consent.approve_export_attached=%s", bool(encryptedData))

    # Get pending request from database
    service = ConsentDBService()
    owned_identifiers = await _owned_consent_identifiers(userId)
    pending_request = await service.get_pending_by_request_id(
        userId,
        requestId,
        **_identifier_filter_kwargs(userId, owned_identifiers),
    )

    if not pending_request:
        raise HTTPException(status_code=404, detail="Consent request not found")
    subject_user_id = str(pending_request.get("user_id") or userId).strip() or userId

    # Issue consent token - map scope to ConsentScope enum using centralized resolver
    requested_scope = pending_request["scope"]
    try:
        _consent_scope = resolve_scope_to_enum(requested_scope)
    except Exception as e:
        logger.error("consent.scope_resolution_failed: %s", e)
        raise HTTPException(status_code=400, detail=f"Invalid scope: {requested_scope}")

    # Optional metadata on pending request (used for expiry hints)
    metadata = pending_request.get("metadata", {})
    developer_label = (
        metadata.get("developer_app_display_name") if isinstance(metadata, dict) else None
    ) or pending_request["developer"]
    connector_public_key = (
        metadata.get("connector_public_key") if isinstance(metadata, dict) else None
    )
    is_developer_request = bool(
        connector_public_key
        or (
            isinstance(metadata, dict)
            and (
                metadata.get("request_source") == "developer_api_v1"
                or metadata.get("requester_actor_type") == "developer"
            )
        )
    )
    expiry_hours = metadata.get("expiry_hours", 24)
    if isinstance(requested_duration_hours, int) and requested_duration_hours > 0:
        expiry_hours = min(requested_duration_hours, 24 * 365)

    # MODULAR COMPLIANCE CHECK: Idempotency
    # Before issuing a NEW token, check if a valid token for this scope/agent already exists.
    # This prevents duplication and ensures a clean audit log.

    service = ConsentDBService()
    existing_token = await service.find_covering_active_token(
        userId,
        agent_id=pending_request["developer"],
        requested_scope=requested_scope,
        **_identifier_filter_kwargs(userId, owned_identifiers),
    )
    if existing_token and is_developer_request:
        existing_export = await service.get_consent_export_metadata(
            str(existing_token.get("token_id") or "")
        )
        if not (
            isinstance(existing_export, dict) and existing_export.get("is_strict_zero_knowledge")
        ):
            logger.warning(
                "consent.token_reuse_skipped_missing_strict_export scope=%s token=%s",
                requested_scope,
                str(existing_token.get("token_id") or "")[:32],
            )
            existing_token = None
        elif existing_token.get("scope") != requested_scope:
            logger.info(
                "consent.token_reuse_skipped_developer_superset requested_scope=%s token_scope=%s",
                requested_scope,
                existing_token.get("scope"),
            )
            existing_token = None
        elif existing_export.get("refresh_status") != "current":
            logger.info(
                "consent.token_reuse_skipped_stale_export scope=%s token=%s",
                requested_scope,
                str(existing_token.get("token_id") or "")[:32],
            )
            existing_token = None
        elif requested_scope.startswith("attr.") and not isinstance(
            existing_export.get("source_content_revision"), int
        ):
            logger.info(
                "consent.token_reuse_skipped_missing_source_revision scope=%s token=%s",
                requested_scope,
                str(existing_token.get("token_id") or "")[:32],
            )
            existing_token = None
        elif _expected_connector_key_id(metadata) and existing_export.get(
            "connector_key_id"
        ) != _expected_connector_key_id(metadata):
            logger.warning(
                "consent.token_reuse_skipped_connector_key_mismatch scope=%s token=%s",
                requested_scope,
                str(existing_token.get("token_id") or "")[:32],
            )
            existing_token = None
        elif existing_export.get("connector_wrapping_alg") != _expected_connector_wrapping_alg(
            metadata
        ):
            logger.warning(
                "consent.token_reuse_skipped_connector_wrapping_mismatch scope=%s token=%s",
                requested_scope,
                str(existing_token.get("token_id") or "")[:32],
            )
            existing_token = None

    if existing_token:
        # IDEMPOTENT RETURN: Reuse existing token
        logger.info("consent.token_reused scope=%s", requested_scope)

        reuse_metadata = dict(metadata) if isinstance(metadata, dict) else {}
        reuse_metadata["reused_consent_token"] = True
        if subject_user_id != userId:
            await service.insert_event(
                user_id=subject_user_id,
                agent_id=pending_request["developer"],
                scope=requested_scope,
                action="CONSENT_GRANTED",
                token_id=existing_token.get("token_id"),
                request_id=requestId,
                scope_description=get_scope_description(requested_scope),
                expires_at=existing_token.get("expires_at"),
                metadata=reuse_metadata,
            )
        await service.insert_event(
            user_id=userId,
            agent_id=pending_request["developer"],
            scope=requested_scope,
            action="CONSENT_GRANTED",
            token_id=existing_token.get("token_id"),
            request_id=requestId,
            scope_description=get_scope_description(requested_scope),
            expires_at=existing_token.get("expires_at"),
            metadata=reuse_metadata,
        )
        try:
            await RIAIAMService().sync_relationship_from_consent_action(
                user_id=userId,
                request_id=requestId,
                action="CONSENT_GRANTED",
            )
        except Exception:
            logger.exception(
                "ria.relationship_sync_failed action=CONSENT_GRANTED reused_token=true"
            )

        return {
            "status": "approved",
            "message": f"Consent granted to {developer_label} (Existing)",
            "consent_token": existing_token.get("token_id"),
            "expires_at": existing_token.get("expires_at"),
            "bundle_id": metadata.get("bundle_id"),
            "granted_scope": existing_token.get("scope"),
            "coverage_kind": "exact"
            if existing_token.get("scope") == requested_scope
            else "superset",
        }

    # CRITICAL FIX: Pass original scope STRING to issue_token, not enum
    # This ensures token contains 'attr.financial.*' not 'pkm.read'
    # The enum was validated above, but the token must preserve the exact scope
    token = issue_token(
        user_id=userId,
        # Keep token agent_id aligned with consent_audit agent_id so DB revocation
        # checks are deterministic across instances.
        agent_id=pending_request["developer"],
        scope=requested_scope,  # ✅ Pass string, not enum
        expires_in_ms=expiry_hours * 60 * 60 * 1000,
    )

    # Store encrypted export linked to token
    # Persist to database for cross-instance consistency
    wrapped_key_bundle = None
    if connector_public_key:
        wrapped_key_bundle = _build_verified_wrapped_key_bundle(
            metadata=metadata,
            wrapped_export_key=wrappedExportKey,
            wrapped_key_iv=wrappedKeyIv,
            wrapped_key_tag=wrappedKeyTag,
            sender_public_key=senderPublicKey,
            wrapping_alg=wrappingAlg,
            connector_key_id=connectorKeyId,
        )
    elif is_developer_request and encryptedData:
        raise HTTPException(
            status_code=400,
            detail="Developer consent approvals must include a connector-backed wrapped export key bundle.",
        )

    if is_developer_request and not encryptedData:
        raise HTTPException(
            status_code=400,
            detail="Developer consent approvals must include an encrypted export payload.",
        )

    encrypted_export_payload = None
    if is_developer_request:
        encrypted_export_payload = _require_encrypted_export_payload(
            encrypted_data=encryptedData,
            encrypted_iv=encryptedIv,
            encrypted_tag=encryptedTag,
        )

    if encryptedData and wrapped_key_bundle:
        payload_data, payload_iv, payload_tag = encrypted_export_payload or (
            _clean_text(encryptedData),
            _clean_text(encryptedIv),
            _clean_text(encryptedTag),
        )
        # Store in database (source of truth)
        stored = await service.store_consent_export(
            consent_token=token.token,
            user_id=userId,
            encrypted_data=payload_data,
            iv=payload_iv,
            tag=payload_tag,
            export_key=None,
            wrapped_key_bundle=wrapped_key_bundle,
            scope=pending_request["scope"],
            expires_at_ms=token.expires_at,
            source_content_revision=source_content_revision
            if isinstance(source_content_revision, int)
            else None,
            source_manifest_revision=source_manifest_revision
            if isinstance(source_manifest_revision, int)
            else None,
            refresh_status="current",
        )
        if not stored:
            raise HTTPException(status_code=500, detail="Failed to store encrypted consent export")

        # Also cache in memory for fast access; sweep stale entries first.
        _evict_stale_consent_exports()
        _consent_exports[token.token] = {
            "encrypted_data": payload_data,
            "iv": payload_iv,
            "tag": payload_tag,
            "wrapped_key_bundle": wrapped_key_bundle,
            "connector_key_id": wrapped_key_bundle.get("connector_key_id"),
            "connector_wrapping_alg": wrapped_key_bundle.get("wrapping_alg"),
            "scope": pending_request["scope"],
            "export_revision": 1,
            "export_generated_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
            "refresh_status": "current",
            "is_strict_zero_knowledge": True,
            "created_at": int(time.time() * 1000),
        }
        logger.info("   Stored encrypted export for token (DB + cache)")

    granted_event_metadata = dict(metadata) if isinstance(metadata, dict) else {}

    # Log CONSENT_GRANTED with the normalized requested scope string.
    if subject_user_id != userId:
        await service.insert_event(
            user_id=subject_user_id,
            agent_id=pending_request["developer"],
            scope=requested_scope,
            action="CONSENT_GRANTED",
            token_id=token.token,
            request_id=requestId,
            expires_at=token.expires_at,
            metadata=granted_event_metadata,
        )
    await service.insert_event(
        user_id=userId,
        agent_id=pending_request["developer"],
        scope=requested_scope,
        action="CONSENT_GRANTED",
        token_id=token.token,
        request_id=requestId,
        expires_at=token.expires_at,
        metadata=granted_event_metadata,
    )
    logger.info("consent.granted_event_saved")

    superseded_scopes: list[str] = []
    superseded_tokens = await service.get_superseded_active_tokens(
        userId,
        agent_id=pending_request["developer"],
        requested_scope=requested_scope,
        **_identifier_filter_kwargs(userId, owned_identifiers),
    )
    for index, superseded_token in enumerate(superseded_tokens):
        superseded_scope = str(superseded_token.get("scope") or "").strip()
        superseded_token_id = str(superseded_token.get("token_id") or "").strip()
        if not superseded_scope or not superseded_token_id:
            continue

        revoke_token(superseded_token_id)
        await service.delete_consent_export(superseded_token_id)
        _consent_exports.pop(superseded_token_id, None)

        superseded_metadata = {
            "superseded_by_broader_scope": True,
            "superseded_by_request_id": requestId,
            "superseded_by_scope": requested_scope,
            "superseded_by_token_id": token.token,
        }
        await service.insert_event(
            user_id=str(superseded_token.get("user_id") or subject_user_id),
            agent_id=pending_request["developer"],
            scope=superseded_scope,
            action="REVOKED",
            token_id=f"REVOKED_SUPERSEDED_{int(time.time() * 1000)}_{index}",
            request_id=superseded_token.get("request_id"),
            metadata=superseded_metadata,
        )
        superseded_scopes.append(superseded_scope)

    if superseded_scopes:
        logger.info(
            "consent.superseded_narrower_tokens scope=%s superseded_scopes=%s",
            requested_scope,
            superseded_scopes,
        )
    try:
        await RIAIAMService().sync_relationship_from_consent_action(
            user_id=userId,
            request_id=requestId,
            action="CONSENT_GRANTED",
        )
    except Exception:
        logger.exception("ria.relationship_sync_failed action=CONSENT_GRANTED")

    return {
        "status": "approved",
        "message": f"Consent granted to {developer_label}",
        "consent_token": token.token,
        "expires_at": token.expires_at,
        "bundle_id": metadata.get("bundle_id"),
        "granted_scope": requested_scope,
        "coverage_kind": "exact",
        "superseded_scopes": superseded_scopes,
    }


@router.post("/pending/deny")
async def deny_consent(
    requestId: str,
    userId: str = Query(..., max_length=128),
    token_data: dict = Depends(require_vault_owner_token),
):
    """
    User denies a pending consent request.

    SECURITY: Requires VAULT_OWNER token. User can only deny their own consent requests.
    """
    # Verify user is denying their own consent
    if token_data["user_id"] != userId:
        raise HTTPException(status_code=403, detail="User ID does not match authenticated user")

    logger.info("consent.deny_requested")

    # Get pending request from database
    service = ConsentDBService()
    owned_identifiers = await _owned_consent_identifiers(userId)
    pending_request = await service.get_pending_by_request_id(
        userId,
        requestId,
        **_identifier_filter_kwargs(userId, owned_identifiers),
    )

    if not pending_request:
        raise HTTPException(status_code=404, detail="Consent request not found")
    subject_user_id = str(pending_request.get("user_id") or userId).strip() or userId

    metadata = pending_request.get("metadata", {})
    developer_label = (
        metadata.get("developer_app_display_name") if isinstance(metadata, dict) else None
    ) or pending_request["developer"]

    # Log CONSENT_DENIED to database
    await service.insert_event(
        user_id=subject_user_id,
        agent_id=pending_request["developer"],
        scope=pending_request["scope"],
        action="CONSENT_DENIED",
        request_id=requestId,
    )
    logger.info("consent.denied_event_saved")
    try:
        await RIAIAMService().sync_relationship_from_consent_action(
            user_id=userId,
            request_id=requestId,
            action="CONSENT_DENIED",
        )
    except Exception:
        logger.exception("ria.relationship_sync_failed action=CONSENT_DENIED")

    return {"status": "denied", "message": f"Consent denied to {developer_label}"}


@router.post("/cancel")
async def cancel_consent(
    payload: CancelConsentRequest,
    token_data: dict = Depends(require_vault_owner_token),
):
    """
    Cancel a pending consent request.

    SECURITY: Requires VAULT_OWNER token. User can only cancel their own consent requests.

    Implementation: insert a terminal audit action so the request no longer
    appears as pending (pending = latest action == REQUESTED).
    """
    # Verify user is cancelling their own consent
    if token_data["user_id"] != payload.userId:
        raise HTTPException(status_code=403, detail="User ID does not match authenticated user")

    logger.info("consent.cancel_requested")

    service = ConsentDBService()
    owned_identifiers = await _owned_consent_identifiers(payload.userId)
    pending_request = await service.get_pending_by_request_id(
        payload.userId,
        payload.requestId,
        **_identifier_filter_kwargs(payload.userId, owned_identifiers),
    )
    if not pending_request:
        raise HTTPException(status_code=404, detail="Consent request not found")
    subject_user_id = (
        str(pending_request.get("user_id") or payload.userId).strip() or payload.userId
    )

    await service.insert_event(
        user_id=subject_user_id,
        agent_id=pending_request["developer"],
        scope=pending_request["scope"],
        action="CANCELLED",
        request_id=payload.requestId,
        scope_description=pending_request.get("scope_description"),
    )
    try:
        await RIAIAMService().sync_relationship_from_consent_action(
            user_id=payload.userId,
            request_id=payload.requestId,
            action="CANCELLED",
        )
    except Exception:
        logger.exception("ria.relationship_sync_failed action=CANCELLED")

    return {"status": "cancelled", "requestId": payload.requestId}


@router.get("/center")
async def get_consent_center(firebase_uid: str = Depends(require_firebase_auth)):
    service = ConsentCenterService()
    return await service.get_center(firebase_uid)


@router.get("/center/summary")
async def get_consent_center_summary(
    actor: str = Query(default="investor"),
    mode: str = Query(default="consents"),
    firebase_uid: str = Depends(require_firebase_auth),
):
    service = ConsentCenterService()
    return await service.get_center_summary(firebase_uid, actor=actor, mode=mode)


@router.get("/center/list")
async def get_consent_center_list(
    actor: str = Query(default="investor"),
    surface: str = Query(default="pending"),
    mode: str = Query(default="consents"),
    q: str | None = Query(default=None),
    top: int | None = Query(default=None, ge=1, le=10),
    page: int = Query(default=1, ge=1),
    limit: int = Query(default=20, ge=1, le=100),
    firebase_uid: str = Depends(require_firebase_auth),
):
    service = ConsentCenterService()
    return await service.list_center(
        firebase_uid,
        actor=actor,
        surface=surface,
        mode=mode,
        query=q,
        top=top,
        page=page,
        limit=limit,
    )


@router.get("/requests/outgoing")
async def get_outgoing_requests(firebase_uid: str = Depends(require_firebase_auth)):
    service = ConsentCenterService()
    return {"items": await service.list_outgoing_requests(firebase_uid)}


@router.post("/requests")
async def create_generic_consent_request(
    payload: GenericConsentRequestCreate,
    firebase_uid: str = Depends(require_firebase_auth),
):
    # If the requester is an RIA, enforce verification before allowing
    # consent requests to investors (mirrors the gate on POST /api/ria/requests).
    if payload.requester_actor_type == "ria":
        service = RIAIAMService()
        try:
            await service.require_ria_verified(firebase_uid)
        except IAMSchemaNotReadyError as exc:
            raise HTTPException(status_code=503, detail="Verification service unavailable") from exc
        except RIAIAMPolicyError as exc:
            raise HTTPException(status_code=exc.status_code, detail=str(exc)) from exc

    try:
        return await RIAIAMService().create_ria_consent_request(
            firebase_uid,
            subject_user_id=payload.subject_user_id,
            requester_actor_type=payload.requester_actor_type,
            subject_actor_type=payload.subject_actor_type,
            scope_template_id=payload.scope_template_id,
            selected_scope=payload.selected_scope,
            duration_mode=payload.duration_mode,
            duration_hours=payload.duration_hours,
            firm_id=payload.firm_id,
            reason=payload.reason,
        )
    except RIAIAMPolicyError as exc:
        raise HTTPException(status_code=exc.status_code, detail=str(exc)) from exc


@router.get("/handshake/history")
async def get_handshake_history(
    counterpart_id: str = Query(..., min_length=1, max_length=128),
    actor: str = Query(default="investor"),
    page: int = Query(default=1, ge=1),
    limit: int = Query(default=50, ge=1, le=200),
    firebase_uid: str = Depends(require_firebase_auth),
):
    """Consent handshake timeline between the caller and a counterpart."""
    service = ConsentCenterService()
    return await service.get_handshake_history(
        firebase_uid,
        counterpart_id=counterpart_id,
        actor=actor,
        page=page,
        limit=limit,
    )


@router.post("/relationships/disconnect")
async def disconnect_relationship(
    payload: RelationshipDisconnectRequest,
    firebase_uid: str = Depends(require_firebase_auth),
):
    try:
        return await RIAIAMService().disconnect_relationship(
            firebase_uid,
            investor_user_id=payload.investor_user_id,
            ria_profile_id=payload.ria_profile_id,
        )
    except RIAIAMPolicyError as exc:
        raise HTTPException(status_code=exc.status_code, detail=str(exc)) from exc


@router.post("/vault-owner-token")
async def issue_vault_owner_token(request: Request):
    """
    Issue VAULT_OWNER consent token for authenticated user.

    This is the master token that grants vault owners full access
    to their own encrypted data. Issued after passphrase verification.

    Security:
    - Requires Firebase ID token verification
    - Only issued to the user for their own vault
    - 24-hour expiry (renewable)
    - Logged to the internal access ledger

    CONSENT-FIRST ARCHITECTURE:
    - Vault owners use this token instead of bypassing authentication
    - Maintains protocol integrity (no auth bypasses)
    - All access logged for compliance
    """
    try:
        auth_header = request.headers.get("Authorization")
        if not auth_header or not auth_header.startswith("Bearer "):
            raise HTTPException(
                status_code=401, detail="Missing Authorization header with Firebase ID token"
            )
        # Verify request body
        body = await request.json()
        user_id = body.get("userId")

        if not user_id:
            raise HTTPException(status_code=400, detail="userId is required")

        firebase_uid = verify_firebase_bearer(auth_header)

        # Ensure user is requesting token for their own vault
        if firebase_uid != user_id:
            raise HTTPException(
                status_code=403, detail="Cannot issue VAULT_OWNER token for another user"
            )

        # Check for existing active VAULT_OWNER token in the internal ledger
        now_ms = int(time.time() * 1000)
        service = ConsentDBService()
        active_tokens = await service.get_active_internal_tokens(
            user_id,
            agent_id="self",
            scope=ConsentScope.VAULT_OWNER.value,
        )

        for t in active_tokens:
            # Match scope = vault.owner and agent = self
            if t.get("scope") == ConsentScope.VAULT_OWNER.value and t.get("agent_id") == "self":
                # Check if token has > 1 hour left
                expires_at = t.get("expires_at", 0)
                if expires_at > now_ms + (60 * 60 * 1000):  # 1 hour buffer
                    # REUSE existing token (only if it still validates)
                    #
                    # NOTE: In older deployments, some systems stored a non-token identifier in `token_id`.
                    # If we blindly reuse it, downstream calls fail with "Invalid signature".
                    candidate_token = t.get("token_id")
                    if not candidate_token:
                        logger.warning("vault_owner.reuse_missing_token_id")
                        break

                    is_valid, reason, payload = await validate_token_with_db(
                        candidate_token, ConsentScope.VAULT_OWNER
                    )
                    if not is_valid or not payload:
                        logger.warning(
                            "vault_owner.stored_token_invalid reason=%s",
                            reason,
                        )
                        break

                    logger.info("vault_owner.token_reused expires_at=%s", expires_at)
                    return {
                        "token": candidate_token,
                        "expiresAt": expires_at,
                        "scope": ConsentScope.VAULT_OWNER.value,
                    }

        # No valid token found - issue new one
        logger.info("vault_owner.issue_new_token")

        # Issue new token (24-hour expiry)
        token_obj = issue_token(
            user_id=user_id,
            agent_id="self",  # Vault owner accessing their own data
            scope=ConsentScope.VAULT_OWNER,
            expires_in_ms=24 * 60 * 60 * 1000,  # 24 hours
        )

        # Store in the internal ledger so self-session churn stays out of the investor consent feed.
        service = ConsentDBService()
        await service.insert_internal_event(
            user_id=user_id,
            agent_id="self",
            scope="vault.owner",
            action="CONSENT_GRANTED",
            token_id=token_obj.token,
            expires_at=token_obj.expires_at,
            scope_description="Vault owner session",
        )

        logger.info("vault_owner.token_issued")

        return {"token": token_obj.token, "expiresAt": token_obj.expires_at, "scope": "vault.owner"}

    except HTTPException:
        raise
    except Exception:
        logger.exception("vault_owner.issue_failed")
        raise HTTPException(status_code=500, detail="Failed to issue vault owner token")


@router.post("/revoke")
async def revoke_consent(
    request: Request,
    token_data: dict = Depends(require_vault_owner_token),
):
    """
    User revokes an active consent token.

    SECURITY: Requires VAULT_OWNER token. User can only revoke their own consent.

    This removes access for the app that was previously granted consent.
    For VAULT_OWNER tokens, this effectively locks the vault.
    """
    try:
        from hushh_mcp.consent.token import revoke_token

        body = await request.json()
        userId = body.get("userId")
        scope = body.get("scope")

        if not userId or not scope:
            raise HTTPException(status_code=400, detail="userId and scope are required")

        # Verify user is revoking their own consent
        if token_data["user_id"] != userId:
            raise HTTPException(status_code=403, detail="User ID does not match authenticated user")

        logger.info("consent.revoke_requested scope=%s", scope)

        # Get the active token for this scope from the correct ledger.
        service = ConsentDBService()
        owned_identifiers = await _owned_consent_identifiers(userId)
        active_tokens = await service.get_active_tokens(
            userId,
            **_identifier_filter_kwargs(userId, owned_identifiers),
        )
        internal_tokens = await service.get_active_internal_tokens(userId)
        all_active_tokens = [*internal_tokens, *active_tokens]
        logger.info("consent.revoke_active_token_count=%s", len(all_active_tokens))

        token_to_revoke = None
        for token in all_active_tokens:
            if token.get("scope") == scope:
                token_to_revoke = token
                break

        if not token_to_revoke:
            raise HTTPException(
                status_code=404, detail=f"No active consent found for scope: {scope}"
            )

        # CRITICAL: Add the actual token to in-memory revocation set
        # This ensures validate_token() will reject it immediately
        original_token = token_to_revoke.get("token_id")
        if original_token and not original_token.startswith("REVOKED_"):
            revoke_token(original_token)
            logger.info("🔒 Token added to in-memory revocation set")

            # Also delete any associated export data
            await service.delete_consent_export(original_token)
            if original_token in _consent_exports:
                del _consent_exports[original_token]
            logger.info("🗑️ Deleted associated export data")

        # Generate a NEW unique token_id for the REVOKED event
        # (Cannot reuse original token_id due to UNIQUE constraint on consent_audit table)
        import time

        revoke_token_id = f"REVOKED_{int(time.time() * 1000)}_{scope}"
        agent_id = token_to_revoke.get("agent_id") or token_to_revoke.get("developer") or "Unknown"
        request_id = token_to_revoke.get("request_id")

        logger.info("consent.revoke_persist_event")

        # Log REVOKED event to database (link to original request_id for trail)
        subject_user_id = str(token_to_revoke.get("user_id") or userId).strip() or userId
        await service.insert_event(
            user_id=subject_user_id,
            agent_id=agent_id,
            scope=scope,
            action="REVOKED",
            token_id=revoke_token_id,
            request_id=request_id,
            scope_description="Vault owner session" if agent_id == "self" else None,
        )
        logger.info("consent.revoked_event_saved scope=%s", scope)
        try:
            await RIAIAMService().sync_relationship_from_consent_action(
                user_id=userId,
                request_id=request_id,
                action="REVOKED",
                agent_id=agent_id,
                scope=scope,
            )
        except Exception:
            logger.exception("ria.relationship_sync_failed action=REVOKED")

        # Return special flag for VAULT_OWNER revocation so client knows to lock vault
        is_vault_owner = scope == "vault.owner" or scope == "VAULT_OWNER"

        return {
            "status": "revoked",
            "message": f"Consent for {scope} has been revoked",
            "lockVault": is_vault_owner,  # Signal client to lock vault
        }

    except HTTPException:
        raise
    except Exception as e:
        logger.error("consent.revoke_failed: %s", type(e).__name__)
        logger.exception("consent.revoke_failed_trace")
        raise HTTPException(status_code=500, detail="Internal error")


@router.get("/data")
async def get_consent_export_data(
    request: Request,
    consent_token: str | None = Query(default=None),
):
    """
    Retrieve encrypted export data for a consent token (Zero-Knowledge).

    MCP calls this with a valid consent token.
    Returns encrypted data + wrapped export key bundle for client-side decryption.
    Server NEVER sees plaintext and only returns wrapped-key export packages.

    Data is retrieved from database (source of truth) with in-memory cache fallback.
    """
    authorization = str(request.headers.get("authorization") or "").strip()
    bearer_token = (
        authorization.removeprefix("Bearer ").strip()
        if authorization.lower().startswith("bearer ")
        else ""
    )
    consent_token = bearer_token or _clean_text(consent_token)
    if not consent_token:
        raise HTTPException(
            status_code=401,
            detail="Missing consent token",
            headers={"WWW-Authenticate": "Bearer"},
        )

    logger.info(
        "consent.export_requested token_transport=%s", "bearer" if bearer_token else "query"
    )

    # Validate the consent token — DB-backed revocation check.
    valid, reason, token_obj = await validate_token_with_db(consent_token)
    if not valid:
        logger.warning("consent.export_invalid_token reason=%s", reason)
        raise HTTPException(
            status_code=401,
            detail="Invalid token",
            headers={"WWW-Authenticate": "Bearer"},
        )

    # Try in-memory cache first (fast path); skip entries whose token has expired.
    now_ms = int(time.time() * 1000)
    if consent_token in _consent_exports:
        export_data = _consent_exports[consent_token]
        entry_age_ms = now_ms - int(export_data.get("created_at") or 0)
        if entry_age_ms >= _CONSENT_EXPORT_TTL_MS:
            # Token has certainly expired — drop the stale cache entry and fall
            # through to the DB path (which will return 404 for expired tokens).
            del _consent_exports[consent_token]
            logger.debug("consent_exports.lazy_evict token expired from cache")
        elif not export_data.get("wrapped_key_bundle"):
            raise HTTPException(
                status_code=410,
                detail="Legacy plaintext export format is no longer supported. Request consent again.",
            )
        else:
            logger.info(
                "consent.export_served_from_cache scope=%s", export_data.get("scope")
            )
            return {
                "status": "success",
                "encrypted_data": export_data["encrypted_data"],
                "iv": export_data["iv"],
                "tag": export_data["tag"],
                "wrapped_key_bundle": export_data.get("wrapped_key_bundle"),
                "scope": export_data["scope"],
                "export_revision": export_data.get("export_revision", 1),
                "export_generated_at": export_data.get("export_generated_at"),
                "export_refresh_status": export_data.get("refresh_status", "current"),
            }

    # Fall back to database (cross-instance consistency)
    service = ConsentDBService()
    export_data = await service.get_consent_export(consent_token)

    if not export_data:
        logger.warning("⚠️ No export data found for token (checked cache and DB)")
        raise HTTPException(status_code=404, detail="No export data for this token")
    if not export_data.get("is_strict_zero_knowledge"):
        raise HTTPException(
            status_code=410,
            detail="Legacy plaintext export format is no longer supported. Request consent again.",
        )

    # Cache for future requests; sweep stale entries first.
    _evict_stale_consent_exports()
    _consent_exports[consent_token] = export_data

    logger.info("consent.export_served_from_db")

    return {
        "status": "success",
        "encrypted_data": export_data["encrypted_data"],
        "iv": export_data["iv"],
        "tag": export_data["tag"],
        "wrapped_key_bundle": export_data.get("wrapped_key_bundle"),
        "scope": export_data["scope"],
        "export_revision": export_data.get("export_revision"),
        "export_generated_at": export_data.get("export_generated_at"),
        "export_refresh_status": export_data.get("refresh_status"),
    }


@router.get("/export-refresh/jobs")
async def list_export_refresh_jobs(
    userId: str = Query(..., max_length=128),
    token_data: dict = Depends(require_vault_owner_token),
):
    if token_data["user_id"] != userId:
        raise HTTPException(status_code=403, detail="User ID does not match authenticated user")

    service = ConsentDBService()
    jobs = await service.list_consent_export_refresh_jobs(userId)
    active_tokens = await service.get_active_tokens(userId)
    active_by_token = {
        str(token.get("token_id") or "").strip(): token
        for token in active_tokens
        if str(token.get("token_id") or "").strip()
    }

    payload = []
    for job in jobs:
        consent_token = str(job.get("consent_token") or "").strip()
        active = active_by_token.get(consent_token)
        if not active:
            continue
        metadata = active.get("metadata") if isinstance(active.get("metadata"), dict) else {}
        export_metadata_raw = await service.get_consent_export_metadata(consent_token)
        export_metadata = export_metadata_raw if isinstance(export_metadata_raw, dict) else {}
        connector_public_key = str(metadata.get("connector_public_key") or "").strip()
        if not connector_public_key:
            continue
        payload.append(
            {
                "consentToken": consent_token,
                "grantedScope": active.get("scope") or job.get("granted_scope"),
                "connectorPublicKey": connector_public_key,
                "connectorKeyId": metadata.get("connector_key_id")
                or export_metadata.get("connector_key_id"),
                "connectorWrappingAlg": metadata.get("connector_wrapping_alg")
                or export_metadata.get("connector_wrapping_alg")
                or "X25519-AES256-GCM",
                "status": job.get("status"),
                "triggerDomain": job.get("trigger_domain"),
                "triggerPaths": job.get("trigger_paths") or [],
                "requestedAt": job.get("requested_at"),
                "attemptCount": job.get("attempt_count"),
                "lastError": job.get("last_error"),
                "exportRevision": export_metadata.get("export_revision"),
                "exportRefreshStatus": export_metadata.get("refresh_status"),
            }
        )

    return {"jobs": payload}


@router.post("/export-refresh/upload")
async def upload_refreshed_export(
    request: RefreshExportUploadRequest,
    token_data: dict = Depends(require_vault_owner_token),
):
    if token_data["user_id"] != request.userId:
        raise HTTPException(status_code=403, detail="User ID does not match authenticated user")

    valid, reason, token_obj = await validate_token_with_db(request.consentToken)
    if not valid or token_obj is None:
        raise HTTPException(
            status_code=401,
            detail=f"Invalid consent token for export refresh: {reason or 'unknown'}",
            headers={"WWW-Authenticate": "Bearer"},
        )
    if str(token_obj.user_id) != request.userId:
        raise HTTPException(status_code=403, detail="Consent token user mismatch")

    service = ConsentDBService()
    existing_export = await service.get_consent_export(request.consentToken)
    granted_scope = (
        (
            str(existing_export.get("scope") or "").strip()
            if isinstance(existing_export, dict)
            else ""
        )
        or token_obj.scope_str
        or token_obj.scope.value
    )
    export_revision = (
        int(existing_export.get("export_revision") or 1) if isinstance(existing_export, dict) else 1
    ) + 1
    existing_metadata = {
        "connector_key_id": existing_export.get("connector_key_id") if existing_export else None,
        "connector_wrapping_alg": existing_export.get("connector_wrapping_alg")
        if existing_export
        else None,
    }
    wrapped_key_bundle = _build_verified_wrapped_key_bundle(
        metadata=existing_metadata,
        wrapped_export_key=request.wrappedExportKey,
        wrapped_key_iv=request.wrappedKeyIv,
        wrapped_key_tag=request.wrappedKeyTag,
        sender_public_key=request.senderPublicKey,
        wrapping_alg=request.wrappingAlg,
        connector_key_id=request.connectorKeyId,
    )
    stored = await service.store_consent_export(
        consent_token=request.consentToken,
        user_id=request.userId,
        encrypted_data=request.encryptedData,
        iv=request.encryptedIv,
        tag=request.encryptedTag,
        export_key=None,
        wrapped_key_bundle=wrapped_key_bundle,
        scope=granted_scope,
        expires_at_ms=token_obj.expires_at,
        export_revision=export_revision,
        source_content_revision=request.sourceContentRevision,
        source_manifest_revision=request.sourceManifestRevision,
        refresh_status="current",
    )
    if not stored:
        raise HTTPException(status_code=500, detail="Failed to store refreshed encrypted export")

    _evict_stale_consent_exports()
    _consent_exports[request.consentToken] = {
        "encrypted_data": request.encryptedData,
        "iv": request.encryptedIv,
        "tag": request.encryptedTag,
        "wrapped_key_bundle": wrapped_key_bundle,
        "scope": granted_scope,
        "export_revision": export_revision,
        "export_generated_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "refresh_status": "current",
        "is_strict_zero_knowledge": True,
        "created_at": int(time.time() * 1000),
    }
    await service.complete_consent_export_refresh_job(request.consentToken)
    return {
        "success": True,
        "consentToken": request.consentToken,
        "exportRevision": export_revision,
    }


@router.post("/export-refresh/fail")
async def fail_export_refresh(
    request: RefreshExportFailureRequest,
    token_data: dict = Depends(require_vault_owner_token),
):
    if token_data["user_id"] != request.userId:
        raise HTTPException(status_code=403, detail="User ID does not match authenticated user")

    service = ConsentDBService()
    updated = await service.fail_consent_export_refresh_job(
        request.consentToken,
        last_error=request.lastError,
    )
    if not updated:
        raise HTTPException(status_code=500, detail="Failed to mark export refresh as failed")
    return {"success": True, "consentToken": request.consentToken}


# Expose _consent_exports for other modules that need it
def get_consent_exports() -> Dict[str, Dict]:
    """Get the consent exports dictionary (for cross-module access)."""
    return _consent_exports
