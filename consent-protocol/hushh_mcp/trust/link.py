# hushh_mcp/trust/link.py

import hashlib
import hmac
import time

from hushh_mcp.config import APP_SIGNING_KEY, DEFAULT_TRUST_LINK_EXPIRY_MS
from hushh_mcp.types import AgentID, ConsentScope, TrustLink, UserID

# ========== TrustLink Creator ==========


def create_trust_link(
    from_agent: AgentID,
    to_agent: AgentID,
    scope: ConsentScope,
    signed_by_user: UserID,
    expires_in_ms: int = DEFAULT_TRUST_LINK_EXPIRY_MS,
    session_id: str = "",
) -> TrustLink:
    created_at = int(time.time() * 1000)
    expires_at = created_at + expires_in_ms

    raw = f"{from_agent}|{to_agent}|{scope}|{created_at}|{expires_at}|{signed_by_user}|{session_id}"
    signature = _sign(raw)

    return TrustLink(
        from_agent=from_agent,
        to_agent=to_agent,
        scope=scope,
        created_at=created_at,
        expires_at=expires_at,
        signed_by_user=signed_by_user,
        signature=signature,
        session_id=session_id,
    )


# ========== TrustLink Verifier ==========


def verify_trust_link(link: TrustLink, expected_session_id: str | None = None) -> bool:
    """Verify a TrustLink's HMAC signature and optionally enforce session binding.

    Args:
        link: The TrustLink to verify.
        expected_session_id: The server-derived session context for the current
            request. When provided (and non-empty), the link is rejected unless
            ``link.session_id`` matches exactly. Pass this on every session-bound
            surface to prevent cross-session replay of captured TrustLinks.

    Returns:
        True only when the link is unexpired, the HMAC is valid, and (if
        ``expected_session_id`` is supplied) the session IDs match.
    """
    now = int(time.time() * 1000)
    if now > link.expires_at:
        return False

    # Server-side session enforcement: reject if caller supplied a session
    # context that differs from the one embedded in the link. This prevents
    # an attacker from replaying a legitimately signed TrustLink (with a
    # valid session_id and valid signature) across a different session.
    if expected_session_id is not None and link.session_id != expected_session_id:
        return False

    raw = f"{link.from_agent}|{link.to_agent}|{link.scope}|{link.created_at}|{link.expires_at}|{link.signed_by_user}|{link.session_id}"
    expected_sig = _sign(raw)

    return hmac.compare_digest(link.signature, expected_sig)


# ========== Scope Validator ==========


def is_trusted_for_scope(
    link: TrustLink,
    required_scope: ConsentScope,
    expected_session_id: str | None = None,
) -> bool:
    """Return True when the link covers ``required_scope`` and passes verification.

    Args:
        link: The TrustLink to check.
        required_scope: The scope that must be present on the link.
        expected_session_id: Forwarded to ``verify_trust_link``; see its
            docstring for semantics. Pass the server-derived session context
            on session-bound surfaces.
    """
    return link.scope == required_scope and verify_trust_link(
        link, expected_session_id=expected_session_id
    )


# ========== Internal Signer ==========


def _sign(input_string: str) -> str:
    return hmac.new(APP_SIGNING_KEY.encode(), input_string.encode(), hashlib.sha256).hexdigest()
