"""
Consent request link helper tests.
"""

from hushh_mcp.services.consent_request_links import (
    FRONTEND_ORIGIN_ENV_KEY,
    LOCALHOST_FRONTEND_ORIGIN,
    build_connection_request_path,
    build_connection_request_url,
    build_consent_request_path,
    build_consent_request_url,
    frontend_origin,
)


class TestFrontendOrigin:
    def test_returns_env_value_when_set(self, monkeypatch):
        monkeypatch.setenv(FRONTEND_ORIGIN_ENV_KEY, "https://kai.hushh.ai")
        assert frontend_origin() == "https://kai.hushh.ai"

    def test_strips_trailing_slash(self, monkeypatch):
        monkeypatch.setenv(FRONTEND_ORIGIN_ENV_KEY, "https://kai.hushh.ai/")
        assert frontend_origin() == "https://kai.hushh.ai"

    def test_strips_multiple_trailing_slashes(self, monkeypatch):
        monkeypatch.setenv(FRONTEND_ORIGIN_ENV_KEY, "https://kai.hushh.ai///")
        assert frontend_origin() == "https://kai.hushh.ai"

    def test_defaults_to_localhost_when_unset(self, monkeypatch):
        monkeypatch.delenv(FRONTEND_ORIGIN_ENV_KEY, raising=False)
        assert frontend_origin() == LOCALHOST_FRONTEND_ORIGIN

    def test_defaults_to_localhost_when_empty(self, monkeypatch):
        monkeypatch.setenv(FRONTEND_ORIGIN_ENV_KEY, "")
        assert frontend_origin() == LOCALHOST_FRONTEND_ORIGIN

    def test_strips_whitespace(self, monkeypatch):
        monkeypatch.setenv(FRONTEND_ORIGIN_ENV_KEY, "  https://kai.hushh.ai  ")
        assert frontend_origin() == "https://kai.hushh.ai"


class TestBuildConsentRequestPath:
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
        path = build_consent_request_path(request_id="req_001", bundle_id="bundle_002")
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


class TestBuildConsentRequestUrl:
    def test_combines_origin_and_path(self, monkeypatch):
        monkeypatch.setenv(FRONTEND_ORIGIN_ENV_KEY, "https://kai.hushh.ai")
        url = build_consent_request_url(request_id="req_001")
        assert url.startswith("https://kai.hushh.ai/profile?")
        assert "requestId=req_001" in url

    def test_uses_localhost_by_default(self, monkeypatch):
        monkeypatch.delenv(FRONTEND_ORIGIN_ENV_KEY, raising=False)
        url = build_consent_request_url()
        assert url.startswith(f"{LOCALHOST_FRONTEND_ORIGIN}/profile?")


class TestBuildConnectionRequestPath:
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


class TestBuildConnectionRequestUrl:
    def test_combines_origin_and_path(self, monkeypatch):
        monkeypatch.setenv(FRONTEND_ORIGIN_ENV_KEY, "https://kai.hushh.ai")
        url = build_connection_request_url(selected="conn_001", tab="active")
        assert url.startswith("https://kai.hushh.ai/marketplace/connections?")
        assert "selected=conn_001" in url
        assert "tab=active" in url
