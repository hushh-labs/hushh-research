"""Security enforcement tests for PR 3501 — chaos engineering test suite."""

import ast
import os

CHAOS_TEST = os.path.join(os.path.dirname(__file__), "chaos", "test_resilience.py")


def _r(p):
    with open(p, encoding="utf-8", errors="replace") as f:
        return f.read()


def test_resilience_file_exists():
    assert os.path.exists(CHAOS_TEST)


def test_resilience_file_valid_python():
    assert ast.parse(_r(CHAOS_TEST)) is not None


def test_chaos_covers_timeout():
    assert "timeout" in _r(CHAOS_TEST).lower() or "Timeout" in _r(CHAOS_TEST), (
        "Chaos suite must test timeout handling"
    )


def test_chaos_covers_retry():
    assert "retry" in _r(CHAOS_TEST).lower(), "Chaos suite must test retry logic"


def test_chaos_covers_auth_failure():
    """Chaos suite must test behavior when auth/vault fails."""
    content = _r(CHAOS_TEST).lower()
    assert any(k in content for k in ["auth", "vault", "permission", "token", "credential"]), (
        "Chaos suite must cover auth/vault failure scenarios"
    )


def test_chaos_uses_mocks():
    """Chaos tests must use mocks to simulate failures safely."""
    assert "Mock" in _r(CHAOS_TEST) or "patch" in _r(CHAOS_TEST), (
        "Chaos tests must use unittest.mock to safely simulate failures"
    )
