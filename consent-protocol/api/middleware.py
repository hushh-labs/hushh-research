# api/middleware.py
"""
FastAPI middleware and dependencies for authentication.

Provides reusable dependency functions for route protection:
- require_firebase_auth: Validates Firebase ID token and returns user_id
- require_vault_owner_token: Validates VAULT_OWNER consent token
"""

import logging
from typing import Optional

from fastapi import Header, HTTPException, status

from api.utils.firebase_auth import verify_firebase_bearer
from hushh_mcp.consent.token import validate_token_with_db
from hushh_mcp.constants import ConsentScope
from hushh_mcp.services.actor_identity_service import ActorIdentityService

logger = logging.getLogger(__name__)


async def require_firebase_auth(
    authorization: Optional[str] = Header(None, description="Bearer token with Firebase ID token"),
) -> str:
    """
    FastAPI dependency that validates a Firebase ID token.

    Usage:
        @router.get("/protected")
        async def protected_endpoint(
            firebase_uid: str = Depends(require_firebase_auth),
        ):
            # firebase_uid is the authenticated user's Firebase UID
            ...

    Returns:
        str: The Firebase UID of the authenticated user

    Raises:
        HTTPException 401 if token is missing or invalid
    """
    if not authorization:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Missing Authorization header",
            headers={"WWW-Authenticate": "Bearer"},
        )

    if not authorization.startswith("Bearer "):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid Authorization header format. Expected: Bearer <token>",
            headers={"WWW-Authenticate": "Bearer"},
        )

    try:
        firebase_uid = verify_firebase_bearer(authorization)
        try:
            ActorIdentityService().schedule_sync_from_firebase(firebase_uid)
        except Exception as identity_error:
            logger.debug("Actor identity warmup skipped for %s: %s", firebase_uid, identity_error)
        return firebase_uid
    except HTTPException:
        raise
    except Exception as e:
        logger.warning(f"Firebase auth failed: {e}")
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid Firebase ID token",
            headers={"WWW-Authenticate": "Bearer"},
        )


def verify_user_id_match(firebase_uid: str, requested_user_id: str) -> None:
    """
    Helper to verify that the authenticated user matches the requested user_id.

    Raises:
        HTTPException 403 if user_id doesn't match
    """
    if firebase_uid != requested_user_id:
        logger.warning(f"User ID mismatch: token={firebase_uid}, request={requested_user_id}")
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="User ID does not match authenticated user",
        )


async def require_vault_owner_token(
    authorization: Optional[str] = Header(
        None, description="Bearer token for vault owner authentication"
    ),
) -> dict:
    """
    FastAPI dependency that validates a VAULT_OWNER consent token.

    Usage:
        @router.post("/protected")
        async def protected_endpoint(
            token_data: dict = Depends(require_vault_owner_token),
        ):
            user_id = token_data["user_id"]
            ...

    Returns:
        dict with user_id, agent_id, scope, and token object

    Raises:
        HTTPException 401 if token is missing or invalid
        HTTPException 403 if token scope is insufficient
    """
    if not authorization:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Missing Authorization header",
            headers={"WWW-Authenticate": "Bearer"},
        )

    if not authorization.startswith("Bearer "):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid Authorization header format. Expected: Bearer <token>",
            headers={"WWW-Authenticate": "Bearer"},
        )

    token = authorization.removeprefix("Bearer ").strip()

    if not token:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Missing bearer token",
            headers={"WWW-Authenticate": "Bearer"},
        )

    # Validate token with VAULT_OWNER scope and DB-backed revocation check.
    valid, reason, token_obj = await validate_token_with_db(token, ConsentScope.VAULT_OWNER)

    if not valid or not token_obj:
        logger.warning(f"Token validation failed: {reason}")
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail=f"Invalid token: {reason}",
            headers={"WWW-Authenticate": "Bearer"},
        )

    return {
        "user_id": token_obj.user_id,
        "agent_id": token_obj.agent_id,
        "scope": token_obj.scope.value,
        # Keep raw token string for downstream fetcher/orchestrator calls.
        "token": token,
        # Preserve parsed object for call-sites that need metadata.
        "token_obj": token_obj,
    }
