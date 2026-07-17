# tests/test_delegate_trust_link_callsite_session_binding.py
"""
Callsite-level proof that the delegate_to_agent production handler enforces
TrustLink session binding.

# Scope
The library-level properties (HMAC integrity, expected_session_id comparison)
are verified by test_trust_link_session_binding.py. This file targets the
production handler (handle_delegate in mcp_modules/tools/utility_tools.py) and
proves two additional properties required by the reviewer:

1. Fail-closed on missing session_id: the handler rejects delegation requests
   that carry no session context, because without session binding any captured
   TrustLink becomes replayable across future sessions.

2. Server-side session enforcement at the verify callsite: the handler passes
   expected_session_id from the current server session context to
   verify_trust_link, so the sanity-check is also session-bound. A TrustLink
   whose embedded session_id differs from the active session context fails
   verification even though its HMAC is intact (cross-session replay rejected).

# Why callsite tests matter
The library correctly accepts expected_session_id, but callers can bypass the
protection by omitting the parameter (defaulting to None). These tests prove
that the production callsite never takes that bypass path.
"""

from __future__ import annotations

import asyncio
import json
from unittest.mock import patch

import pytest

from hushh_mcp.trust.link import create_trust_link, verify_trust_link
from mcp_modules.tools.utility_tools import handle_delegate

# ==========================================
# Constants
# ==========================================

_FROM = "agent.orchestrator"
_TO = "agent.kai"
_SCOPE_STR = "pkm.read"
_USER = "user_test_delegate"
_SESSION_A = "session_abc_111"
_SESSION_B = "session_xyz_999"

_BASE_ARGS = {
    "from_agent": _FROM,
    "to_agent": _TO,
    "scope": _SCOPE_STR,
    "user_id": _USER,
}


# ==========================================
# Helpers
# ==========================================

def _run(coro):
    return asyncio.run(coro)


def _parse_result(result: list) -> dict:
    assert len(result) == 1
    return json.loads(result[0].text)


# ==========================================
# 1. Fail-closed: missing session_id is rejected
# ==========================================

class TestDelegateFailsClosedWithoutSessionId:

    def test_missing_session_id_returns_error(self) -> None:
        """Omitting session_id must return SESSION_ID_REQUIRED, not a TrustLink."""
        args = {**_BASE_ARGS}  # no session_id key
        result = _run(handle_delegate(args))
        body = _parse_result(result)
        assert body.get("code") == "SESSION_ID_REQUIRED"
        assert body.get("status") == "rejected"
        assert "trust_link" not in body

    def test_empty_session_id_returns_error(self) -> None:
        """An explicit empty-string session_id must also be rejected."""
        args = {**_BASE_ARGS, "session_id": ""}
        result = _run(handle_delegate(args))
        body = _parse_result(result)
        assert body.get("code") == "SESSION_ID_REQUIRED"
        assert body.get("status") == "rejected"
        assert "trust_link" not in body

    def test_whitespace_only_session_id_returns_error(self) -> None:
        """A whitespace-only session_id (after stripping) must be rejected."""
        args = {**_BASE_ARGS, "session_id": "   "}
        result = _run(handle_delegate(args))
        body = _parse_result(result)
        assert body.get("code") == "SESSION_ID_REQUIRED"
        assert body.get("status") == "rejected"


# ==========================================
# 2. Happy path: valid session_id produces a verified TrustLink
# ==========================================

class TestDelegateSucceedsWithSessionId:

    def test_valid_session_id_returns_delegated_status(self) -> None:
        """A non-empty session_id must produce a delegated TrustLink response."""
        args = {**_BASE_ARGS, "session_id": _SESSION_A}
        result = _run(handle_delegate(args))
        body = _parse_result(result)
        assert body.get("status") == "delegated"
        assert "trust_link" in body

    def test_valid_session_id_produces_verified_signature(self) -> None:
        """signature_verified must be True: the callsite verifies against its own session."""
        args = {**_BASE_ARGS, "session_id": _SESSION_A}
        result = _run(handle_delegate(args))
        body = _parse_result(result)
        assert body["trust_link"]["signature_verified"] is True


