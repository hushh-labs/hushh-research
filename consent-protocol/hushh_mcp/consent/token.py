# hushh_mcp/consent/token.py

import base64
import binascii
import hashlib
import hmac
import logging
import threading
import time
from typing import Optional, Tuple, Union

from hushh_mcp.config import APP_SIGNING_KEY, DEFAULT_CONSENT_TOKEN_EXPIRY_MS
from hushh_mcp.constants import CONSENT_TOKEN_PREFIX, ConsentScope
from hushh_mcp.types import AgentID, HushhConsentToken, UserID

logger = logging.getLogger(__name__)

# ========== Internal Revocation Registry ==========


class _BoundedRevocationCache:
    """Thread-safe in-memory revocation cache with expiry-based eviction.

    Entries are kept until one hour after the token's embedded expiry. Because
    validate_token() rejects expired tokens, dropping expired revocation markers
    does not make an expired token usable again. Unexpired revocations are not
    evicted for size pressure: local revocation must stay strict even if the DB
    is temporarily unavailable.
    """

    _EXPIRED_TOKEN_GRACE_MS: int = 60 * 60 * 1000
    _MALFORMED_TOKEN_TTL_MS: int = DEFAULT_CONSENT_TOKEN_EXPIRY_MS + _EXPIRED_TOKEN_GRACE_MS
    _MAX_SIZE: int = 100_000

    def __init__(self) -> None:
        self._entries: dict[str, int] = {}  # token_str -> evict_after_ms
        self._lock = threading.Lock()

    # ------------------------------------------------------------------
    # Public interface — drop-in replacement for set[str]
    # ------------------------------------------------------------------

    def add(self, token_str: str) -> None:
        now_ms = int(time.time() * 1000)
        with self._lock:
            self._evict_expired_locked(now_ms)
            if len(self._entries) >= self._MAX_SIZE:
                logger.warning(
                    "revocation_cache.size_cap_exceeded size=%s max_size=%s",
                    len(self._entries),
                    self._MAX_SIZE,
                )
            self._entries[token_str] = self._evict_after_ms(token_str, now_ms)

    def __contains__(self, token_str: object) -> bool:
        if not isinstance(token_str, str):
            return False
        now_ms = int(time.time() * 1000)
        with self._lock:
            evict_after_ms = self._entries.get(token_str)
            if evict_after_ms is None:
                return False
            if now_ms >= evict_after_ms:
                # Safe to evict: the token's own expiry has passed with grace.
                del self._entries[token_str]
                return False
            return True

    def __len__(self) -> int:
        with self._lock:
            return len(self._entries)

    def clear(self) -> None:
        with self._lock:
            self._entries.clear()

    # ------------------------------------------------------------------
    # Internal helpers
    # ------------------------------------------------------------------

    def _evict_expired_locked(self, now_ms: int) -> int:
        """Remove TTL-expired entries.  Caller must hold self._lock."""
        expired = [k for k, evict_after_ms in self._entries.items() if evict_after_ms <= now_ms]
        for k in expired:
            del self._entries[k]
        return len(expired)

    def _evict_after_ms(self, token_str: str, now_ms: int) -> int:
        try:
            _prefix, signed_part = token_str.split(":", 1)
            encoded, _signature = signed_part.split(".", 1)
            decoded = base64.urlsafe_b64decode(encoded.encode()).decode()
            parts = decoded.split("|")
            if len(parts) in {5, 6}:
                return int(parts[4]) + self._EXPIRED_TOKEN_GRACE_MS
        except Exception:
            logger.debug("revocation_cache.expiry_parse_failed", exc_info=True)
        return now_ms + self._MALFORMED_TOKEN_TTL_MS


# In-memory cache for fast revocation checks (immediate effect).
# Also persisted to DB for cross-instance consistency.
_revoked_tokens: _BoundedRevocationCache = _BoundedRevocationCache()
_verifier_prewarm_lock = threading.Lock()
_verifier_prewarmed = False

# ========== Token Generator ==========


