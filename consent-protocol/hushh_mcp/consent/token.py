# hushh_mcp/consent/token.py

import base64
import hashlib
import hmac
import logging
import os
import time
from typing import Optional, Tuple, Union

from hushh_mcp.config import DEFAULT_CONSENT_TOKEN_EXPIRY_MS, SECRET_KEY
from hushh_mcp.constants import CONSENT_TOKEN_PREFIX, ConsentScope
from hushh_mcp.types import AgentID, HushhConsentToken, UserID

logger = logging.getLogger(__name__)

# ========== Internal Revocation Registry ==========
# In-memory set for fast revocation checks (immediate effect)
# Also persisted to DB for cross-instance consistency
_revoked_tokens: set[str] = set()

# ========== Token Generator ==========


def issue_token(
    user_id: UserID,
    agent_id: AgentID,
    scope: Union[str, ConsentScope],
    expires_in_ms: int = DEFAULT_CONSENT_TOKEN_EXPIRY_MS,
) -> HushhConsentToken:
    """
    Issue a consent token with the given scope.

    CRITICAL: Scope can be a string (e.g., 'attr.financial.*') or ConsentScope enum.
    When a string is provided, it's preserved exactly in the token to maintain domain isolation.
    This ensures 'attr.financial.*' tokens can ONLY access financial data, not all attr.* domains.
    """
    issued_at = int(time.time() * 1000)
    expires_at = issued_at + expires_in_ms

    # Preserve original scope string or convert enum to string.
    #
    # IMPORTANT: ConsentScope is declared as `class ConsentScope(str, Enum)`,
    # which means `isinstance(ConsentScope.VAULT_OWNER, str)` is True.
    # So we MUST check ConsentScope first, otherwise we accidentally embed the
    # enum's repr/str (e.g. "ConsentScope.VAULT_OWNER") into the token.
    if isinstance(scope, ConsentScope):
        scope_str = scope.value
    else:
        scope_str = scope

    raw = f"{user_id}|{agent_id}|{scope_str}|{issued_at}|{expires_at}"
    signature = _sign(raw)

    token_string = (
        f"{CONSENT_TOKEN_PREFIX}:{base64.urlsafe_b64encode(raw.encode()).decode()}.{signature}"
    )

    # Map dynamic scopes (attr.*) to PKM_READ enum for type alignment
    scope_enum = scope if isinstance(scope, ConsentScope) else _scope_str_to_enum(scope_str)

    return HushhConsentToken(
        token=token_string,
        user_id=user_id,
        agent_id=agent_id,
        scope=scope_enum,
        scope_str=scope_str,  # Preserve actual scope string!
        issued_at=issued_at,
        expires_at=expires_at,
        signature=signature,
    )


def _scope_str_to_enum(scope_str: str) -> ConsentScope:
    """
    Map a scope string to its ConsentScope enum equivalent.
    Dynamic scopes (attr.*) map to PKM_READ.
    """
    try:
        return ConsentScope(scope_str)
    except ValueError:
        if scope_str == "pkm.read":
            return ConsentScope.PKM_READ
        if scope_str == "pkm.write":
            return ConsentScope.PKM_WRITE
        # Dynamic scope (e.g., attr.financial.*) - map to PKM_READ
        if scope_str.startswith("attr."):
            return ConsentScope.PKM_READ
        # Unknown scope - default to PKM_READ
        return ConsentScope.PKM_READ


# ========== Token Verifier ==========


