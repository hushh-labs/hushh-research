# hushh_mcp/trust/link.py

import hashlib
import hmac
import time

from hushh_mcp.config import APP_SIGNING_KEY, DEFAULT_TRUST_LINK_EXPIRY_MS
from hushh_mcp.types import AgentID, ConsentScope, TrustLink, UserID

# Domain separator for the length-prefixed payload. Keeps signatures minted
# under the two schemes in disjoint spaces.
TRUST_LINK_V2_TAG = "hushh.trustlink.v2"


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

    A link carrying a verbatim DYNAMIC scope is judged on that string through
    the shared ``scope_matches`` primitive, which keeps domains isolated: an
    ``attr.food.*`` delegation never satisfies ``attr.financial.holdings``.
    Every other link keeps the exact enum comparison it always had.
    """
    if not verify_trust_link(link, expected_session_id=expected_session_id):
        return False

    required = (
        required_scope.value if isinstance(required_scope, ConsentScope) else str(required_scope)
    )

    # Imported lazily: scope_helpers pulls in the dynamic scope generator, and
    # this module is imported by low-level signing paths.
    from hushh_mcp.consent.scope_helpers import resolve_scope_to_enum, scope_matches

    # Dynamic scopes are the only case the verbatim field exists for: they all
    # collapse to the same PKM_READ enum, so only the string can tell them
    # apart. Routing anything else through scope_matches would WIDEN it --
    # a `vault.owner` link would start delegating everything via that
    # function's master-key short circuit.
    if link.scope_str and ConsentScope.is_dynamic_scope(link.scope_str):
        return scope_matches(link.scope_str, required)

    # Resolve before comparing: callers pass a raw string, and a legacy link
    # for a dynamic scope recorded only PKM_READ. Comparing the raw string to
    # `link.scope.value` would make every such link authorize nothing.
    try:
        return link.scope == resolve_scope_to_enum(required)
    except (KeyError, ValueError):
        return False


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

    A link with no verbatim scope hashes the original pipe-joined payload, so
    links minted before that field existed keep verifying.

    A link that HAS one is length-prefixed instead. Pipe-joining alone is not
    injective: `session_id="|attr.food.*"` with no verbatim scope produces the
    same bytes as `session_id=""` with `scope_str="attr.food.*"`, so one link
    could be re-presented as the other and take the weaker legacy comparison
    path. Prefixing every field with its length makes each field's extent
    explicit, so no separator inside a value can be mistaken for a boundary.
    """
    legacy = (
        f"{from_agent}|{to_agent}|{scope}|{created_at}|{expires_at}|{signed_by_user}|{session_id}"
    )
    if not scope_str:
        return legacy
    fields = (
        str(from_agent),
        str(to_agent),
        str(scope),
        str(created_at),
        str(expires_at),
        str(signed_by_user),
        session_id,
        scope_str,
    )
    return TRUST_LINK_V2_TAG + "".join(f"|{len(field)}:{field}" for field in fields)


def _sign(input_string: str) -> str:
    return hmac.new(APP_SIGNING_KEY.encode(), input_string.encode(), hashlib.sha256).hexdigest()
