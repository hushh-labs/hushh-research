# hushh_mcp/trust/link.py

import hashlib
import hmac
import time

from hushh_mcp.config import DEFAULT_TRUST_LINK_EXPIRY_MS, SECRET_KEY
from hushh_mcp.types import AgentID, ConsentScope, TrustLink, UserID

# ========== TrustLink Creator ==========


def _validate_trust_link_inputs(
    from_agent: AgentID,
    to_agent: AgentID,
    scope: ConsentScope,
    signed_by_user: UserID,
    expires_in_ms: int,
) -> None:
    """Validate trust link inputs before creation.

    Raises ValueError for invalid or dangerous inputs.
    """
    if not from_agent or not str(from_agent).strip():
        raise ValueError("from_agent must be a non-empty string")
    if not to_agent or not str(to_agent).strip():
        raise ValueError("to_agent must be a non-empty string")
    if not isinstance(scope, ConsentScope):
        raise ValueError("scope must be a ConsentScope enum value")
    if not signed_by_user or not str(signed_by_user).strip():
        raise ValueError("signed_by_user must be a non-empty string")
    if not isinstance(expires_in_ms, int) or expires_in_ms <= 0:
        raise ValueError("expires_in_ms must be a positive integer")
    # Reject pipe characters to prevent signature format injection
    for field_name, value in [
        ("from_agent", str(from_agent)),
        ("to_agent", str(to_agent)),
        ("signed_by_user", str(signed_by_user)),
    ]:
        if "|" in value:
            raise ValueError(f"{field_name} must not contain pipe character '|'")


def create_trust_link(
    from_agent: AgentID,
    to_agent: AgentID,
    scope: ConsentScope,
    signed_by_user: UserID,
    expires_in_ms: int = DEFAULT_TRUST_LINK_EXPIRY_MS,
) -> TrustLink:
    _validate_trust_link_inputs(from_agent, to_agent, scope, signed_by_user, expires_in_ms)
    created_at = int(time.time() * 1000)
    expires_at = created_at + expires_in_ms

    raw = f"{from_agent}|{to_agent}|{scope}|{created_at}|{expires_at}|{signed_by_user}"
    signature = _sign(raw)

    return TrustLink(
        from_agent=from_agent,
        to_agent=to_agent,
        scope=scope,
        created_at=created_at,
        expires_at=expires_at,
        signed_by_user=signed_by_user,
        signature=signature,
    )


# ========== TrustLink Verifier ==========


def verify_trust_link(link: TrustLink) -> bool:
    now = int(time.time() * 1000)
    if now > link.expires_at:
        return False

    raw = f"{link.from_agent}|{link.to_agent}|{link.scope}|{link.created_at}|{link.expires_at}|{link.signed_by_user}"
    expected_sig = _sign(raw)

    return hmac.compare_digest(link.signature, expected_sig)


# ========== Scope Validator ==========


def is_trusted_for_scope(link: TrustLink, required_scope: ConsentScope) -> bool:
    return link.scope == required_scope and verify_trust_link(link)


# ========== Internal Signer ==========


def _sign(input_string: str) -> str:
    return hmac.new(SECRET_KEY.encode(), input_string.encode(), hashlib.sha256).hexdigest()
