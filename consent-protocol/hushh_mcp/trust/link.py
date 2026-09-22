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
    scope_str: str = "",
) -> TrustLink:
    """Sign a delegation.

    ``scope_str`` is the authority the owner actually chose. Pass it whenever
    the request carried a scope string: every dynamic ``attr.*`` scope resolves
    to the same ``PKM_READ`` enum, so without it a link for
    ``attr.food.recipes.*`` is indistinguishable from one for
    ``attr.financial.*``.
    """
    created_at = int(time.time() * 1000)
    expires_at = created_at + expires_in_ms

    raw = _signing_payload(
        from_agent=from_agent,
        to_agent=to_agent,
        scope=scope,
        created_at=created_at,
        expires_at=expires_at,
        signed_by_user=signed_by_user,
        session_id=session_id,
        scope_str=scope_str,
    )
    signature = _sign(raw)

    return TrustLink(
        from_agent=from_agent,
        to_agent=to_agent,
        scope=scope,
        scope_str=scope_str,
        created_at=created_at,
        expires_at=expires_at,
        signed_by_user=signed_by_user,
        signature=signature,
        session_id=session_id,
    )


# ========== TrustLink Verifier ==========


def verify_trust_link(link: TrustLink, expected_session_id: str | None = None) -> bool:
    """Verify a TrustLink HMAC and optionally enforce active-session binding."""
    now = int(time.time() * 1000)
    if now > link.expires_at:
        return False

    if expected_session_id is not None and link.session_id != expected_session_id:
        return False

    raw = _signing_payload(
        from_agent=link.from_agent,
        to_agent=link.to_agent,
        scope=link.scope,
        created_at=link.created_at,
        expires_at=link.expires_at,
        signed_by_user=link.signed_by_user,
        session_id=link.session_id,
        scope_str=link.scope_str,
    )
    expected_sig = _sign(raw)

    return hmac.compare_digest(link.signature, expected_sig)


# ========== Scope Validator ==========


def is_trusted_for_scope(
    link: TrustLink,
    required_scope: ConsentScope | str,
    expected_session_id: str | None = None,
) -> bool:
    """True when this link actually delegates ``required_scope``.

    A link that carries a verbatim scope is judged on that string through the
    shared ``scope_matches`` primitive, which keeps domains isolated: an
    ``attr.food.*`` delegation never satisfies ``attr.financial.holdings``.
    A legacy link without one falls back to comparing the enum, which is all
    the authority it ever recorded.
    """
    if not verify_trust_link(link, expected_session_id=expected_session_id):
        return False

    required = (
        required_scope.value if isinstance(required_scope, ConsentScope) else str(required_scope)
    )
    if link.scope_str:
        # Imported lazily: scope_helpers pulls in the dynamic scope generator,
        # and this module is imported by low-level signing paths.
        from hushh_mcp.consent.scope_helpers import scope_matches

        return scope_matches(link.scope_str, required)

    return link.scope.value == required


# ========== Internal Signer ==========


def _signing_payload(
    *,
    from_agent: AgentID,
    to_agent: AgentID,
    scope: ConsentScope,
    created_at: int,
    expires_at: int,
    signed_by_user: UserID,
    session_id: str,
    scope_str: str,
) -> str:
    """The exact bytes a link's signature covers.

    The verbatim scope is appended only when present, so a link minted before
    this field existed still hashes to its original payload and keeps
    verifying. Because the field IS signed when set, it cannot be swapped or
    stripped after the fact.
    """
    raw = f"{from_agent}|{to_agent}|{scope}|{created_at}|{expires_at}|{signed_by_user}|{session_id}"
    return f"{raw}|{scope_str}" if scope_str else raw


def _sign(input_string: str) -> str:
    return hmac.new(APP_SIGNING_KEY.encode(), input_string.encode(), hashlib.sha256).hexdigest()
