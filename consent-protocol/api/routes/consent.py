# api/routes/consent.py
"""
Consent management endpoints (pending, approve, deny, revoke, history, active).

NOTE: Uses dynamic attr.{domain}.* scopes instead of legacy vault.read.*/vault.write.* scopes.
Legacy scopes are mapped to dynamic scopes for backward compatibility.

SECURITY: All consent management endpoints require VAULT_OWNER token authentication.
The consent page is vault-gated, so users must unlock their vault first.
This ensures consistent consent-first architecture throughout the system.
"""

import logging
import re
import time
from typing import Dict

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from pydantic import BaseModel
from sqlalchemy.exc import OperationalError as SqlalchemyOperationalError

from api.middleware import require_firebase_auth, require_vault_owner_token
from api.utils.firebase_auth import verify_firebase_bearer
from db.db_client import DatabaseExecutionError
from hushh_mcp.consent.scope_helpers import get_scope_description as get_dynamic_scope_description
from hushh_mcp.consent.scope_helpers import resolve_scope_to_enum
from hushh_mcp.consent.token import issue_token, revoke_token, validate_token
from hushh_mcp.constants import ConsentScope
from hushh_mcp.services.actor_identity_service import ActorIdentityService
from hushh_mcp.services.consent_center_service import ConsentCenterService
from hushh_mcp.services.consent_db import ConsentDBService
from hushh_mcp.services.ria_iam_service import RIAIAMPolicyError, RIAIAMService

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/consent", tags=["Consent Management"])

# NOTE: Export data is now persisted to database via ConsentDBService.store_consent_export()
# The in-memory dict is kept as a fast cache but database is the source of truth
_consent_exports: Dict[str, Dict] = {}
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


def _is_consent_storage_unavailable(exc: Exception) -> bool:
    current: BaseException | None = exc
    seen: set[int] = set()
    while current is not None and id(current) not in seen:
        seen.add(id(current))
        if isinstance(current, (DatabaseExecutionError, SqlalchemyOperationalError)):
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
    userId: str
    requestId: str


class PendingConsentOpenedRequest(BaseModel):
    userId: str
    requestId: str | None = None
    bundleId: str | None = None
    openedVia: str | None = None


class GenericConsentRequestCreate(BaseModel):
    subject_user_id: str
    requester_actor_type: str = "ria"
    subject_actor_type: str = "investor"
    scope_template_id: str
    selected_scope: str | None = None
    duration_mode: str = "preset"
    duration_hours: int | None = None
    firm_id: str | None = None
    reason: str | None = None


class RelationshipDisconnectRequest(BaseModel):
    investor_user_id: str | None = None
    ria_profile_id: str | None = None


class RefreshExportUploadRequest(BaseModel):
    userId: str
    consentToken: str
    encryptedData: str
    encryptedIv: str
    encryptedTag: str
    wrappedExportKey: str
    wrappedKeyIv: str
    wrappedKeyTag: str
    senderPublicKey: str
    wrappingAlg: str | None = None
    connectorKeyId: str | None = None
    sourceContentRevision: int | None = None
    sourceManifestRevision: int | None = None


class RefreshExportFailureRequest(BaseModel):
    userId: str
    consentToken: str
    lastError: str | None = None


