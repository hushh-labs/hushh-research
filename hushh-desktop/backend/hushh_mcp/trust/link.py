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
) -> TrustLink:
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
    return hmac.new(APP_SIGNING_KEY.encode(), input_string.encode(), hashlib.sha256).hexdigest()
