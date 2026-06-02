# api/routes/session.py
"""
Session token and user management endpoints.
"""

import hmac
import logging
import os
from typing import Any, Optional

from fastapi import APIRouter, Depends, Header, HTTPException, Query

from api.middleware import require_vault_owner_token
from api.models import LogoutRequest, SessionTokenRequest, SessionTokenResponse
from api.utils.firebase_admin import get_firebase_auth_app
from api.utils.firebase_auth import verify_firebase_bearer
from hushh_mcp.services.actor_identity_service import ActorIdentityService
from hushh_mcp.services.consent_db import ConsentDBService
from hushh_mcp.services.user_identifier_service import resolve_lookup_identifier
from hushh_mcp.services.vault_keys_service import VaultKeysService

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api", tags=["Session"])


@router.post("/consent/issue-token", response_model=SessionTokenResponse)
async def issue_session_token(
    request: SessionTokenRequest, authorization: Optional[str] = Header(None)
):
    """
    Issue a session token after passphrase verification.

    SECURITY: Requires Firebase ID token in Authorization header.
    The userId in request body MUST match the verified token's UID.

    Called after successful passphrase unlock on the frontend.
    """
    from hushh_mcp.consent.token import issue_token
    from hushh_mcp.constants import ConsentScope

    try:
        verified_uid = verify_firebase_bearer(authorization)

        # Ensure request userId matches verified token
        if request.userId != verified_uid:
            logger.warning("session_token.user_mismatch")
            raise HTTPException(status_code=403, detail="userId mismatch")

        logger.info("session_token.firebase_verified")

    except HTTPException:
        raise  # keep original error

    except ValueError as e:
        logger.warning("session_token.invalid_token: %s", e)
        raise HTTPException(status_code=401, detail="Invalid token")

    except Exception as e:
        logger.error("session_token.internal_error: %s", e)
        raise HTTPException(status_code=500, detail="Internal server error")

    try:
        # Issue token with session scope
        # Issue token with session scope
        # If request asks for "session", grant VAULT_OWNER (Master Scope)
        scope_to_grant = (
            ConsentScope.VAULT_OWNER if request.scope == "session" else ConsentScope(request.scope)
        )

        token_obj = issue_token(
            user_id=request.userId,
            agent_id="self",
            scope=scope_to_grant,
            expires_in_ms=24 * 60 * 60 * 1000,  # 24 hours
        )

        try:
            VaultKeysService().ensure_actor_profile(request.userId)
            await ActorIdentityService().sync_from_firebase(request.userId, force=False)
        except Exception as identity_error:
            logger.debug(
                "session_token.identity_shadow_sync_skipped user=%s error=%s",
                request.userId,
                identity_error,
            )

        logger.info("session_token.issued")

        return SessionTokenResponse(
            sessionToken=token_obj.token,
            issuedAt=token_obj.issued_at,
            expiresAt=token_obj.expires_at,
            scope=request.scope,
        )
    except Exception as e:
        logger.error("session_token.issue_failed: %s", e)
        raise HTTPException(status_code=500, detail="Failed to issue session token")


@router.post("/consent/logout")
async def logout_session(request: LogoutRequest):
    """
    Destroy all session tokens for a user.

    Called when user logs out. Invalidates all active session tokens.
    External API tokens are NOT affected.
    """

    logger.info("session.logout")

    # In production, this would query the database for all session tokens
    # and revoke them. For now, we just log the action.
    # The frontend should also clear sessionStorage.

    return {
        "status": "success",
        "message": "Session tokens marked for revocation",
    }


@router.get("/consent/history")
async def get_consent_history(
    userId: str = Query(..., max_length=128),
    page: int = Query(1, ge=1, le=10_000),
    limit: int = Query(50, ge=1, le=200),
    token_data: dict = Depends(require_vault_owner_token),
):
    """
    Get paginated consent audit history for a user.

    REQUIRES: VAULT_OWNER consent token (via Authorization header).
    Returns all consent actions grouped by app for the Audit Log tab.
    Uses database via consent_db module for persistence.
    """
    # Canonical guard: DB-backed revocation, safe extraction, RFC-7235 headers.
    if str(token_data["user_id"]) != userId:
        raise HTTPException(status_code=403, detail="Token user mismatch")

    logger.info("consent_history.fetch page=%s", page)

    try:
        service = ConsentDBService()
        result = await service.get_audit_log(userId, page, limit)

        # Group by agent_id for frontend display
        grouped: dict[str, list[dict[str, Any]]] = {}
        for item in result.get("items", []):
            agent = item.get("agent_id", "Unknown")
            if agent not in grouped:
                grouped[agent] = []
            grouped[agent].append(item)

        return {
            "userId": userId,
            "page": result.get("page", page),
            "limit": result.get("limit", limit),
            "total": result.get("total", 0),
            "items": result.get("items", []),
            "grouped": grouped,
        }
    except Exception as e:
        logger.error("consent_history.fetch_failed: %s", e)
        raise HTTPException(status_code=500, detail="Failed to fetch consent history")


