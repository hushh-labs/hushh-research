# tests/services/test_consent_request_links.py
"""
Consent Request Links Service Tests
====================================

Tests for URL and path-building helpers used by the consent notification
pipeline to construct deep-links into the frontend consent UI.

These are pure functions with no database dependency, making them ideal
for fast, deterministic unit tests.
"""

import os

import pytest

from hushh_mcp.services.consent_request_links import (
    build_connection_request_path,
    build_connection_request_url,
    build_consent_request_path,
    build_consent_request_url,
    frontend_origin,
)


# ============================================================================
# frontend_origin
# ============================================================================


class TestFrontendOrigin:
    """Tests for the frontend_origin() helper."""

    def test_returns_env_value_when_set(self, monkeypatch):
        monkeypatch.setenv("FRONTEND_URL", "https://kai.hushh.ai")
        assert frontend_origin() == "https://kai.hushh.ai"

    def test_strips_trailing_slash(self, monkeypatch):
        monkeypatch.setenv("FRONTEND_URL", "https://kai.hushh.ai/")
        assert frontend_origin() == "https://kai.hushh.ai"

    def test_strips_multiple_trailing_slashes(self, monkeypatch):
        monkeypatch.setenv("FRONTEND_URL", "https://kai.hushh.ai///")
        assert frontend_origin() == "https://kai.hushh.ai"

    def test_defaults_to_localhost_when_unset(self, monkeypatch):
        monkeypatch.delenv("FRONTEND_URL", raising=False)
        assert frontend_origin() == "http://localhost:3000"

    def test_defaults_to_localhost_when_empty(self, monkeypatch):
        monkeypatch.setenv("FRONTEND_URL", "")
        assert frontend_origin() == "http://localhost:3000"

    def test_strips_whitespace(self, monkeypatch):
        monkeypatch.setenv("FRONTEND_URL", "  https://kai.hushh.ai  ")
        assert frontend_origin() == "https://kai.hushh.ai"


# ============================================================================
# build_consent_request_path
# ============================================================================


class TestBuildConsentRequestPath:
    """Tests for building consent request deep-link paths."""

    def test_default_path_with_no_ids(self):
        path = build_consent_request_path()
        assert path.startswith("/profile?")
        assert "tab=privacy" in path
        assert "sheet=consents" in path
        assert "consentView=pending" in path

    def test_includes_request_id_when_provided(self):
        path = build_consent_request_path(request_id="req_abc123")
        assert "requestId=req_abc123" in path

    def test_includes_bundle_id_when_provided(self):
        path = build_consent_request_path(bundle_id="bundle_xyz")
        assert "bundleId=bundle_xyz" in path

    def test_includes_both_ids(self):
        path = build_consent_request_path(
            request_id="req_001", bundle_id="bundle_002"
        )
        assert "requestId=req_001" in path
        assert "bundleId=bundle_002" in path

    def test_custom_view_parameter(self):
        path = build_consent_request_path(view="active")
        assert "consentView=active" in path

    def test_empty_view_defaults_to_pending(self):
        path = build_consent_request_path(view="")
        assert "consentView=pending" in path

    def test_omits_request_id_when_none(self):
        path = build_consent_request_path(request_id=None)
        assert "requestId" not in path

    def test_omits_bundle_id_when_none(self):
        path = build_consent_request_path(bundle_id=None)
        assert "bundleId" not in path


# ============================================================================
# build_consent_request_url
# ============================================================================


class TestBuildConsentRequestUrl:
    """Tests for building full consent request URLs."""

    def test_combines_origin_and_path(self, monkeypatch):
        monkeypatch.setenv("FRONTEND_URL", "https://kai.hushh.ai")
        url = build_consent_request_url(request_id="req_001")
        assert url.startswith("https://kai.hushh.ai/profile?")
        assert "requestId=req_001" in url

    def test_uses_localhost_by_default(self, monkeypatch):
        monkeypatch.delenv("FRONTEND_URL", raising=False)
        url = build_consent_request_url()
        assert url.startswith("http://localhost:3000/profile?")


# ============================================================================
# build_connection_request_path
# ============================================================================


class TestBuildConnectionRequestPath:
    """Tests for building connection request deep-link paths."""

    def test_default_path(self):
        path = build_connection_request_path()
        assert path.startswith("/marketplace/connections?")
        assert "tab=pending" in path

    def test_includes_selected_param(self):
        path = build_connection_request_path(selected="conn_abc")
        assert "selected=conn_abc" in path

    def test_custom_tab(self):
        path = build_connection_request_path(tab="active")
        assert "tab=active" in path

    def test_empty_tab_defaults_to_pending(self):
        path = build_connection_request_path(tab="")
        assert "tab=pending" in path

    def test_omits_selected_when_none(self):
        path = build_connection_request_path(selected=None)
        assert "selected" not in path


# ============================================================================
# build_connection_request_url
# ============================================================================


class TestBuildConnectionRequestUrl:
    """Tests for building full connection request URLs."""

    def test_combines_origin_and_path(self, monkeypatch):
        monkeypatch.setenv("FRONTEND_URL", "https://kai.hushh.ai")
        url = build_connection_request_url(selected="conn_001", tab="active")
        assert url.startswith("https://kai.hushh.ai/marketplace/connections?")
        assert "selected=conn_001" in url
        assert "tab=active" in url
