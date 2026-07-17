"""
TrustLink session-binding tests.

Verifies two properties:

1. session_id is included in the HMAC input, so altering session_id on a
   captured link breaks the signature.

2. verify_trust_link and is_trusted_for_scope accept an expected_session_id
   from the server, so a legitimately signed TrustLink (valid signature, valid
   session_id) cannot be replayed in a different active session, even though
   its own HMAC is still intact.

Issue: #1426
"""

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


# ===========================================================================
# Backward compatibility: empty session_id still round-trips correctly
# ===========================================================================


def test_no_session_id_round_trips() -> None:
    link = create_trust_link(_FROM, _TO, _SCOPE, _USER)
    assert link.session_id == ""
    assert verify_trust_link(link) is True


def test_no_session_id_scope_check_passes() -> None:
    link = create_trust_link(_FROM, _TO, _SCOPE, _USER)
    assert is_trusted_for_scope(link, _SCOPE) is True


# ===========================================================================
# Session binding (HMAC integrity): altered session_id breaks signature
# ===========================================================================


def test_session_id_round_trips() -> None:
    link = create_trust_link(_FROM, _TO, _SCOPE, _USER, session_id=_SESSION_A)
    assert link.session_id == _SESSION_A
    assert verify_trust_link(link) is True


def test_different_session_id_fails_verification() -> None:
    """Mutating session_id breaks the HMAC: tamper-detection."""
    link = create_trust_link(_FROM, _TO, _SCOPE, _USER, session_id=_SESSION_A)
    replayed = link.model_copy(update={"session_id": _SESSION_B})
    assert verify_trust_link(replayed) is False


def test_empty_session_id_fails_against_bound_link() -> None:
    """Stripping session_id also breaks the HMAC."""
    link = create_trust_link(_FROM, _TO, _SCOPE, _USER, session_id=_SESSION_A)
    stripped = link.model_copy(update={"session_id": ""})
    assert verify_trust_link(stripped) is False


def test_session_bound_link_fails_when_session_stripped_via_scope_check() -> None:
    link = create_trust_link(_FROM, _TO, _SCOPE, _USER, session_id=_SESSION_A)
    assert is_trusted_for_scope(link.model_copy(update={"session_id": _SESSION_B}), _SCOPE) is False


# ===========================================================================
# Cross-session replay: valid HMAC, but wrong active session (the real attack)
#
# These tests cover the vulnerability the reviewer flagged: an adversary who
# captures a legitimate TrustLink for session A (valid signature, valid
# session_id) and attempts to use it on a server that is now in session B.
# The HMAC is still intact, so tamper-detection alone would let it pass.
# Only the expected_session_id comparison stops the replay.
# ===========================================================================


def test_cross_session_replay_rejected_by_expected_session_id() -> None:
    """Full cross-session replay with intact HMAC must fail when server passes expected_session_id."""
    # Attacker captures this link during session A; signature is valid.
    link_session_a = create_trust_link(_FROM, _TO, _SCOPE, _USER, session_id=_SESSION_A)
    assert verify_trust_link(link_session_a) is True  # HMAC is intact

    # Server is now running session B and passes expected_session_id=_SESSION_B.
    # The link is valid in isolation but must be rejected.
    assert verify_trust_link(link_session_a, expected_session_id=_SESSION_B) is False


def test_cross_session_replay_rejected_via_scope_check() -> None:
    """is_trusted_for_scope propagates expected_session_id and rejects cross-session replay."""
    link_session_a = create_trust_link(_FROM, _TO, _SCOPE, _USER, session_id=_SESSION_A)
    assert is_trusted_for_scope(link_session_a, _SCOPE) is True  # passes without context

    # Session B rejects the same link.
    assert (
        is_trusted_for_scope(link_session_a, _SCOPE, expected_session_id=_SESSION_B) is False
    )


def test_same_session_verify_succeeds_with_expected_session_id() -> None:
    """Providing the correct expected_session_id does not break legitimate verification."""
    link = create_trust_link(_FROM, _TO, _SCOPE, _USER, session_id=_SESSION_A)
    assert verify_trust_link(link, expected_session_id=_SESSION_A) is True


def test_same_session_scope_check_succeeds_with_expected_session_id() -> None:
    link = create_trust_link(_FROM, _TO, _SCOPE, _USER, session_id=_SESSION_A)
    assert is_trusted_for_scope(link, _SCOPE, expected_session_id=_SESSION_A) is True


def test_none_expected_session_id_bypasses_check_for_unbound_surfaces() -> None:
    """Passing None skips the session check: backward-compatible default."""
    link = create_trust_link(_FROM, _TO, _SCOPE, _USER, session_id=_SESSION_A)
    assert verify_trust_link(link, expected_session_id=None) is True


def test_empty_expected_session_id_rejects_session_bound_link() -> None:
    """Passing an empty string as expected_session_id rejects a session-bound link."""
    link = create_trust_link(_FROM, _TO, _SCOPE, _USER, session_id=_SESSION_A)
    assert verify_trust_link(link, expected_session_id="") is False


def test_unbound_link_accepted_when_expected_matches_empty() -> None:
    """An unbound link (session_id='') passes when the server also expects ''."""
    link = create_trust_link(_FROM, _TO, _SCOPE, _USER)
    assert verify_trust_link(link, expected_session_id="") is True


# ===========================================================================
# HMAC uniqueness: same fields, different session_id -> different signature
# ===========================================================================


def test_different_sessions_produce_different_signatures() -> None:
    link_a = create_trust_link(_FROM, _TO, _SCOPE, _USER, session_id=_SESSION_A)
    link_b = create_trust_link(_FROM, _TO, _SCOPE, _USER, session_id=_SESSION_B)
    assert link_a.signature != link_b.signature


def test_session_id_vs_no_session_id_produce_different_signatures() -> None:
    link_bound = create_trust_link(_FROM, _TO, _SCOPE, _USER, session_id=_SESSION_A)
    link_unbound = create_trust_link(_FROM, _TO, _SCOPE, _USER)
    assert link_bound.signature != link_unbound.signature


# ===========================================================================
# Existing expiry and tampering tests remain unaffected
# ===========================================================================


def test_expired_link_still_fails() -> None:
    expired = create_trust_link(
        _FROM, _TO, _SCOPE, _USER, expires_in_ms=-1000, session_id=_SESSION_A
    )
    assert verify_trust_link(expired) is False


def test_expired_link_fails_even_with_matching_session() -> None:
    """Expiry check runs before session check: expired link always rejected."""
    expired = create_trust_link(
        _FROM, _TO, _SCOPE, _USER, expires_in_ms=-1000, session_id=_SESSION_A
    )
    assert verify_trust_link(expired, expected_session_id=_SESSION_A) is False


def test_signature_tampering_still_fails() -> None:
    link = create_trust_link(_FROM, _TO, _SCOPE, _USER, session_id=_SESSION_A)
    tampered = link.model_copy(update={"signature": "bad_signature_here"})
    assert verify_trust_link(tampered) is False


# ===========================================================================
# TrustLink model carries session_id
# ===========================================================================


def test_trust_link_model_stores_session_id() -> None:
    link = create_trust_link(_FROM, _TO, _SCOPE, _USER, session_id=_SESSION_A)
    assert isinstance(link, TrustLink)
    assert link.session_id == _SESSION_A


def test_trust_link_model_default_session_id_is_empty() -> None:
    link = create_trust_link(_FROM, _TO, _SCOPE, _USER)
    assert isinstance(link, TrustLink)
    assert link.session_id == ""