@router.get("/consent/active")
async def get_active_consents(
    userId: str = Query(..., max_length=128),
    token_data: dict = Depends(require_vault_owner_token),
):
    """
    Get active (non-expired) consent tokens for a user.

    REQUIRES: VAULT_OWNER consent token (via Authorization header).
    Returns consents grouped by app for the Session tab.
    Uses database via consent_db module for persistence.
    """
    # Canonical guard: DB-backed revocation, safe extraction, RFC-7235 headers.
    if str(token_data["user_id"]) != userId:
        raise HTTPException(status_code=403, detail="Token user mismatch")

    logger.info("consent_active.fetch")

    try:
        service = ConsentDBService()
        active_tokens = await service.get_active_tokens(userId)

        # Group by developer/app
        grouped = {}
        for token in active_tokens:
            app = token.get("developer", "Unknown App")
            if app not in grouped:
                grouped[app] = {"appName": app.replace("developer:", ""), "scopes": []}
            grouped[app]["scopes"].append(
                {
                    "scope": token.get("scope"),
                    "tokenPreview": token.get("id"),
                    "issuedAt": token.get("issued_at"),
                    "expiresAt": token.get("expires_at"),
                    "timeRemainingMs": token.get("time_remaining_ms", 0),
                }
            )

        return {"grouped": grouped, "active": active_tokens}
    except Exception as e:
        logger.error("consent_active.fetch_failed: %s", e)
        raise HTTPException(status_code=500, detail="Failed to fetch active consents")


@router.get("/user/lookup")
async def lookup_user(
    identifier: Optional[str] = None,
    email: Optional[str] = None,
    phone_number: Optional[str] = None,
    country_iso2: Optional[str] = None,
    country: Optional[str] = None,
    x_mcp_developer_token: Optional[str] = Header(None, alias="X-MCP-Developer-Token"),
):
    """
    Look up a user by Firebase UID, email, or phone number and return their Firebase UID.

    Used by MCP server to allow consent requests using human-readable identifiers
    instead of only Firebase UIDs. National phone numbers default to US parsing
    unless a country hint is provided.

    Returns:
    - user_id: Firebase UID
    - email: The email address
    - phone_number: The linked phone number (if set)
    - display_name: User's display name (if set)
    - exists: True if user exists

    Or for non-existent users:
    - exists: False
     - message: Friendly error message
    """
    from firebase_admin import auth

    required_token = str(os.getenv("HUSHH_DEVELOPER_TOKEN", "")).strip()
    if not required_token:
        raise HTTPException(status_code=503, detail="Lookup endpoint not configured")
    if not x_mcp_developer_token or not hmac.compare_digest(x_mcp_developer_token, required_token):
        raise HTTPException(status_code=403, detail="Forbidden")

    try:
        lookup_kind, lookup_value = resolve_lookup_identifier(
            identifier=identifier,
            email=email,
            phone_number=phone_number,
            country_iso2=country_iso2,
            country=country,
        )
    except ValueError as exc:
        logger.warning("user_lookup.invalid_identifier: %s", exc)
        raise HTTPException(
            status_code=400,
            detail="Invalid lookup identifier. Provide a valid email, phone number, or user ID.",
        ) from exc

    logger.info("user_lookup.requested kind=%s", lookup_kind)

    try:
        firebase_app = get_firebase_auth_app()
        if firebase_app is None:
            raise HTTPException(status_code=503, detail="Firebase Admin not configured")

        if lookup_kind == "email":
            user_record = auth.get_user_by_email(lookup_value, app=firebase_app)
        elif lookup_kind == "phone":
            user_record = auth.get_user_by_phone_number(lookup_value, app=firebase_app)
        else:
            user_record = auth.get_user(lookup_value, app=firebase_app)

        try:
            ActorIdentityService().schedule_sync_from_firebase(user_record.uid, force=False)
        except Exception as identity_error:
            logger.debug(
                "user_lookup.identity_warmup_skipped uid=%s error=%s",
                user_record.uid,
                identity_error,
            )

        logger.info("user_lookup.found")

        return {
            "exists": True,
            "user_id": user_record.uid,
            "email": user_record.email,
            "phone_number": getattr(user_record, "phone_number", None),
            "phone_verified": bool(getattr(user_record, "phone_number", None)),
            "display_name": user_record.display_name
            or user_record.email
            or getattr(user_record, "phone_number", None)
            or user_record.uid,
            "photo_url": user_record.photo_url,
            "email_verified": user_record.email_verified,
        }

    except auth.UserNotFoundError:
        logger.info("user_lookup.not_found")
        return {
            "exists": False,
            "identifier": lookup_value,
            **({"email": lookup_value} if lookup_kind == "email" else {}),
            **({"phone_number": lookup_value} if lookup_kind == "phone" else {}),
            "message": f"No Hussh account found for {lookup_value}. The user needs to sign up first.",
            "suggestion": "Ask the user to create a Hussh account at the login page.",
        }

    except Exception as e:
        logger.error("user_lookup.error: %s", e)
        raise HTTPException(status_code=500, detail="Failed to look up user")
