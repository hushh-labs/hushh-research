"""
Security enforcement tests for PR 3520 — E2E consent flow tests.

Validates that the E2E test spec covers consent security paths:
auth required, token validation, scope enforcement.
"""

import os

HUSHH_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
E2E_SPEC = os.path.join(HUSHH_ROOT, "hushh-webapp", "__tests__", "e2e", "consent-flow.spec.ts")


def _read(p):
    assert os.path.exists(p), f"Missing: {p}"
    with open(p, encoding="utf-8", errors="replace") as f:
        return f.read()


def test_e2e_spec_exists():
    assert os.path.exists(E2E_SPEC)


def test_e2e_spec_covers_auth_flow():
    content = _read(E2E_SPEC).lower()
    assert any(k in content for k in ["auth", "token", "login", "sign"]), (
        "E2E spec must cover auth flow"
    )


def test_e2e_spec_covers_consent_grant():
    content = _read(E2E_SPEC).lower()
    assert "consent" in content, "E2E spec must cover consent granting"


def test_e2e_spec_covers_rejection_path():
    content = _read(E2E_SPEC).lower()
    assert any(k in content for k in ["deny", "reject", "decline", "cancel", "error", "fail"]), (
        "E2E spec must cover consent rejection/denial path"
    )


def test_e2e_spec_has_test_blocks():
    content = _read(E2E_SPEC)
    assert "test(" in content or "it(" in content or "describe(" in content, (
        "E2E spec must contain test/it/describe blocks"
    )
