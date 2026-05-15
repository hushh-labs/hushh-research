"""
FastAPI middleware and dependencies for authentication.

Provides reusable dependency functions for route protection:
- require_firebase_auth: Validates Firebase ID token and returns user_id
- require_vault_owner_token: Validates VAULT_OWNER consent token.
  Supports ZKP parity via the ``X-Hushh-ZK-Proof`` header: when present,
  the ZK proof is validated first and, on success, the bearer-token path is
  skipped entirely.
"""

import hashlib
import hmac
import logging
from typing import Optional

from fastapi import BackgroundTasks, Header, HTTPException, status
from fastapi.concurrency import run_in_threadpool

from api.utils.firebase_auth import verify_firebase_bearer
from hushh_mcp.consent.token import validate_token_with_db
from hushh_mcp.constants import ConsentScope
from hushh_mcp.services.actor_identity_service import ActorIdentityService

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# ZKP parity — X-Hushh-ZK-Proof header
# ---------------------------------------------------------------------------

_ZKP_PROOF_PREFIX = "ZKP"
_ZKP_SEPARATOR = "|"
_ZKP_FIELD_COUNT = 6  # ZKP|<user_id>|<agent_id>|<scope>|<nonce>|<hmac>


def _zkp_sign(payload: str) -> str:
    """Compute HMAC-SHA256 signature for a ZK proof payload string.

    Uses the same signing key as hushh_mcp.consent.token._sign so that ZK
    proofs are interchangeable with standard consent token signatures.
    Integrated by Abdul Gaffar — ZKP auth parity.
    """
    from hushh_mcp.config import APP_SIGNING_KEY  # inline: avoids circular import

    return hmac.new(APP_SIGNING_KEY.encode(), payload.encode(), hashlib.sha256).hexdigest()


def _validate_zk_proof(proof: str) -> tuple[bool, str | None, dict | None]:
    """Parse and validate an ``X-Hushh-ZK-Proof`` header value.

    Expected format (pipe-separated to avoid ambiguity with colon-containing IDs):
        ZKP|<user_id>|<agent_id>|<scope>|<nonce>|<hmac-sha256>

    The HMAC is computed over ``"<user_id>|<agent_id>|<scope>|<nonce>"``
    using the shared ``APP_SIGNING_KEY``.  Comparison is constant-time
    (``hmac.compare_digest``) to prevent timing attacks.

    Returns:
        (True, None, {"user_id": ..., "agent_id": ..., "scope": ...})
            on success, or
        (False, reason_str, None)
            on any validation failure.

    Integrated by Abdul Gaffar — ZKP auth parity.
    """
    if not proof or not proof.strip():
        return False, "Empty ZK proof", None

    parts = proof.strip().split(_ZKP_SEPARATOR)
    if len(parts) != _ZKP_FIELD_COUNT:
        return (
            False,
            f"Malformed ZK proof: expected {_ZKP_FIELD_COUNT} pipe-separated fields",
            None,
        )

    prefix, user_id, agent_id, scope, nonce, provided_sig = parts

    if prefix != _ZKP_PROOF_PREFIX:
        return False, f"Invalid ZK proof prefix: expected '{_ZKP_PROOF_PREFIX}'", None

    if not user_id or not agent_id or not scope or not nonce:
        return False, "ZK proof fields must not be empty", None

    payload = f"{user_id}|{agent_id}|{scope}|{nonce}"
    expected_sig = _zkp_sign(payload)

    if not hmac.compare_digest(provided_sig, expected_sig):
        return False, "ZK proof signature invalid", None

    return True, None, {"user_id": user_id, "agent_id": agent_id, "scope": scope}


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
    x_hushh_zk_proof: Optional[str] = Header(
        None,
        alias="X-Hushh-ZK-Proof",
        description=(
            "Optional Zero-Knowledge proof header.  When present its validation "
            "takes priority over the standard bearer-token path (ZKP parity).  "
            "Format: ZKP:<user_id>:<agent_id>:<scope>:<nonce>:<hmac-sha256>"
        ),
    ),
) -> dict:
    """
    FastAPI dependency that validates a VAULT_OWNER consent token.

    ZKP parity path (X-Hushh-ZK-Proof header present):
        The ZK proof is validated first.  On success the function returns
        immediately with ``{user_id, agent_id, scope, token: None,
        token_obj: None, zk_proof: True}`` — bypassing the bearer path.
        On failure a 401 is raised; the bearer header is NOT tried as a
        fallback so that a caller cannot bypass ZKP validation by also
        sending a valid bearer token.

    Standard path (no ZK header):
        Existing behaviour: accepts ``Authorization: Bearer`` or
        ``X-Hushh-Consent: <raw_token>``.

    Returns:
        dict with user_id, agent_id, scope, and token object (or
        zk_proof=True sentinel for the ZKP path)

    Raises:
        HTTPException 401 if token / proof is missing or invalid
        HTTPException 403 if token scope is insufficient
    """
    # ZKP parity — if the caller supplies X-Hushh-ZK-Proof, validate it and
    # return before touching the bearer-token path.
    # Integrated by Abdul Gaffar — ZKP auth parity.
    if x_hushh_zk_proof is not None:
        valid, reason, zk_data = _validate_zk_proof(x_hushh_zk_proof)
        if not valid or zk_data is None:
            logger.warning("ZK proof validation failed: %s", reason)
            raise _auth_error(f"Invalid ZK proof: {reason}")
        logger.info(
            "consent.auth.zk_proof_accepted user_id=%s scope=%s",
            zk_data["user_id"],
            zk_data["scope"],
        )
        return {
            "user_id": zk_data["user_id"],
            "agent_id": zk_data["agent_id"],
            "scope": zk_data["scope"],
            "token": None,
            "token_obj": None,
            "zk_proof": True,
        }

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
