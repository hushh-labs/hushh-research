"""
Security enforcement tests for PR 3521 — ci/security-scanning.

Validates that the security scanning script and contributing.md
contain required safety enforcement clauses, ensuring the CI
gate cannot be bypassed and contributors are informed of requirements.
"""

import os
import re

import pytest

# scripts/ and contributing.md live in the hushh-research root
HUSHH_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
SCAN_SCRIPT = os.path.join(HUSHH_ROOT, "scripts", "ops", "run-security-scan.sh")


def _read(path):
    assert os.path.exists(path), f"Required file missing: {path}"
    with open(path, encoding="utf-8", errors="replace") as f:
        return f.read()


def test_scan_script_exists():
    assert os.path.exists(SCAN_SCRIPT)


def test_scan_script_has_strict_mode():
    content = _read(SCAN_SCRIPT)
    assert "set -euo pipefail" in content


def test_scan_script_runs_bandit():
    content = _read(SCAN_SCRIPT)
    assert "bandit" in content


def test_scan_script_tracks_failures():
    content = _read(SCAN_SCRIPT)
    assert re.search(r"\bfail\b", content)


def test_scan_script_excludes_test_dirs():
    content = _read(SCAN_SCRIPT)
    assert "--exclude" in content and "tests" in content


def test_contributing_md_references_security_scanning():
    contrib_path = os.path.join(HUSHH_ROOT, "contributing.md")
    if not os.path.exists(contrib_path):
        pytest.skip("contributing.md not in repo root")
    content = _read(contrib_path).lower()
    assert any(kw in content for kw in ["security", "bandit", "scan", "vulnerability"])
