"""
FastAPI middleware and dependencies for authentication.

Provides reusable dependency functions for route protection:
- require_firebase_auth: Validates Firebase ID token and returns user_id
- require_vault_owner_token: Validates VAULT_OWNER consent token
"""

import logging
from typing import Any, Optional, cast

from fastapi import BackgroundTasks, Header, HTTPException, Request, status
from fastapi.concurrency import run_in_threadpool

from api.utils.firebase_auth import verify_firebase_bearer
from hushh_mcp.consent.token import validate_token, validate_token_with_db
from hushh_mcp.constants import ConsentScope
from hushh_mcp.services.actor_identity_service import ActorIdentityService

logger = logging.getLogger(__name__)

_CONSENT_SCOPE_CACHE_ATTR = "_hushh_validated_consent_scopes"
_NO_REQUEST = cast(Request, None)


def _auth_error(detail: str) -> HTTPException:
    """Helper to ensure consistent 401 Unauthorized responses across all routes."""
    return HTTPException(
        status_code=status.HTTP_401_UNAUTHORIZED,
        detail=detail,
        headers={"WWW-Authenticate": "Bearer"},
    )


def _account_not_found_error() -> HTTPException:
    return HTTPException(
        status_code=status.HTTP_401_UNAUTHORIZED,
        detail={"code": "AUTH_ACCOUNT_NOT_FOUND", "message": "Account not found"},
        headers={"WWW-Authenticate": "Bearer"},
    )


def _account_deletion_in_progress_error() -> HTTPException:
    return HTTPException(
        status_code=423,
        detail={
            "code": "AUTH_ACCOUNT_DELETION_IN_PROGRESS",
            "message": "Account deletion is in progress.",
        },
        headers={"Cache-Control": "private, no-store", "Retry-After": "2"},
    )


async def _raise_if_account_is_tombstoned(user_id: str) -> None:
    from hushh_mcp.services.account_deletion_lifecycle_service import (
        AccountDeletionInProgressError,
        AccountDeletionLifecycleService,
    )

    try:
        is_tombstoned = await run_in_threadpool(
            AccountDeletionLifecycleService.is_tombstoned,
            user_id,
        )
    except AccountDeletionInProgressError:
        raise _account_deletion_in_progress_error() from None
    if is_tombstoned:
        raise _account_not_found_error()


async def _raise_if_signed_owner_token_is_tombstoned(token: str) -> None:
    """Recover only a terminal deletion result; never authorize the token.

    Account deletion revokes/removes the VAULT_OWNER ledger row atomically. A
    client retry after losing the successful response therefore reaches this
    dependency with a correctly signed but DB-revoked token. Re-verifying its
    signature, expiry and owner scope without the process-local revocation
    cache lets us obtain the UID solely to query the irreversible tombstone.
    """
    valid, _reason, signed_token = validate_token(
        token,
        ConsentScope.VAULT_OWNER,
        _skip_revocation_cache=True,
    )
    if not valid or signed_token is None:
        return
    await _raise_if_account_is_tombstoned(str(signed_token.user_id))


async def _enforce_account_lifecycle_status(user_id: str) -> None:
    """Fail closed unless this authenticated UID is not terminally deleted."""
    try:
        await _raise_if_account_is_tombstoned(user_id)
    except HTTPException:
        raise
    except Exception as exc:
        logger.error(
            "Account lifecycle status could not be confirmed; failing closed error=%s",
            type(exc).__name__,
        )
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail={
                "code": "AUTH_ACCOUNT_STATUS_UNAVAILABLE",
                "message": "Unable to verify account status. Please retry.",
            },
            headers={"Cache-Control": "private, no-store", "Retry-After": "3"},
        ) from None


# Reasons that are themselves machine codes the trusted-device native runtime
# branches on (authoritative revoke -> seal vs transient DB outage -> retry).
# These are surfaced verbatim as the 401 detail; every other failure reason
# stays the generic message so we never leak why a token failed.
_TRUSTED_DEVICE_AUTH_CODES = frozenset(
    {"TRUSTED_DEVICE_REVOKED", "TRUSTED_DEVICE_STATUS_UNCONFIRMED"}
)


def _extract_token(
    value: Optional[str] | Any,
    *,
    allow_raw: bool = False,
    missing_detail: str = "Missing Authorization header",
) -> str:
    """
    Centralized token extraction. Forces strict 'Bearer ' compliance by default,
    but allows raw JWTs for custom headers when explicitly requested.
    """
    if not isinstance(value, str) or not value.strip():
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
    raw_scope = getattr(token_obj, "scope", "")
    scope_value = (
        token_obj.scope_str
        if getattr(token_obj, "scope_str", None)
        else raw_scope.value
        if hasattr(raw_scope, "value")
        else str(raw_scope)
    )
    return {
        "user_id": token_obj.user_id,
        "agent_id": token_obj.agent_id,
        "scope": scope_value,
        # Keep raw token string for downstream fetcher/orchestrator calls.
        "token": token,
        # Preserve parsed object for call-sites that need metadata.
        "token_obj": token_obj,
    }