def issue_token(
    user_id: UserID,
    agent_id: AgentID,
    scope: Union[str, ConsentScope],
    expires_in_ms: int = DEFAULT_CONSENT_TOKEN_EXPIRY_MS,
    commercial: bool = False,
) -> HushhConsentToken:
    """
    Issue a consent token with the given scope.

    CRITICAL: Scope can be a string (e.g., 'attr.financial.*') or ConsentScope enum.
    When a string is provided, it's preserved exactly in the token to maintain domain isolation.
    This ensures 'attr.financial.*' tokens can ONLY access financial data, not all attr.* domains.

    The optional `commercial` flag (issue #30) records whether this consent
    authorizes monetized/commercial agent usage. The flag is part of the
    signed payload so it cannot be tampered with after issuance. Tokens
    issued without the flag are non-commercial by default, which preserves
    backward compatibility with previously issued tokens.
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

    # Non-commercial tokens use the original 5-field signed payload so
    # previously issued tokens still validate. Commercial tokens append
    # a sixth field which is part of the signed bytes (so it cannot be
    # tampered with after issuance).
    if commercial:
        raw = f"{user_id}|{agent_id}|{scope_str}|{issued_at}|{expires_at}|commercial"
    else:
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
        commercial=commercial,
    )


def _scope_str_to_enum(scope_str: str) -> ConsentScope:
    """
    Map a scope string to its ConsentScope enum equivalent.
    Dynamic scopes (attr.*) map to PKM_READ.
    Unknown static scopes are rejected instead of silently escalating to PKM_READ.
    """
    try:
        return ConsentScope(scope_str)
    except ValueError:
        # Dynamic scope (e.g., attr.financial.*) - map to PKM_READ
        if scope_str.startswith("attr."):
            return ConsentScope.PKM_READ
        raise


# ========== Token Verifier ==========


def validate_token(
    token_str: str,
    expected_scope: Optional[Union[str, ConsentScope]] = None,
    *,
    require_commercial: Optional[bool] = None,
) -> Tuple[bool, Optional[str], Optional[HushhConsentToken]]:
    """
    Validate a consent token.

    Args:
        token_str: The token string to validate
        expected_scope: Optional scope to validate against (string or enum)
        require_commercial: Optional gate for the commercial flag (issue #30).
            - None (default) accepts both commercial and non-commercial tokens.
            - True requires the token to authorize commercial usage.
            - False requires the token to be non-commercial.

    Returns:
        Tuple of (valid, error_reason, token_object)
    """
    # Check in-memory revocation first (fastest)
    if token_str in _revoked_tokens:
        return False, "Token has been revoked", None

    try:
        prefix, signed_part = token_str.split(":", 1)
        if "." not in signed_part:
            return False, "Malformed token", None
        encoded, signature = signed_part.split(".", 1)

        if prefix != CONSENT_TOKEN_PREFIX:
            return False, "Invalid token prefix", None

        decoded = base64.urlsafe_b64decode(encoded.encode()).decode()
        parts = decoded.split("|")

        # Backward-compatible payload parsing.
        # 5 parts = legacy non-commercial token. 6 parts = commercial token
        # whose final field is the literal "commercial".
        if len(parts) == 5:
            user_id, agent_id, scope_str, issued_at_str, expires_at_str = parts
            commercial = False
        elif len(parts) == 6 and parts[5] == "commercial":
            user_id, agent_id, scope_str, issued_at_str, expires_at_str, _ = parts
            commercial = True
        else:
            return False, "Malformed token", None

        # Map scope string to enum (for type alignment)
        # IMPORTANT: Don't fail for dynamic scopes - they're valid!
        scope_enum = _scope_str_to_enum(scope_str)

        if commercial:
            raw = f"{user_id}|{agent_id}|{scope_str}|{issued_at_str}|{expires_at_str}|commercial"
        else:
            raw = f"{user_id}|{agent_id}|{scope_str}|{issued_at_str}|{expires_at_str}"
        expected_sig = _sign(raw)

        if not hmac.compare_digest(signature, expected_sig):
            return False, "Invalid signature", None

        # Check expiry BEFORE scope so that an expired token with the wrong
        # scope returns "Token expired" rather than "Scope mismatch".
        # Returning scope information for an expired token leaks which scopes
        # the token held to a caller who should only learn it is expired.
        if int(time.time() * 1000) >= int(expires_at_str):
            return False, "Token expired", None

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

        # Commercial-flag gate (issue #30).
        if require_commercial is True and not commercial:
            return False, "Commercial consent required for this operation", None
        if require_commercial is False and commercial:
            return False, "Non-commercial consent required for this operation", None

        token = HushhConsentToken(
            token=token_str,
            user_id=UserID(user_id),
            agent_id=AgentID(agent_id),
            scope=scope_enum,
            scope_str=scope_str,  # CRITICAL: Preserve actual scope string!
            issued_at=int(issued_at_str),
            expires_at=int(expires_at_str),
            signature=signature,
            commercial=commercial,
        )
        return True, None, token

    except (ValueError, UnicodeDecodeError, binascii.Error) as e:
        return False, f"Malformed token: {str(e)}", None
    except Exception as e:
        logger.error("Unexpected error during token validation: %s", e, exc_info=True)
        raise


def prewarm_consent_token_verifier() -> None:
    """Exercise the hot consent-token verification path during process startup.

    validate_token() intentionally imports scope matching lazily so most token
    checks avoid loading scope helpers until they need scope enforcement.  That
    lazy import shows up on the first real scoped consent request after a backend
    restart.  This synthetic, in-memory round trip moves that import and the HMAC
    verifier setup into startup without requiring a database connection.
    """
    global _verifier_prewarmed

    if _verifier_prewarmed:
        return

    with _verifier_prewarm_lock:
        if _verifier_prewarmed:
            return

        token = issue_token(
            UserID("__startup_prewarm_user__"),
            AgentID("__startup_prewarm_agent__"),
            "attr.startup.*",
            expires_in_ms=60_000,
        )
        valid, reason, parsed = validate_token(token.token, expected_scope="attr.startup.health")
        if not valid or parsed is None:
            raise RuntimeError(f"Consent-token verifier prewarm failed: {reason}")

        _verifier_prewarmed = True


async def validate_token_with_db(
    token_str: str,
    expected_scope: Optional[Union[str, ConsentScope]] = None,
    *,
    require_commercial: Optional[bool] = None,
) -> Tuple[bool, Optional[str], Optional[HushhConsentToken]]:
    """
    Validate token with additional database revocation check.

    Use this for critical operations where cross-instance consistency matters.
    Falls back to in-memory check if DB is unavailable.
    """
    # First do the fast in-memory validation
    valid, reason, token_obj = validate_token(
        token_str,
        expected_scope,
        require_commercial=require_commercial,
    )

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
                # Add to in-memory set for future fast checks
                _revoked_tokens.add(token_str)
                logger.warning("Token revoked in DB but not in memory (fingerprint=%s)", _token_fingerprint(token_str))
                return False, "Token has been revoked (DB check)", None
    except Exception as e:
        # DB is unreachable — apply fail-closed policy based on token scope.
        # VAULT_OWNER tokens get a short grace period to avoid locking users
        # out of their own vault during brief DB hiccups.
        # All other scoped tokens fail closed immediately — when revocation
        # status cannot be confirmed, access to third-party data is denied.
        is_vault_owner = token_obj is not None and (
            token_obj.scope_str == "vault.owner" or token_obj.scope == ConsentScope.VAULT_OWNER
        )
        if is_vault_owner:
            logger.warning(
                "DB revocation check failed for VAULT_OWNER token, "
                "applying grace period fallback: %s",
                e,
            )
            return valid, reason, token_obj

        logger.error(
            "DB revocation check failed for scoped token, "
            "failing closed to protect consent integrity: %s",
            e,
        )
        return False, "Token revocation status could not be confirmed (DB unavailable)", None

    return valid, reason, token_obj


# ========== Token Revoker ==========


def revoke_token(token_str: str) -> None:
    _revoked_tokens.add(token_str)


def is_token_revoked(token_str: str) -> bool:
    return token_str in _revoked_tokens


# ========== Internal Signer ==========


def _token_fingerprint(token_str: str) -> str:
    """Return a short SHA-256 fingerprint of a token for safe log messages."""
    return hashlib.sha256(token_str.encode()).hexdigest()[:12]


def _sign(input_string: str) -> str:
    return hmac.new(APP_SIGNING_KEY.encode(), input_string.encode(), hashlib.sha256).hexdigest()
