"""Pinned-runtime guard tests for One's ADK construction contract."""

from __future__ import annotations

import pytest

from hushh_mcp import runtime_readiness


def test_runtime_dependency_evidence_is_metadata_only(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(runtime_readiness, "google_adk_version", lambda: "2.4.0")
    assert runtime_readiness.runtime_dependency_evidence() == {
        "google_adk_expected": "2.4.0",
        "google_adk_installed": "2.4.0",
        "google_adk_compatible": True,
    }


def test_pinned_adk_guard_rejects_an_older_interpreter(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(runtime_readiness, "google_adk_version", lambda: "1.23.0")
    with pytest.raises(RuntimeError, match=r"requires google-adk 2\.4\.0"):
        runtime_readiness.assert_pinned_google_adk()
