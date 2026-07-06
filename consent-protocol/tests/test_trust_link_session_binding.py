"""TrustLink session-binding regression tests."""

from __future__ import annotations

from hushh_mcp.constants import ConsentScope
from hushh_mcp.trust.link import create_trust_link, is_trusted_for_scope, verify_trust_link
from hushh_mcp.types import TrustLink

_USER = "user_test"
_FROM = "agent_orchestrator"
_TO = "agent_food"
_SCOPE = ConsentScope.PKM_READ
_SESSION_A = "sse_session_abc123"
_SESSION_B = "sse_session_xyz789"


def test_no_session_id_round_trips() -> None:
    link = create_trust_link(_FROM, _TO, _SCOPE, _USER)

    assert isinstance(link, TrustLink)
    assert link.session_id == ""
    assert verify_trust_link(link) is True
    assert is_trusted_for_scope(link, _SCOPE) is True


def test_session_id_is_hmac_bound() -> None:
    link = create_trust_link(_FROM, _TO, _SCOPE, _USER, session_id=_SESSION_A)

    assert link.session_id == _SESSION_A
    assert verify_trust_link(link) is True
    assert verify_trust_link(link.model_copy(update={"session_id": _SESSION_B})) is False
    assert verify_trust_link(link.model_copy(update={"session_id": ""})) is False


def test_cross_session_replay_is_rejected() -> None:
    link = create_trust_link(_FROM, _TO, _SCOPE, _USER, session_id=_SESSION_A)

    assert verify_trust_link(link) is True
    assert verify_trust_link(link, expected_session_id=_SESSION_A) is True
    assert verify_trust_link(link, expected_session_id=_SESSION_B) is False
    assert is_trusted_for_scope(link, _SCOPE, expected_session_id=_SESSION_B) is False


def test_empty_expected_session_rejects_bound_link() -> None:
    link = create_trust_link(_FROM, _TO, _SCOPE, _USER, session_id=_SESSION_A)

    assert verify_trust_link(link, expected_session_id="") is False


def test_different_sessions_produce_different_signatures() -> None:
    link_a = create_trust_link(_FROM, _TO, _SCOPE, _USER, session_id=_SESSION_A)
    link_b = create_trust_link(_FROM, _TO, _SCOPE, _USER, session_id=_SESSION_B)
    link_unbound = create_trust_link(_FROM, _TO, _SCOPE, _USER)

    assert link_a.signature != link_b.signature
    assert link_a.signature != link_unbound.signature