@router.get("/pending")
async def get_pending_consents(
    userId: str,
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
        pending_from_db = await service.get_pending_requests(userId)
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


@router.post("/pending/opened")
async def mark_pending_consent_opened(
    body: PendingConsentOpenedRequest,
    token_data: dict = Depends(require_vault_owner_token),
):
    if token_data["user_id"] != body.userId:
        raise HTTPException(status_code=403, detail="User ID does not match authenticated user")

    service = ConsentDBService()
    opened = await service.mark_pending_request_opened(
        user_id=body.userId,
        request_id=body.requestId,
        bundle_id=body.bundleId,
        opened_via=body.openedVia,
    )
    if opened is None:
        return {"ok": True, "acknowledged": False}
    return {"ok": True, "acknowledged": True, **opened}


@router.post("/pending/approve")
async def approve_consent(
    request: Request,
    token_data: dict = Depends(require_vault_owner_token),
):
    """
    User approves a pending consent request (Zero-Knowledge).

    SECURITY: Requires VAULT_OWNER token. User can only approve their own consent requests.

    Browser sends encrypted export data (server never sees plaintext).
    For connector-backed approvals, the export key is wrapped to the connector public key
    and the backend never persists a plaintext decrypt key.
    """
    body = await request.json()
    userId = body.get("userId")
    requestId = body.get("requestId")
    encryptedData = body.get("encryptedData")  # Base64 ciphertext
    encryptedIv = body.get("encryptedIv")  # Base64 IV
    encryptedTag = body.get("encryptedTag")  # Base64 auth tag
    wrappedExportKey = body.get("wrappedExportKey")
    wrappedKeyIv = body.get("wrappedKeyIv")
    wrappedKeyTag = body.get("wrappedKeyTag")
    senderPublicKey = body.get("senderPublicKey")
    wrappingAlg = body.get("wrappingAlg")
    connectorKeyId = body.get("connectorKeyId")
    requested_duration_hours = body.get("durationHours")
    source_content_revision = body.get("sourceContentRevision")
    source_manifest_revision = body.get("sourceManifestRevision")

    # Verify user is approving their own consent
    if token_data["user_id"] != userId:
        raise HTTPException(status_code=403, detail="User ID does not match authenticated user")

    logger.info("consent.approve_requested")
    logger.info("consent.approve_export_attached=%s", bool(encryptedData))

    # Get pending request from database
    service = ConsentDBService()
    pending_request = await service.get_pending_by_request_id(userId, requestId)

    if not pending_request:
        raise HTTPException(status_code=404, detail="Consent request not found")

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

    if existing_token:
        # IDEMPOTENT RETURN: Reuse existing token
        logger.info("consent.token_reused scope=%s", requested_scope)

        # Log REUSE event for audit trail (optional, but good for tracking)
        # await consent_db.insert_event(..., action="TOKEN_REUSED", ...)
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
        if not all([wrappedExportKey, wrappedKeyIv, wrappedKeyTag, senderPublicKey]):
            raise HTTPException(
                status_code=400,
                detail="Connector-backed consent approvals must include a wrapped export key bundle.",
            )
        wrapped_key_bundle = {
            "wrapped_export_key": wrappedExportKey,
            "wrapped_key_iv": wrappedKeyIv,
            "wrapped_key_tag": wrappedKeyTag,
            "sender_public_key": senderPublicKey,
            "wrapping_alg": wrappingAlg
            or metadata.get("connector_wrapping_alg")
            or "X25519-AES256-GCM",
            "connector_key_id": connectorKeyId or metadata.get("connector_key_id"),
        }
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

    if encryptedData and wrapped_key_bundle:
        # Store in database (source of truth)
        stored = await service.store_consent_export(
            consent_token=token.token,
            user_id=userId,
            encrypted_data=encryptedData,
            iv=encryptedIv or "",
            tag=encryptedTag or "",
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

        # Also cache in memory for fast access
        _consent_exports[token.token] = {
            "encrypted_data": encryptedData,
            "iv": encryptedIv,
            "tag": encryptedTag,
            "wrapped_key_bundle": wrapped_key_bundle,
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
            user_id=userId,
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
    userId: str,
    requestId: str,
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
    pending_request = await service.get_pending_by_request_id(userId, requestId)

    if not pending_request:
        raise HTTPException(status_code=404, detail="Consent request not found")

    metadata = pending_request.get("metadata", {})
    developer_label = (
        metadata.get("developer_app_display_name") if isinstance(metadata, dict) else None
    ) or pending_request["developer"]

    # Log CONSENT_DENIED to database
    await service.insert_event(
        user_id=userId,
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
    pending_request = await service.get_pending_by_request_id(payload.userId, payload.requestId)
    if not pending_request:
        raise HTTPException(status_code=404, detail="Consent request not found")

    await service.insert_event(
        user_id=payload.userId,
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
    counterpart_id: str = Query(..., min_length=1),
    actor: str = Query(default="investor"),
    page: int = Query(default=1, ge=1),
    limit: int = Query(default=50, ge=1, le=200),
    firebase_uid: str = Depends(require_firebase_auth),
):
    """
    Return the consent handshake timeline between the authenticated user and a
    counterpart (investor-RIA pair).  Both investor and RIA see the same
    lifecycle reflected correctly.

    This is the canonical read-model for Issue #122: every invite, request,
    approval, denial, revocation, and timeout is surfaced in one timeline.
    """
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

                    is_valid, reason, payload = validate_token(
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
        active_tokens = await service.get_active_tokens(userId)
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
        await service.insert_event(
            user_id=userId,
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
async def get_consent_export_data(consent_token: str):
    """
    Retrieve encrypted export data for a consent token (Zero-Knowledge).

    MCP calls this with a valid consent token.
    Returns encrypted data + wrapped export key bundle for client-side decryption.
    Server NEVER sees plaintext and only returns wrapped-key export packages.

    Data is retrieved from database (source of truth) with in-memory cache fallback.
    """
    logger.info("consent.export_requested")

    # Validate the consent token
    valid, reason, token_obj = validate_token(consent_token)
    if not valid:
        logger.warning("consent.export_invalid_token reason=%s", reason)
        raise HTTPException(status_code=401, detail="Invalid token")

    # Try in-memory cache first (fast path)
    if consent_token in _consent_exports:
        export_data = _consent_exports[consent_token]
        if not export_data.get("wrapped_key_bundle"):
            raise HTTPException(
                status_code=410,
                detail="Legacy plaintext export format is no longer supported. Request consent again.",
            )
        logger.info(
            f"✅ Returning encrypted export from cache for scope: {export_data.get('scope')}"
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

    # Cache for future requests
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
    userId: str,
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

    valid, reason, token_obj = validate_token(request.consentToken)
    if not valid or token_obj is None:
        raise HTTPException(
            status_code=401,
            detail=f"Invalid consent token for export refresh: {reason or 'unknown'}",
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
    wrapped_key_bundle = {
        "wrapped_export_key": request.wrappedExportKey,
        "wrapped_key_iv": request.wrappedKeyIv,
        "wrapped_key_tag": request.wrappedKeyTag,
        "sender_public_key": request.senderPublicKey,
        "wrapping_alg": request.wrappingAlg or "X25519-AES256-GCM",
        "connector_key_id": request.connectorKeyId,
    }
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
