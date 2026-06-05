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

import base64
import time

from hushh_mcp.consent.token import _sign, issue_token, validate_token
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


# ---------------------------------------------------------------------------
# Helpers for the timestamp-rejection suite below
# ---------------------------------------------------------------------------

def _expired_by(elapsed_ms: int, scope: ConsentScope | str = ConsentScope.PKM_READ) -> str:
    """Issue a properly-signed token that already expired `elapsed_ms` ago."""
    return issue_token(
        user_id=_UID,
        agent_id=_AGENT,
        scope=scope,
        expires_in_ms=-elapsed_ms,
    ).token


def _crafted_token(issued_at_ms: int, expires_at_ms: int, scope_str: str = "pkm.read") -> str:
    """
    Build a cryptographically-valid token with explicit issued_at / expires_at
    values regardless of the current wall clock.  Uses the production _sign()
    function so the HMAC check passes and only the expiry check gates rejection.
    """
    raw = f"{_UID}|{_AGENT}|{scope_str}|{issued_at_ms}|{expires_at_ms}"
    signature = _sign(raw)
    encoded = base64.urlsafe_b64encode(raw.encode()).decode()
    return f"HCT:{encoded}.{signature}"


# ---------------------------------------------------------------------------
# Expired timestamp rejection — signature validation module test expansion
#
# Contracts under test (all hermetic — no network, no DB):
#   A. Far-past expirations (various amounts) are always rejected.
#   B. Zero-validity window (issued_at == expires_at) is always expired.
#   C. All ConsentScope values produce equivalent expiry rejection (no bypass).
#   D. Clock-skewed payloads — future issued_at with past expires_at — are
#      rejected by validate_token() because the expiry check uses the SERVER
#      clock, not the client's claimed issued_at.
#   E. No scope information is ever leaked when a timestamp is expired,
#      regardless of expiry age or which wrong scope is probed.
# ---------------------------------------------------------------------------


