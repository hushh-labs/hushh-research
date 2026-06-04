# tests/test_validate_token_expiry_ordering.py
"""
Regression tests for the expiry-before-scope-check ordering in validate_token().

Before the fix, validate_token() checked expected_scope BEFORE checking
expiry.  An expired token with the wrong scope returned "Scope mismatch"
instead of "Token expired", leaking information about which scopes the
token held.

All tests are hermetic: no network, no DB.
"""

from __future__ import annotations

from hushh_mcp.consent.token import issue_token, validate_token
from hushh_mcp.constants import ConsentScope

# Helpers

_UID = "user_ordering_test"
_AGENT = "agent_test"


def _expired_token(scope: ConsentScope | str) -> str:
    """Issue a token that expired 1 second ago."""
    tok = issue_token(
        user_id=_UID,
        agent_id=_AGENT,
        scope=scope,
        expires_in_ms=0,  # expires immediately
    )
    return tok.token


def _live_token(scope: ConsentScope | str) -> str:
    tok = issue_token(
        user_id=_UID,
        agent_id=_AGENT,
        scope=scope,
        expires_in_ms=3_600_000,  # 1 hour
    )
    return tok.token


# Ordering tests


class TestExpiredTokenResponseOrdering:
    def test_expired_wrong_scope_returns_token_expired_not_scope_mismatch(self):
        """Expired token with wrong scope must yield 'Token expired', not scope info."""
        token = _expired_token(ConsentScope.PKM_READ)
        valid, reason, obj = validate_token(token, expected_scope=ConsentScope.VAULT_OWNER)

        assert not valid
        assert reason == "Token expired", (
            f"Expected 'Token expired' but got '{reason}'. "
            "Expiry must be checked before scope to avoid leaking scope info."
        )
        assert obj is None

    def test_expired_correct_scope_returns_token_expired(self):
        """Expired token with the matching scope also returns 'Token expired'."""
        token = _expired_token(ConsentScope.PKM_READ)
        valid, reason, obj = validate_token(token, expected_scope=ConsentScope.PKM_READ)

        assert not valid
        assert reason == "Token expired"
        assert obj is None

    def test_expired_no_scope_check_returns_token_expired(self):
        """Expired token with no scope argument returns 'Token expired'."""
        token = _expired_token(ConsentScope.PKM_READ)
        valid, reason, obj = validate_token(token)

        assert not valid
        assert reason == "Token expired"
        assert obj is None

    def test_expired_dynamic_scope_wrong_expected_returns_token_expired(self):
        """Dynamic attr.* scope on expired token: must still return 'Token expired'."""
        token = _expired_token("attr.financial.*")
        valid, reason, obj = validate_token(token, expected_scope="attr.health.*")

        assert not valid
        assert reason == "Token expired", (
            f"Got '{reason}' instead of 'Token expired' - scope check ran before expiry check."
        )

    def test_live_token_wrong_scope_returns_scope_mismatch(self):
        """Live token with wrong scope must still return a scope mismatch error."""
        token = _live_token(ConsentScope.PKM_READ)
        valid, reason, obj = validate_token(token, expected_scope=ConsentScope.VAULT_OWNER)

        assert not valid
        assert reason is not None
        assert "Scope mismatch" in reason or "scope" in reason.lower()
        assert obj is None

    def test_live_token_correct_scope_returns_valid(self):
        """Live token with matching scope must validate successfully."""
        token = _live_token(ConsentScope.PKM_READ)
        valid, reason, obj = validate_token(token, expected_scope=ConsentScope.PKM_READ)

        assert valid
        assert reason is None
        assert obj is not None
        assert str(obj.user_id) == _UID

    def test_live_token_no_scope_check_returns_valid(self):
        """Live token without scope arg must validate successfully."""
        token = _live_token(ConsentScope.AGENT_KAI_ANALYZE)
        valid, reason, obj = validate_token(token)

        assert valid
        assert obj is not None

    def test_expired_before_scope_no_information_leakage(self):
        """
        Probe with several wrong scopes against the same expired token.
        All must return 'Token expired' - never reveal the actual scope.
        """
        token = _expired_token(ConsentScope.VAULT_OWNER)
        probed_scopes = [
            ConsentScope.PKM_READ,
            ConsentScope.PKM_WRITE,
            ConsentScope.AGENT_KAI_ANALYZE,
            "attr.financial.*",
            "attr.health.*",
        ]
        for probe in probed_scopes:
            valid, reason, _ = validate_token(token, expected_scope=probe)
            assert not valid
            assert reason == "Token expired", (
                f"Probing scope {probe!r} against expired vault.owner token returned "
                f"'{reason}' instead of 'Token expired'. Scope information leaked."
            )
