"""
Trust-boundary proof for session_id field addition to TrustLink.
Exercises the sensitive trust-boundary surface behavior at the changed path.
Attach point: consent-protocol/hushh_mcp/types.py (TrustLink.session_id)
"""
from __future__ import annotations

from hushh_mcp.constants import ConsentScope
from hushh_mcp.trust.link import create_trust_link, verify_trust_link
from hushh_mcp.types import TrustLink

_DELEGATOR = "agent_identity"
_DELEGATEE = "agent_shopper"
_USER = "user_nyx"
_SCOPE = ConsentScope.PKM_READ


def test_session_id_field_exists_with_empty_default():
    link = create_trust_link(_DELEGATOR, _DELEGATEE, _SCOPE, _USER)
    assert hasattr(link, "session_id")
    assert link.session_id == ""


def test_session_id_preserved_when_set():
    link = create_trust_link(_DELEGATOR, _DELEGATEE, _SCOPE, _USER)
    bound = link.model_copy(update={"session_id": "stream-abc-123"})
    assert bound.session_id == "stream-abc-123"


def test_backward_compat_trustlink_without_session_id():
    data = {
        "from_agent": _DELEGATOR,
        "to_agent": _DELEGATEE,
        "scope": _SCOPE,
        "signed_by_user": _USER,
        "expires_at": 9999999999999,
        "signature": "dummy",
    }
    link = TrustLink(**data)
    assert link.session_id == ""


def test_trust_link_verify_still_works_with_session_id_present():
    link = create_trust_link(_DELEGATOR, _DELEGATEE, _SCOPE, _USER)
    assert verify_trust_link(link) is True
