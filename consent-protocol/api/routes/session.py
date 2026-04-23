# api/routes/session.py
"""
Session token and user management endpoints.
"""

import logging
import os
from typing import Any, Optional

from fastapi import APIRouter, Header, HTTPException

from api.models import LogoutRequest, SessionTokenRequest, SessionTokenResponse
from api.utils.firebase_admin import get_firebase_auth_app
from api.utils.firebase_auth import verify_firebase_bearer
from hushh_mcp.services.consent_db import ConsentDBService

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
            raise HTTPException(status_code=403, detail="userId does not match authenticated user")

        logger.info("session_token.firebase_verified")

    except Exception as e:
        logger.error("session_token.verification_failed: %s", e)
        raise HTTPException(status_code=401, detail="Token verification failed")

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
    userId: str,
    page: int = 1,
    limit: int = 50,
    authorization: str = Header(..., description="Bearer VAULT_OWNER consent token"),
):
    """
    Get paginated consent audit history for a user.

    REQUIRES: VAULT_OWNER consent token.
    Returns all consent actions grouped by app for the Audit Log tab.
    Uses database via consent_db module for persistence.
    """
    # Validate VAULT_OWNER token
    from hushh_mcp.consent.token import validate_token
    from hushh_mcp.constants import ConsentScope

    if not authorization.startswith("Bearer "):
        raise HTTPException(status_code=401, detail="Missing consent token")
    token = authorization.replace("Bearer ", "")
    valid, reason, payload = validate_token(token, ConsentScope.VAULT_OWNER)
    if not valid or not payload:
        _ = reason
        raise HTTPException(status_code=401, detail="Invalid token")
    if payload.user_id != userId:
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
        # SECURITY: Log error details server-side, return generic message (CodeQL fix)
        logger.error("consent_history.fetch_failed: %s", e)
        return {
            "userId": userId,
            "page": page,
            "limit": limit,
            "total": 0,
            "items": [],
            "grouped": {},
            "error": "Failed to fetch consent history",
        }


@router.get("/consent/active")
async def get_active_consents(
    userId: str, authorization: str = Header(..., description="Bearer VAULT_OWNER consent token")
):
    """
    Get active (non-expired) consent tokens for a user.

    REQUIRES: VAULT_OWNER consent token.
    Returns consents grouped by app for the Session tab.
    Uses database via consent_db module for persistence.
    """
    # Validate VAULT_OWNER token
    from hushh_mcp.consent.token import validate_token
    from hushh_mcp.constants import ConsentScope

    if not authorization.startswith("Bearer "):
        raise HTTPException(status_code=401, detail="Missing consent token")
    token = authorization.replace("Bearer ", "")
    valid, reason, payload = validate_token(token, ConsentScope.VAULT_OWNER)
    if not valid or not payload:
        _ = reason
        raise HTTPException(status_code=401, detail="Invalid token")
    if payload.user_id != userId:
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
        # SECURITY: Log error details server-side, return generic message (CodeQL fix)
        logger.error("consent_active.fetch_failed: %s", e)
        return {"grouped": {}, "active": [], "error": "Failed to fetch active consents"}


@router.get("/user/lookup")
async def lookup_user_by_email(
    email: str,
    x_mcp_developer_token: Optional[str] = Header(None, alias="X-MCP-Developer-Token"),
):
    """
    Look up a user by email and return their Firebase UID.

    Used by MCP server to allow consent requests using human-readable
    email addresses instead of Firebase UIDs.

    Returns:
    - user_id: Firebase UID
    - email: The email address
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
    if not x_mcp_developer_token or x_mcp_developer_token != required_token:
        raise HTTPException(status_code=403, detail="Forbidden")

    logger.info("user_lookup.requested")

    try:
        firebase_app = get_firebase_auth_app()
        if firebase_app is None:
            raise HTTPException(status_code=503, detail="Firebase Admin not configured")

        user_record = auth.get_user_by_email(email, app=firebase_app)
        logger.info("user_lookup.found")

        return {
            "exists": True,
            "user_id": user_record.uid,
            "email": user_record.email,
            "display_name": user_record.display_name or email.split("@")[0],
            "photo_url": user_record.photo_url,
            "email_verified": user_record.email_verified,
        }

    except auth.UserNotFoundError:
        logger.info("user_lookup.not_found")
        return {
            "exists": False,
            "email": email,
            "message": f"No Hussh account found for {email}. The user needs to sign up first.",
            "suggestion": "Ask the user to create a Hussh account at the login page.",
        }

    except Exception as e:
        logger.error("user_lookup.error: %s", e)
        raise HTTPException(status_code=500, detail="Failed to look up user")