# ==========================================
# 3. Callsite wires expected_session_id: verify is called with server context
# ==========================================

class TestDelegateCallsiteWiresExpectedSessionId:

    def test_verify_trust_link_called_with_expected_session_id(self) -> None:
        """
        The handler must call verify_trust_link(..., expected_session_id=session_id).

        We intercept verify_trust_link to confirm it receives the expected keyword
        argument.  The spy wraps the real function so behaviour is unchanged.
        """
        captured_kwargs: list[dict] = []

        real_verify = verify_trust_link

        def _spy_verify(link, expected_session_id=None):
            captured_kwargs.append({"expected_session_id": expected_session_id})
            return real_verify(link, expected_session_id=expected_session_id)

        args = {**_BASE_ARGS, "session_id": _SESSION_A}
        with patch("mcp_modules.tools.utility_tools.verify_trust_link", side_effect=_spy_verify):
            _run(handle_delegate(args))

        assert len(captured_kwargs) == 1, "verify_trust_link should be called exactly once"
        assert captured_kwargs[0]["expected_session_id"] == _SESSION_A, (
            f"expected_session_id was not wired from server session context; "
            f"got: {captured_kwargs[0]['expected_session_id']!r}"
        )


# ==========================================
# 4. Cross-session replay is rejected at the receiving-agent verify step
#
# This section proves the end-to-end replay scenario:
#   - Agent creates a TrustLink bound to session_A (via handle_delegate or
#     create_trust_link directly)
#   - A receiving agent in session_B verifies the link with its own session
#     context (expected_session_id=session_B)
#   - The link is rejected even though its HMAC is still valid
#
# The session context at the verify callsite comes from the SERVER, not from
# the incoming TrustLink; so an attacker cannot bypass this by replaying the
# original session_id.
# ==========================================

class TestCrossSessionReplayRejectedAtReceivingCallsite:

    def _make_session_a_link(self):
        """Simulate what handle_delegate produces for session_A."""
        from hushh_mcp.constants import ConsentScope
        from hushh_mcp.types import AgentID, UserID
        return create_trust_link(
            AgentID(_FROM),
            AgentID(_TO),
            ConsentScope.PKM_READ,
            UserID(_USER),
            session_id=_SESSION_A,
        )

    def test_session_a_link_passes_own_session_verify(self) -> None:
        """Sanity: a session_A link is valid when verified with session_A context."""
        link = self._make_session_a_link()
        assert verify_trust_link(link, expected_session_id=_SESSION_A) is True

    def test_session_a_link_rejected_when_receiving_agent_is_in_session_b(self) -> None:
        """
        Core replay proof: receiving agent in session_B uses its own session
        context as expected_session_id.  The captured session_A link is rejected
        even though the HMAC is intact.
        """
        link = self._make_session_a_link()
        # HMAC is still valid; tamper detection alone would pass this link.
        assert verify_trust_link(link) is True

        # Receiving agent supplies ITS server-derived session, not the link's.
        assert verify_trust_link(link, expected_session_id=_SESSION_B) is False, (
            "Cross-session replay was accepted: server must pass expected_session_id "
            "from its own session context, not from the TrustLink."
        )

    def test_attacker_cannot_bypass_by_supplying_original_session_id(self) -> None:
        """
        If the RECEIVING server derives expected_session_id from its own state
        (not from the incoming link), the attacker cannot replay by matching
        session_A context in a session_B environment.

        Simulated here: server_derived_session is independently set to session_B;
        the attacker-supplied link carries session_A.  Verification fails.
        """
        link = self._make_session_a_link()

        # This is what the receiving server knows from its own state.
        server_derived_session = _SESSION_B

        # Even though the attacker knows link.session_id == _SESSION_A, the
        # server does NOT use link.session_id as expected_session_id.
        assert (
            verify_trust_link(link, expected_session_id=server_derived_session) is False
        )


if __name__ == "__main__":
    pytest.main([__file__, "-v"])
