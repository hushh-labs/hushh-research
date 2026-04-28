"""
FastAPI middleware and dependencies for authentication.

Provides reusable dependency functions for route protection:
- require_firebase_auth: Validates Firebase ID token and returns user_id
- require_vault_owner_token: Validates VAULT_OWNER consent token
"""

import logging
from typing import Optional

from fastapi import BackgroundTasks, Header, HTTPException, status
from fastapi.concurrency import run_in_threadpool

from api.utils.firebase_auth import verify_firebase_bearer
from hushh_mcp.consent.token import validate_token_with_db
from hushh_mcp.constants import ConsentScope
from hushh_mcp.services.actor_identity_service import ActorIdentityService

logger = logging.getLogger(__name__)


def _auth_error(detail: str) -> HTTPException:
    """Helper to ensure consistent 401 Unauthorized responses across all routes."""
    return HTTPException(
        status_code=status.HTTP_401_UNAUTHORIZED,
        detail=detail,
        headers={"WWW-Authenticate": "Bearer"},
    )


def _extract_token(
    value: Optional[str],
    *,
    allow_raw: bool = False,
    missing_detail: str = "Missing Authorization header",
) -> str:
    """
    Centralized token extraction. Forces strict 'Bearer ' compliance by default,
    but allows raw JWTs for custom headers when explicitly requested.
    """
    if not value or not value.strip():
        raise _auth_error(missing_detail)

    stripped = value.strip()
    if stripped.startswith("Bearer "):
        token = stripped.removeprefix("Bearer ").strip()
        if not token:
            raise _auth_error("Missing bearer token")
        return token

    if not allow_raw:
        raise _auth_error("Invalid Authorization header format. Expected: Bearer <token>")

    return stripped


def _token_data_dict(token: str, token_obj) -> dict:
    scope_value = token_obj.scope_str if token_obj.scope_str else token_obj.scope.value
    return {
        "user_id": token_obj.user_id,
        "agent_id": token_obj.agent_id,
        "scope": scope_value,
        # Keep raw token string for downstream fetcher/orchestrator calls.
        "token": token,
        # Preserve parsed object for call-sites that need metadata.
        "token_obj": token_obj,
    }


async def require_firebase_auth(
    background_tasks: BackgroundTasks,
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
    # Fail fast on bad formatting (Strict Mode)
    _extract_token(authorization, allow_raw=False)

    try:
        # Pass the original authorization string to avoid breaking downstream parsers.
        # Run in threadpool to protect the asyncio event loop from synchronous I/O.
        firebase_uid = await run_in_threadpool(verify_firebase_bearer, authorization)

        # Safe, logged background execution for side-effects
        def background_sync(uid: str):
            try:
                ActorIdentityService().schedule_sync_from_firebase(uid)
            except Exception as identity_error:
                logger.debug("Actor identity warmup skipped for %s: %s", uid, identity_error)

        background_tasks.add_task(background_sync, firebase_uid)

        return firebase_uid

    except HTTPException:
        raise
    except Exception as e:
        logger.warning("Firebase auth failed: %s", e)
        raise _auth_error("Invalid Firebase ID token")


def verify_user_id_match(firebase_uid: str, requested_user_id: str) -> None:
    """
    Helper to verify that the authenticated user matches the requested user_id.

    Raises:
        HTTPException 403 if user_id doesn't match
    """
    if firebase_uid != requested_user_id:
        logger.warning("User ID mismatch: token=%s, request=%s", firebase_uid, requested_user_id)
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="User ID does not match authenticated user",
        )


async def require_vault_owner_token(
    authorization: Optional[str] = Header(
        None, description="Bearer token for vault owner authentication"
    ),
    hushh_consent: Optional[str] = Header(
        None,
        alias="X-Hushh-Consent",
        description="Optional VAULT_OWNER token header for dual-auth surfaces",
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
    header_value = hushh_consent if hushh_consent is not None else authorization

    # Explicitly allow raw tokens here to support the custom X-Hushh-Consent header
    token = _extract_token(
        header_value, allow_raw=True, missing_detail="Missing Authorization header"
    )

    # Validate token with VAULT_OWNER scope and DB-backed revocation check.
    valid, reason, token_obj = await validate_token_with_db(token, ConsentScope.VAULT_OWNER)

    if not valid or not token_obj:
        logger.warning("Token validation failed: %s", reason)
        raise _auth_error(f"Invalid token: {reason}")

    return _token_data_dict(token, token_obj)


def require_consent_scope(required_scope: str | ConsentScope):
    """
    Build a FastAPI dependency that validates a bearer token for a specific scope.

    `vault.owner` tokens still pass because scope matching treats them as super-scope.
    """

    async def _require_scope_token(
        authorization: Optional[str] = Header(
            None, description="Bearer token for scoped consent authentication"
        ),
    ) -> dict:

        token = _extract_token(authorization, allow_raw=False)
        valid, reason, token_obj = await validate_token_with_db(token, required_scope)

        if not valid or not token_obj:
            logger.warning("Scoped token validation failed for %s: %s", required_scope, reason)
            raise _auth_error(f"Invalid token: {reason}")

        return _token_data_dict(token, token_obj)

    return _require_scope_token
