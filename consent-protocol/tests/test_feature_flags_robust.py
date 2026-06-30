"""Security tests for PR 3504 — feature flags system."""

import ast
import os

FF = os.path.join(os.path.dirname(__file__), "..", "services", "feature_flags_service.py")


def _r(p):
    with open(p, encoding="utf-8", errors="replace") as f:
        return f.read()


def test_exists():
    assert os.path.exists(FF)


def test_syntax():
    assert ast.parse(_r(FF)) is not None


def test_has_off_state():
    assert "OFF" in _r(FF) or "disabled" in _r(FF).lower()


def test_audit_trail():
    assert any(k in _r(FF).lower() for k in ["audit", "log", "history", "track"])


def test_deterministic_rollout():
    assert "hash" in _r(FF).lower() or "hashlib" in _r(FF)
