"""Behavioral tests for URL-building helpers in consent_request_links.py.

build_consent_request_path and build_connection_request_path are pure functions
(only urlencode + string formatting). The *_url variants compose the path
helpers with frontend_origin(), which is patched to a fixed value in these tests.

All tests are hermetic — no DB, network, or real env vars required.
"""

from __future__ import annotations

from unittest.mock import patch
from urllib.parse import parse_qs, urlparse

from hushh_mcp.services.consent_request_links import (
    build_connection_request_path,
    build_connection_request_url,
    build_consent_request_path,
    build_consent_request_url,
)

_ORIGIN = "https://app.hushh.ai"


def _parse_path(path: str) -> tuple[str, dict[str, list[str]]]:
    parsed = urlparse(path)
    return parsed.path, parse_qs(parsed.query)


# ---------------------------------------------------------------------------
# build_consent_request_path
# ---------------------------------------------------------------------------


class TestBuildConsentRequestPath:
    def test_default_tab_is_pending(self):
        path, params = _parse_path(build_consent_request_path())
        assert path == "/consents"
        assert params["tab"] == ["pending"]

    def test_request_id_included_when_provided(self):
        _, params = _parse_path(build_consent_request_path(request_id="req-123"))
        assert params["requestId"] == ["req-123"]

    def test_request_id_omitted_when_none(self):
        _, params = _parse_path(build_consent_request_path(request_id=None))
        assert "requestId" not in params

    def test_bundle_id_included_when_provided(self):
        _, params = _parse_path(build_consent_request_path(bundle_id="bundle-abc"))
        assert params["bundleId"] == ["bundle-abc"]

    def test_bundle_id_omitted_when_none(self):
        _, params = _parse_path(build_consent_request_path(bundle_id=None))
        assert "bundleId" not in params

    def test_view_overrides_tab(self):
        _, params = _parse_path(build_consent_request_path(view="approved"))
        assert params["tab"] == ["approved"]

    def test_empty_view_falls_back_to_pending(self):
        _, params = _parse_path(build_consent_request_path(view=""))
        assert params["tab"] == ["pending"]

    def test_actor_investor_included(self):
        _, params = _parse_path(build_consent_request_path(actor="investor"))
        assert params["actor"] == ["investor"]

    def test_actor_ria_included(self):
        _, params = _parse_path(build_consent_request_path(actor="ria"))
        assert params["actor"] == ["ria"]

    def test_actor_unknown_excluded(self):
        _, params = _parse_path(build_consent_request_path(actor="admin"))
        assert "actor" not in params

    def test_actor_none_excluded(self):
        _, params = _parse_path(build_consent_request_path(actor=None))
        assert "actor" not in params

    def test_manager_view_incoming_included(self):
        _, params = _parse_path(build_consent_request_path(manager_view="incoming"))
        assert params["view"] == ["incoming"]

    def test_manager_view_outgoing_included(self):
        _, params = _parse_path(build_consent_request_path(manager_view="outgoing"))
        assert params["view"] == ["outgoing"]

    def test_manager_view_unknown_excluded(self):
        _, params = _parse_path(build_consent_request_path(manager_view="all"))
        assert "view" not in params

    def test_manager_view_none_excluded(self):
        _, params = _parse_path(build_consent_request_path(manager_view=None))
        assert "view" not in params

    def test_all_params_together(self):
        path = build_consent_request_path(
            request_id="r1",
            bundle_id="b1",
            view="approved",
            actor="investor",
            manager_view="incoming",
        )
        _, params = _parse_path(path)
        assert params["requestId"] == ["r1"]
        assert params["bundleId"] == ["b1"]
        assert params["tab"] == ["approved"]
        assert params["actor"] == ["investor"]
        assert params["view"] == ["incoming"]

    def test_result_starts_with_consents_route(self):
        path = build_consent_request_path()
        assert path.startswith("/consents?")


# ---------------------------------------------------------------------------
# build_consent_request_url
# ---------------------------------------------------------------------------


class TestBuildConsentRequestUrl:
    def _build(self, **kwargs) -> str:
        with patch(
            "hushh_mcp.services.consent_request_links.frontend_origin",
            return_value=_ORIGIN,
        ):
            return build_consent_request_url(**kwargs)

    def test_url_starts_with_origin(self):
        url = self._build()
        assert url.startswith(_ORIGIN)

    def test_url_contains_consents_path(self):
        url = self._build()
        assert "/consents?" in url

    def test_url_contains_request_id(self):
        url = self._build(request_id="req-999")
        assert "requestId=req-999" in url

    def test_url_contains_actor(self):
        url = self._build(actor="ria")
        assert "actor=ria" in url


# ---------------------------------------------------------------------------
# build_connection_request_path
# ---------------------------------------------------------------------------


class TestBuildConnectionRequestPath:
    def test_default_tab_is_pending(self):
        path, params = _parse_path(build_connection_request_path())
        assert path == "/marketplace/connections"
        assert params["tab"] == ["pending"]

    def test_selected_included_when_provided(self):
        _, params = _parse_path(build_connection_request_path(selected="conn-abc"))
        assert params["selected"] == ["conn-abc"]

    def test_selected_omitted_when_none(self):
        _, params = _parse_path(build_connection_request_path(selected=None))
        assert "selected" not in params

    def test_tab_override(self):
        _, params = _parse_path(build_connection_request_path(tab="accepted"))
        assert params["tab"] == ["accepted"]

    def test_empty_tab_falls_back_to_pending(self):
        _, params = _parse_path(build_connection_request_path(tab=""))
        assert params["tab"] == ["pending"]

    def test_result_starts_with_marketplace_route(self):
        path = build_connection_request_path()
        assert path.startswith("/marketplace/connections?")


# ---------------------------------------------------------------------------
# build_connection_request_url
# ---------------------------------------------------------------------------


class TestBuildConnectionRequestUrl:
    def _build(self, **kwargs) -> str:
        with patch(
            "hushh_mcp.services.consent_request_links.frontend_origin",
            return_value=_ORIGIN,
        ):
            return build_connection_request_url(**kwargs)

    def test_url_starts_with_origin(self):
        assert self._build().startswith(_ORIGIN)

    def test_url_contains_marketplace_path(self):
        assert "/marketplace/connections?" in self._build()

    def test_url_contains_selected(self):
        url = self._build(selected="xyz")
        assert "selected=xyz" in url