class TestExpiredTimestampRejection:
    """
    Verify that validate_token() immediately flags and rejects consent payloads
    whose expires_at timestamp is in the past, including far-past expirations
    and clock-skewed blocks where the client sets issued_at far in the future
    but the server-side expires_at has already elapsed.
    """

    # ── A: Far-past expirations ───────────────────────────────────────────────

    def test_token_expired_one_millisecond_ago_is_rejected(self):
        """Minimum observable expiry gap (1 ms) must trigger rejection."""
        token = _expired_by(1)
        valid, reason, obj = validate_token(token)

        assert not valid
        assert reason == "Token expired"
        assert obj is None

    def test_token_expired_one_hour_ago_is_rejected(self):
        """Standard short-lived token that has lapsed by one hour."""
        token = _expired_by(3_600_000)
        valid, reason, obj = validate_token(token)

        assert not valid
        assert reason == "Token expired"
        assert obj is None

    def test_token_expired_24_hours_ago_is_rejected(self):
        """A day-old expired token must be rejected without any scope check."""
        token = _expired_by(24 * 3_600_000)
        valid, reason, obj = validate_token(token)

        assert not valid
        assert reason == "Token expired"
        assert obj is None

    def test_token_expired_30_days_ago_is_rejected(self):
        """A stale 30-day-old token must be rejected immediately."""
        token = _expired_by(30 * 24 * 3_600_000)
        valid, reason, obj = validate_token(token)

        assert not valid
        assert reason == "Token expired"
        assert obj is None

    # ── B: Zero-validity window ───────────────────────────────────────────────

    def test_zero_validity_window_token_is_always_expired(self):
        """
        A token issued with expires_in_ms=0 produces issued_at == expires_at.
        validate_token checks `now_ms >= expires_at`, so this is never valid.
        """
        token = issue_token(_UID, _AGENT, ConsentScope.PKM_READ, expires_in_ms=0).token
        valid, reason, obj = validate_token(token)

        assert not valid
        assert reason == "Token expired"
        assert obj is None

    # ── C: Scope-invariant expiry enforcement ─────────────────────────────────

    def test_expired_tokens_rejected_for_every_consent_scope(self):
        """
        Every ConsentScope value produces a token that is unconditionally
        rejected when expired.  No scope is special-cased to bypass expiry.
        """
        expired_24h_ms = 24 * 3_600_000
        for scope in ConsentScope:
            token = _expired_by(expired_24h_ms, scope=scope)
            valid, reason, _ = validate_token(token)

            assert not valid, (
                f"Expired {scope.value!r} token must be invalid"
            )
            assert reason == "Token expired", (
                f"Expected 'Token expired' for scope {scope.value!r}, got {reason!r}"
            )

    # ── D: Clock-skewed blocks ────────────────────────────────────────────────

    def test_clock_skewed_future_issued_at_with_past_expiry_is_rejected(self):
        """
        Simulates a clock-skewed client payload:
          issued_at  = server_now + 1 hour  (client clock 1 hour ahead)
          expires_at = server_now - 1 hour  (already elapsed on the server)

        The HMAC signature is valid (crafted with the production _sign() key),
        so this isolates the expiry check.  validate_token() must reject on
        'Token expired' because it uses the server clock for the comparison.
        """
        now_ms = int(time.time() * 1000)
        issued_at = now_ms + 3_600_000   # 1 hour ahead — simulated client skew
        expires_at = now_ms - 3_600_000  # 1 hour in the past on the server

        token = _crafted_token(issued_at, expires_at)
        valid, reason, obj = validate_token(token)

        assert not valid
        assert reason == "Token expired", (
            f"Clock-skewed payload (issued_at in future, expires_at in past) "
            f"must be rejected with 'Token expired', got {reason!r}"
        )
        assert obj is None

    def test_negative_validity_window_is_rejected(self):
        """
        A token where expires_at < issued_at (issued 1 min from now, expired
        1 min ago) — a race/clock-runaway scenario — must be rejected because
        the server's expires_at check fails regardless of issued_at.
        """
        now_ms = int(time.time() * 1000)
        issued_at = now_ms + 60_000   # 1 minute in the future
        expires_at = now_ms - 60_000  # 1 minute in the past (negative window)

        token = _crafted_token(issued_at, expires_at)
        valid, reason, obj = validate_token(token)

        assert not valid
        assert reason == "Token expired"
        assert obj is None

    def test_clock_skewed_future_issued_at_with_future_expiry_documents_design(self):
        """
        Documents intentional design: validate_token() does not check issued_at.
        A token with both issued_at AND expires_at in the future (both clocks
        ahead by the same offset) is accepted because expires_at is still valid
        on the server clock.  This test pins the current contract.
        """
        now_ms = int(time.time() * 1000)
        issued_at = now_ms + 3_600_000   # 1 hour ahead
        expires_at = now_ms + 7_200_000  # 2 hours ahead — still valid on server

        token = _crafted_token(issued_at, expires_at)
        valid, reason, obj = validate_token(token)

        # Only expires_at is enforced; issued_at is informational.
        assert valid, (
            f"Token with future expires_at must be valid on the server clock; "
            f"got reason={reason!r}"
        )
        assert obj is not None

    # ── E: No scope leakage across expiry ages ────────────────────────────────

    def test_expired_tokens_never_leak_scope_across_expiry_ages(self):
        """
        Matrix: several expiry ages × several wrong scopes.
        Every permutation must return 'Token expired', never 'Scope mismatch'.
        """
        expiry_ages_ms = [
            1,              # 1 ms ago
            1_000,          # 1 s ago
            3_600_000,      # 1 h ago
            30 * 24 * 3_600_000,  # 30 d ago
        ]
        wrong_scopes = [
            ConsentScope.PKM_WRITE,
            ConsentScope.VAULT_OWNER,
            ConsentScope.AGENT_KAI_ANALYZE,
        ]

        for age_ms in expiry_ages_ms:
            token = _expired_by(age_ms, scope=ConsentScope.PKM_READ)
            for wrong_scope in wrong_scopes:
                valid, reason, _ = validate_token(token, expected_scope=wrong_scope)

                assert not valid
                assert reason == "Token expired", (
                    f"Expired by {age_ms} ms, probing scope {wrong_scope.value!r}: "
                    f"expected 'Token expired', got {reason!r} — scope information leaked"
                )
