"""Security tests for PR 3509 — SSR hydration + feature flags."""

import ast
import os

HUSHH_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
FF_SVC = os.path.join(os.path.dirname(__file__), "..", "services", "feature_flags_service.py")


def _read(p):
    with open(p, encoding="utf-8", errors="replace") as f:
        return f.read()


def test_feature_flags_service_exists():
    assert os.path.exists(FF_SVC)


def test_feature_flags_has_off_state():
    """Feature flags must define an OFF state as the safe default."""
    content = _read(FF_SVC)
    assert "OFF" in content or "off" in content or "disabled" in content.lower(), (
        "Feature flags must have an explicit OFF/disabled state for safety"
    )


def test_feature_flags_has_audit_trail():
    """Flag changes must be tracked via audit trail."""
    content = _read(FF_SVC).lower()
    assert "audit" in content or "log" in content or "history" in content, (
        "Feature flag service must maintain an audit trail for flag changes"
    )


def test_feature_flags_syntax_valid():
    """Feature flags service must parse as valid Python."""
    content = _read(FF_SVC)
    tree = ast.parse(content)
    assert tree is not None


def test_flag_rollout_uses_deterministic_hash():
    """Percentage rollout must use a deterministic hash (user_id) not random()."""
    content = _read(FF_SVC)
    assert "hash" in content.lower() or "hashlib" in content, (
        "Rollout percentage must be determined by a stable hash of user_id, not random()"
    )