def _scope_cache_key(token: str, required_scope: str | ConsentScope) -> tuple[str, str]:
    scope = (
        required_scope.value if isinstance(required_scope, ConsentScope) else str(required_scope)
    )
    return token, scope


def _request_scope_cache(request: Request | None) -> dict | None:
    if request is None:
        return None

    cache = getattr(request.state, _CONSENT_SCOPE_CACHE_ATTR, None)
    if cache is None:
        cache = {}
        setattr(request.state, _CONSENT_SCOPE_CACHE_ATTR, cache)
    return cache


async def _validate_token_with_scope_cache(
    token: str,
    required_scope: str | ConsentScope,
    request: Request | None,
):
    cache = _request_scope_cache(request)
    cache_key = _scope_cache_key(token, required_scope)
    if cache is not None and cache_key in cache:
        result = cache[cache_key]
    else:
        result = await validate_token_with_db(token, required_scope)
    valid, _reason, token_obj = result
    if cache is not None and cache_key not in cache and valid and token_obj:
        cache[cache_key] = result
    if valid and token_obj:
        # This applies to every HCT entry point, including a VAULT_OWNER token
        # accepted as a super-scope by require_consent_scope(). Re-check even on
        # a request-local token-cache hit so a concurrent deletion commit wins.
        await _enforce_account_lifecycle_status(str(token_obj.user_id))
    return result


async def require_firebase_auth_read_only(
    authorization: Optional[str] = Header(None, description="Bearer token with Firebase ID token"),
) -> str:
    """Validate Firebase auth without scheduling identity bootstrap or writes."""
    _extract_token(authorization, allow_raw=False)
    try:
        return await run_in_threadpool(verify_firebase_bearer, authorization)
    except HTTPException:
        raise
    except Exception as exc:
        logger.warning("Firebase auth failed: %s", type(exc).__name__)
        raise _auth_error("Invalid Firebase ID token") from None


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
    try:
        firebase_uid = await require_firebase_auth_read_only(authorization)

        # Starlette runs synchronous background callbacks in a worker thread.
        # Identity sync is async and must stay on the request event loop; the
        # previous sync wrapper called an asyncio scheduler from that worker,
        # found no running loop, and silently skipped every warmup.
        async def background_sync(uid: str) -> None:
            try:
                # Starlette awaits async background callbacks after the response.
                # Await the real sync here as well: delegating again through
                # create_task detached the write from the request lifecycle, so
                # Cloud Run could freeze the instance before it reached Postgres.
                await ActorIdentityService().sync_from_firebase_if_due(uid, force=False)
            except Exception as identity_error:
                # Database/Firebase exception text can contain a phone number.
                # Keep this best-effort path observable without logging user
                # identifiers or provider/database error details.
                logger.debug(
                    "Actor identity warmup skipped error=%s",
                    type(identity_error).__name__,
                )

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
    request: Request = _NO_REQUEST,
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
    header_value = (
        hushh_consent if isinstance(hushh_consent, str) and hushh_consent.strip() else authorization
    )

    # Explicitly allow raw tokens here to support the custom X-Hushh-Consent header
    token = _extract_token(
        header_value, allow_raw=True, missing_detail="Missing Authorization header"
    )

    # Validate token with VAULT_OWNER scope and DB-backed revocation check.
    valid, reason, token_obj = await _validate_token_with_scope_cache(
        token, ConsentScope.VAULT_OWNER, request
    )

    if not valid or not token_obj:
        logger.warning("Token validation failed: %s", reason)
        if reason in _TRUSTED_DEVICE_AUTH_CODES:
            raise _auth_error(reason)
        try:
            await _raise_if_signed_owner_token_is_tombstoned(token)
        except HTTPException:
            raise
        except Exception as exc:
            # The normal token failure remains authoritative. A recovery-only
            # tombstone lookup must never turn an invalid credential into a 5xx
            # or authorize it during a database outage.
            logger.warning(
                "Deleted-account terminal recovery unavailable error=%s",
                type(exc).__name__,
            )
        raise _auth_error("Token validation failed.")

    return _token_data_dict(token, token_obj)


def require_consent_scope(required_scope: str | ConsentScope):
    """
    Build a FastAPI dependency that validates a bearer token for a specific scope.

    `vault.owner` tokens still pass because scope matching treats them as super-scope.
    """

    async def _require_scope_token(
        request: Request = _NO_REQUEST,
        authorization: Optional[str] = Header(
            None, description="Bearer token for scoped consent authentication"
        ),
    ) -> dict:
        token = _extract_token(authorization, allow_raw=False)
        valid, reason, token_obj = await _validate_token_with_scope_cache(
            token, required_scope, request
        )

        if not valid or not token_obj:
            logger.warning("Scoped token validation failed for %s: %s", required_scope, reason)
            if reason in _TRUSTED_DEVICE_AUTH_CODES:
                raise _auth_error(reason)
            try:
                await _raise_if_signed_owner_token_is_tombstoned(token)
            except HTTPException:
                raise
            except Exception as exc:
                logger.warning(
                    "Deleted-account terminal recovery unavailable error=%s",
                    type(exc).__name__,
                )
            raise _auth_error("Token validation failed.")

        return _token_data_dict(token, token_obj)

    return _require_scope_token