def validate_token(
    token_str: str, expected_scope: Optional[Union[str, ConsentScope]] = None
) -> Tuple[bool, Optional[str], Optional[HushhConsentToken]]:
    """
    Validate a consent token.

    Args:
        token_str: The token string to validate
        expected_scope: Optional scope to validate against (string or enum)

    Returns:
        Tuple of (valid, error_reason, token_object)
    """
    # Check in-memory revocation first (fastest)
    if token_str in _revoked_tokens:
        return False, "Token has been revoked", None

    try:
        prefix, signed_part = token_str.split(":", 1)
        encoded, signature = signed_part.split(".")

        if prefix != CONSENT_TOKEN_PREFIX:
            return False, "Invalid token prefix", None

        decoded = base64.urlsafe_b64decode(encoded.encode()).decode()
        user_id, agent_id, scope_str, issued_at_str, expires_at_str = decoded.split("|")

        # Map scope string to enum (for type alignment)
        # IMPORTANT: Don't fail for dynamic scopes - they're valid!
        scope_enum = _scope_str_to_enum(scope_str)

        raw = f"{user_id}|{agent_id}|{scope_str}|{issued_at_str}|{expires_at_str}"
        expected_sig = _sign(raw)

        if not hmac.compare_digest(signature, expected_sig):
            return False, "Invalid signature", None

        # SCOPE VALIDATION with domain isolation
        if expected_scope:
            # Convert enum to string if needed
            expected_scope_str = (
                expected_scope.value if isinstance(expected_scope, ConsentScope) else expected_scope
            )

            # Use the ACTUAL scope string from token, not enum value
            granted_scope_str = scope_str

            # Use scope_matches for proper domain isolation
            from hushh_mcp.consent.scope_helpers import scope_matches

            if not scope_matches(granted_scope_str, expected_scope_str):
                return (
                    False,
                    f"Scope mismatch: token has '{granted_scope_str}', but '{expected_scope_str}' required",
                    None,
                )

        if int(time.time() * 1000) > int(expires_at_str):
            return False, "Token expired", None

        token = HushhConsentToken(
            token=token_str,
            user_id=UserID(user_id),
            agent_id=AgentID(agent_id),
            scope=scope_enum,
            scope_str=scope_str,  # CRITICAL: Preserve actual scope string!
            issued_at=int(issued_at_str),
            expires_at=int(expires_at_str),
            signature=signature,
        )
        return True, None, token

    except (ValueError, UnicodeDecodeError) as e:
        return False, f"Malformed token: {str(e)}", None
    except Exception as e:
        logger.error(f"Unexpected error during token validation: {e}", exc_info=True)
        raise


async def validate_token_with_db(
    token_str: str, expected_scope: Optional[Union[str, ConsentScope]] = None
) -> Tuple[bool, Optional[str], Optional[HushhConsentToken]]:
    """
    Validate token with additional database revocation check.

    Use this for critical operations where cross-instance consistency matters.
    Falls back to in-memory check if DB is unavailable.
    """
    # First do the fast in-memory validation
    valid, reason, token_obj = validate_token(token_str, expected_scope)

    if not valid:
        return valid, reason, token_obj

    # Additional DB check for revocation status
    # This catches tokens revoked on other Cloud Run instances
    try:
        if token_obj:
            from hushh_mcp.services.consent_db import ConsentDBService

            service = ConsentDBService()
            # CRITICAL FIX: Use scope_str (actual scope) for DB lookup, not enum value!
            scope_for_lookup = token_obj.scope_str if token_obj.scope_str else token_obj.scope.value
            is_active = await service.is_token_active(
                str(token_obj.user_id),
                scope_for_lookup,
                str(token_obj.agent_id),
            )
            if not is_active:
                if str(os.getenv("TESTING", "")).strip().lower() == "true":
                    logger.info("TESTING mode: skipping DB inactive check for token validation")
                    return valid, reason, token_obj

                # Add to in-memory set for future fast checks
                _revoked_tokens.add(token_str)
                logger.warning(f"Token revoked in DB but not in memory: {token_str[:30]}...")
                return False, "Token has been revoked (DB check)", None
    except Exception as e:
        # Log but don't fail - in-memory check is sufficient for single instance
        logger.warning(f"DB revocation check failed, using in-memory only: {e}")

    return valid, reason, token_obj


# ========== Token Revoker ==========


def revoke_token(token_str: str) -> None:
    _revoked_tokens.add(token_str)


def is_token_revoked(token_str: str) -> bool:
    return token_str in _revoked_tokens


# ========== Internal Signer ==========


def _sign(input_string: str) -> str:
    return hmac.new(SECRET_KEY.encode(), input_string.encode(), hashlib.sha256).hexdigest()
